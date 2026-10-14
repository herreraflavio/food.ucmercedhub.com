"""Regression coverage for downloaded photos and the preparation/enrichment handoff."""

import base64
import csv
import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import requests

from scripts.download_photos import download_photo, localize_photos, photo_file_stem
from scripts.enrich_data import enrich_geocoded
from scripts.prepare_data import prepare_source

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
)


class PhotoHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/photo":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.end_headers()
            self.wfile.write(PNG)
        elif self.path == "/html":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"<html>not a photo</html>")
        else:
            self.send_error(404)

    def log_message(self, *args):
        pass


class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), PhotoHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.input = self.root / "intermediate" / "remote.json"
        self.output = self.root / "website" / "data" / "restaurant_data.json"
        self.photos = self.root / "website" / "assets" / "images" / "restaurants"
        self.manifest = self.root / "intermediate" / "photos.json"

    def tearDown(self):
        self.temporary.cleanup()

    def data(self, uri):
        return {"type": "RestaurantInspectionGoogleJoin", "features": [{
            "type": "Feature",
            "geometry": {"longitude": -120.4, "latitude": 37.3, "spatialReference": {"wkid": 4326}},
            "attributes": {
                "google_place_id": "place-1", "google_name": "../A: Restaurant?",
                "google_photo_name": "places/place-1/photos/photo-1",
                "google_photo_uri": uri, "google_rating": 4.3, "quality_score": 2,
                "google_photo_author_attributions": [{"displayName": "Photographer"}],
            },
        }]}

    def localize(self, data, **kwargs):
        with redirect_stdout(io.StringIO()):
            return localize_photos(data, self.input, self.output, self.photos, self.manifest, **kwargs)

    def test_download_writes_usable_relative_path_and_preserves_data(self):
        data = self.data(self.url + "/photo")
        output = self.localize(data)
        attrs = output["features"][0]["attributes"]
        self.assertEqual((self.output.parent / attrs["google_photo_uri"]).read_bytes(), PNG)
        self.assertNotIn("\\", attrs["google_photo_uri"])
        self.assertEqual(output["features"][0]["geometry"], data["features"][0]["geometry"])
        self.assertEqual(attrs["google_rating"], 4.3)
        self.assertEqual(attrs["google_photo_author_attributions"], data["features"][0]["attributes"]["google_photo_author_attributions"])
        self.assertTrue(data["features"][0]["attributes"]["google_photo_uri"].startswith("http"))
        self.assertEqual(json.loads(self.manifest.read_text())["local_photo_count"], 1)
        self.assertFalse(list(self.photos.glob("*.part")))

    def test_repeat_download_reuses_valid_file_without_request(self):
        data = self.data(self.url + "/photo")
        self.localize(data)
        with patch("scripts.download_photos.requests.get") as get:
            self.localize(data)
        get.assert_not_called()

    def test_invalid_existing_file_is_downloaded_again(self):
        attrs = self.data(self.url + "/photo")["features"][0]["attributes"]
        self.photos.mkdir(parents=True)
        invalid = self.photos / (photo_file_stem(attrs, attrs["google_photo_uri"]) + ".png")
        invalid.write_text("not an image")
        self.assertEqual(download_photo(attrs["google_photo_uri"], self.photos, attrs).read_bytes(), PNG)

    def test_http_failure_keeps_restaurant_and_records_error(self):
        output = self.localize(self.data(self.url + "/missing"))
        attrs = output["features"][0]["attributes"]
        self.assertEqual(attrs["google_photo_uri"], "")
        self.assertEqual(attrs["google_rating"], 4.3)
        self.assertIn("404", attrs["google_photo_error"])
        self.assertEqual(output["metadata"]["photo_download_error_count"], 1)

    def test_html_response_is_not_saved_as_an_image(self):
        output = self.localize(self.data(self.url + "/html"))
        self.assertEqual(output["metadata"]["local_photo_count"], 0)
        self.assertEqual(list(self.photos.iterdir()), [])

    def test_missing_photo_uses_existing_placeholder(self):
        output = self.localize(self.data(""))
        self.assertEqual(output["metadata"]["photo_download_error_count"], 0)
        self.assertEqual(json.loads(self.manifest.read_text())["photos"][0]["status"], "NO_PHOTO")

    def test_geojson_properties_and_geometry_are_preserved(self):
        feature = self.data(self.url + "/photo")["features"][0]
        feature["properties"] = feature.pop("attributes")
        feature["geometry"] = {"type": "Point", "coordinates": [-120.4, 37.3]}
        output = self.localize({"type": "FeatureCollection", "features": [feature]})
        self.assertEqual(output["type"], "FeatureCollection")
        self.assertEqual(output["features"][0]["geometry"], feature["geometry"])
        self.assertIn("../assets/", output["features"][0]["properties"]["google_photo_uri"])

    def test_array_records_and_local_path_rebasing(self):
        attrs = self.data(self.url + "/photo")["features"][0]["attributes"]
        output = self.localize([attrs])
        local = self.output.parent / output[0]["google_photo_uri"]
        self.input = self.output
        self.output = self.root / "another" / "result.json"
        with patch("scripts.download_photos.requests.get") as get:
            rebased = self.localize(output)
        get.assert_not_called()
        self.assertEqual((self.output.parent / rebased[0]["google_photo_uri"]).resolve(), local.resolve())

    def test_refresh_replaces_only_photo_fields_and_attributions(self):
        refreshed = {
            "google_photo_uri": self.url + "/photo", "google_photo_name": "fresh-photo",
            "google_photo_author_attributions": [{"displayName": "New photographer"}],
        }
        with patch("scripts.download_photos.refresh_google_photo", return_value=refreshed) as refresh:
            output = self.localize(self.data(self.url + "/missing"), refresh_api_key="test-key")
        refresh.assert_called_once()
        attrs = output["features"][0]["attributes"]
        self.assertEqual(attrs["google_photo_name"], "fresh-photo")
        self.assertEqual(attrs["google_photo_author_attributions"], refreshed["google_photo_author_attributions"])
        self.assertEqual(attrs["google_rating"], 4.3)

    def test_refreshed_photo_and_author_are_reused_when_retrying_original_input(self):
        original = self.data(self.url + "/missing")
        refreshed = {
            "google_photo_uri": self.url + "/photo", "google_photo_name": "fresh-photo",
            "google_photo_author_attributions": [{"displayName": "New photographer"}],
        }
        with patch("scripts.download_photos.refresh_google_photo", return_value=refreshed):
            self.localize(original, refresh_api_key="test-key")
        with patch("scripts.download_photos.requests.get") as get:
            output = self.localize(original)
        get.assert_not_called()
        self.assertEqual(output["features"][0]["attributes"]["google_photo_author_attributions"], refreshed["google_photo_author_attributions"])

    def test_rows_sharing_a_place_and_source_uri_keep_their_own_refreshed_photo(self):
        data = self.data(self.url + "/missing")
        data["features"][0]["attributes"]["source_row_number"] = 1
        second = json.loads(json.dumps(data["features"][0]))
        second["attributes"]["source_row_number"] = 2
        data["features"].append(second)
        fresh = [
            {"google_photo_uri": self.url + "/photo", "google_photo_name": f"fresh-{row}",
             "google_photo_author_attributions": [{"displayName": f"Author {row}"}]}
            for row in (1, 2)
        ]
        with patch("scripts.download_photos.refresh_google_photo", side_effect=fresh):
            first_output = self.localize(data, refresh_api_key="test-key")
        with patch("scripts.download_photos.requests.get") as get:
            reused = self.localize(data)
        get.assert_not_called()
        self.assertEqual(reused["features"], first_output["features"])

    def test_prepare_preserves_source_fields_and_filters_city(self):
        source = self.root / "raw.csv"
        source.write_text("Detail,Facility,Current Rating,City,Address\nx,A,Good, merCED ,One St\ny,B,Satisfactory,Atwater,Two St\n", encoding="utf-8")
        destination = self.root / "prepared" / "result.csv"
        with redirect_stdout(io.StringIO()):
            prepare_source(source, destination)
        with destination.open(newline="") as infile:
            rows = list(csv.DictReader(infile))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], {"Facility": "A", "Current Rating": "Good", "City": " merCED ", "Address": "One St"})
        self.assertTrue(source.read_text().startswith("Detail,"))

    def enrich(self, fetch_photos=True):
        source = self.root / "geocoded.csv"
        source.write_text("USER_Facility,USER_Current_Rating,Match_addr,DisplayX,DisplayY\nA,Good,One St,-120.4,37.3\n", encoding="utf-8")
        place = {"id": "p1", "displayName": {"text": "A"}, "location": {"longitude": -120.4, "latitude": 37.3},
                 "rating": 4.5, "priceLevel": "PRICE_LEVEL_MODERATE", "photos": [{"name": "photo-1", "authorAttributions": [{"displayName": "Author"}]}]}
        with patch.dict(os.environ, {"GOOGLE_MAPS_API_KEY": "test-key"}), \
             patch("scripts.enrich_data.google_text_search", return_value=place), \
             patch("scripts.enrich_data.google_photo_media", return_value={"google_photo_uri": self.url + "/photo"}) as media, \
             redirect_stdout(io.StringIO()):
            enrich_geocoded(source, self.output, None, 0, fetch_photos, 500, self.photos, self.input, self.manifest)
        return json.loads(self.output.read_text()), json.loads(self.input.read_text()), media

    def test_enrich_retains_remote_intermediate_and_writes_local_final(self):
        output, intermediate, media = self.enrich()
        media.assert_called_once()
        self.assertEqual(intermediate["features"][0]["attributes"]["google_photo_uri"], self.url + "/photo")
        attrs = output["features"][0]["attributes"]
        self.assertTrue((self.output.parent / attrs["google_photo_uri"]).is_file())
        self.assertEqual((attrs["quality_score"], attrs["google_price_label"], attrs["google_distance_meters"]), (2, "$$", 0))

    def test_no_photos_skips_media_and_downloads(self):
        with patch("scripts.download_photos.requests.get") as get:
            output, _, media = self.enrich(fetch_photos=False)
        media.assert_not_called()
        get.assert_not_called()
        self.assertEqual(output["features"][0]["attributes"]["google_photo_uri"], "")
        self.assertFalse(output["metadata"]["photos_requested"])

    def test_failed_photo_media_keeps_google_match_and_redacts_key(self):
        source = self.root / "geocoded.csv"
        source.write_text("Facility,Current Rating,Match_addr,X,Y\nA,Good,One St,-120.4,37.3\n")
        with patch.dict(os.environ, {"GOOGLE_MAPS_API_KEY": "secret-test-key"}), \
             patch("scripts.enrich_data.google_text_search", return_value={"id": "p1", "photos": [{"name": "photo"}]}), \
             patch("scripts.enrich_data.google_photo_media", side_effect=requests.RequestException("failed?key=secret-test-key")), \
             redirect_stdout(io.StringIO()):
            enrich_geocoded(source, self.output, None, 0, True, 500, self.photos, self.input, self.manifest)
        attrs = json.loads(self.output.read_text())["features"][0]["attributes"]
        self.assertEqual(attrs["google_status"], "OK")
        self.assertNotIn("secret-test-key", attrs["google_photo_error"])
        self.assertEqual(json.loads(self.manifest.read_text())["photo_download_error_count"], 1)


if __name__ == "__main__":
    unittest.main()
