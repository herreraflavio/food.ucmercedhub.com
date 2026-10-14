#!/usr/bin/env python3
"""Stage 4: enrich ArcGIS geocoded inspections and download photos for the map."""

from __future__ import annotations

import argparse
import csv
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv

if __package__:
    from .paths import (
        PROJECT_ROOT, DEFAULT_GEOCODED_CSV, DEFAULT_OUTPUT_JSON,
        DEFAULT_PHOTOS_DIR, ENRICHED_DIR,
    )
    from .download_photos import localize_photos, write_json
else:
    from paths import (
        PROJECT_ROOT, DEFAULT_GEOCODED_CSV, DEFAULT_OUTPUT_JSON,
        DEFAULT_PHOTOS_DIR, ENRICHED_DIR,
    )
    from download_photos import localize_photos, write_json


TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
LOCATION_BIAS_RADIUS_METERS = 500.0
REQUEST_TIMEOUT_SECONDS = 20

PHOTO_MAX_WIDTH_PX = 640
PHOTO_MAX_HEIGHT_PX = 400

FIELD_MASK = ",".join(
    [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.rating",
        "places.userRatingCount",
        "places.priceRange",
        "places.priceLevel",
        "places.googleMapsUri",
        "places.photos",
    ]
)

QUALITY_SCORE = {
    "unsatisfactory": 0,
    "satisfactory": 1,
    "good": 2,
}


def normalize_header(value: str) -> str:
    return (
        value.strip()
        .lower()
        .replace("_", "")
        .replace(" ", "")
        .replace("-", "")
    )


def make_column_lookup(fieldnames: list[str]) -> dict[str, str]:
    return {normalize_header(name): name for name in fieldnames}


def get_value(
    row: dict[str, str], col_lookup: dict[str, str], *possible_names: str
) -> str:
    for name in possible_names:
        original = col_lookup.get(normalize_header(name))
        if original is not None:
            return (row.get(original) or "").strip()
    return ""


def parse_float(value: Any) -> float | None:
    if value is None:
        return None

    cleaned = str(value).strip().replace(",", "")
    if not cleaned:
        return None

    try:
        return float(cleaned)
    except (TypeError, ValueError):
        return None


def is_probably_lon_lat(lon: float | None, lat: float | None) -> bool:
    return (
        lon is not None
        and lat is not None
        and -180 <= lon <= 180
        and -90 <= lat <= 90
    )


def preferred_lon_lat(source: dict[str, Any]) -> tuple[float | None, float | None]:
    """Prefer ArcGIS DisplayX/DisplayY; fall back to X/Y."""
    display_lon = parse_float(source.get("DisplayX"))
    display_lat = parse_float(source.get("DisplayY"))
    if is_probably_lon_lat(display_lon, display_lat):
        return display_lon, display_lat

    x_lon = parse_float(source.get("X"))
    y_lat = parse_float(source.get("Y"))
    if is_probably_lon_lat(x_lon, y_lat):
        return x_lon, y_lat

    return None, None


def rating_to_score(rating: str) -> int | None:
    """0=Unsatisfactory, 1=Satisfactory, 2=Good; unknown values stay null."""
    return QUALITY_SCORE.get(str(rating).strip().casefold())


def quality_label_from_score(score: int | None) -> str:
    labels = {
        0: "Unsatisfactory",
        1: "Satisfactory",
        2: "Good",
    }
    return labels.get(score, "")


def money_to_float(money: dict[str, Any] | None) -> float | None:
    if not money:
        return None

    units = float(money.get("units", 0) or 0)
    nanos = float(money.get("nanos", 0) or 0) / 1_000_000_000
    return units + nanos


def price_bucket_from_range(start: float, end: float | None) -> str:
    if end is None:
        if start >= 30:
            return "$30+"
        if start >= 20:
            return "$20-$30+"
        if start >= 10:
            return "$10-$20+"
        return "$0-$10+"

    if end <= 10:
        return "$0-$10"
    if start < 20 and end <= 20:
        return "$10-$20" if start >= 10 else "$0-$20"
    if start < 30 and end <= 30:
        return "$20-$30" if start >= 20 else "$10-$30"
    return "$30+"


def format_price_range(place: dict[str, Any]) -> tuple[str, str, float | None, float | None]:
    """Prefer Google's numeric priceRange, then fall back to priceLevel."""
    price_range = place.get("priceRange") or {}
    start_price = money_to_float(price_range.get("startPrice"))
    end_price = money_to_float(price_range.get("endPrice"))

    if start_price is not None and end_price is not None:
        return (
            f"${start_price:.0f}-${end_price:.0f}",
            price_bucket_from_range(start_price, end_price),
            start_price,
            end_price,
        )

    if start_price is not None:
        return (
            f"${start_price:.0f}+",
            price_bucket_from_range(start_price, None),
            start_price,
            None,
        )

    price_level = place.get("priceLevel", "")
    labels = {
        "PRICE_LEVEL_FREE": "Free",
        "PRICE_LEVEL_INEXPENSIVE": "$",
        "PRICE_LEVEL_MODERATE": "$$",
        "PRICE_LEVEL_EXPENSIVE": "$$$",
        "PRICE_LEVEL_VERY_EXPENSIVE": "$$$$",
    }
    fallback = labels.get(price_level, "Price unavailable")
    return fallback, fallback, None, None


def build_search_query(
    facility: str,
    match_addr: str,
    postal: str,
    city: str = "",
    region: str = "",
) -> str:
    return " ".join(
        part for part in [facility, match_addr, city, region, postal] if part
    ).strip()


def haversine_meters(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    radius_m = 6_371_000
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lon2 - lon1)

    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius_m * c


def google_text_search(
    api_key: str,
    query: str,
    lon: float | None,
    lat: float | None,
    location_bias_radius: float,
) -> dict[str, Any]:
    headers = {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": api_key,
        "X-Goog-FieldMask": FIELD_MASK,
    }

    body: dict[str, Any] = {
        "textQuery": query,
        "maxResultCount": 1,
        "languageCode": "en",
        "regionCode": "US",
    }

    if is_probably_lon_lat(lon, lat):
        body["locationBias"] = {
            "circle": {
                "center": {"latitude": lat, "longitude": lon},
                "radius": location_bias_radius,
            }
        }

    response = requests.post(
        TEXT_SEARCH_URL,
        headers=headers,
        json=body,
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()

    places = response.json().get("places", [])
    return places[0] if places else {}


def primary_photo_fields(place: dict[str, Any]) -> dict[str, Any]:
    photos = place.get("photos") or []
    if not photos:
        return {
            "google_photo_name": "",
            "google_photo_width_px": None,
            "google_photo_height_px": None,
            "google_photo_author_attributions": [],
        }

    first = photos[0] or {}
    return {
        "google_photo_name": first.get("name", ""),
        "google_photo_width_px": first.get("widthPx"),
        "google_photo_height_px": first.get("heightPx"),
        "google_photo_author_attributions": first.get("authorAttributions") or [],
    }


def google_photo_media(api_key: str, photo_name: str) -> dict[str, Any]:
    if not photo_name:
        return {"google_photo_media_name": "", "google_photo_uri": ""}

    url = f"https://places.googleapis.com/v1/{photo_name}/media"
    params = {
        "key": api_key,
        "maxWidthPx": PHOTO_MAX_WIDTH_PX,
        "maxHeightPx": PHOTO_MAX_HEIGHT_PX,
        "skipHttpRedirect": "true",
    }

    response = requests.get(url, params=params, timeout=REQUEST_TIMEOUT_SECONDS)
    response.raise_for_status()
    data = response.json()

    return {
        "google_photo_media_name": data.get("name", ""),
        "google_photo_uri": data.get("photoUri", ""),
    }


def selected_source_fields(
    row: dict[str, str], col_lookup: dict[str, str]
) -> dict[str, Any]:
    """Extract fields used by the map JSON from ArcGIS geocoder output."""
    current_rating = get_value(
        row,
        col_lookup,
        "USER_current_rating",
        "USER_Current_Rating",
        "USER_current rating",
        "current_rating",
        "Current Rating",
    )
    score = rating_to_score(current_rating)

    return {
        "Match_addr": get_value(row, col_lookup, "Match_addr", "match_addr"),
        "Postal": get_value(row, col_lookup, "Postal", "postal"),
        "X": get_value(row, col_lookup, "X", "x"),
        "Y": get_value(row, col_lookup, "Y", "y"),
        "DisplayX": get_value(row, col_lookup, "DisplayX", "display_x", "display x"),
        "DisplayY": get_value(row, col_lookup, "DisplayY", "display_y", "display y"),
        "USER_facility": get_value(
            row,
            col_lookup,
            "USER_facility",
            "USER_Facility",
            "facility",
            "Facility",
        ),
        "USER_current_rating": current_rating,
        "USER_last_inspection_date": get_value(
            row,
            col_lookup,
            "USER_last_inspection_date",
            "USER_Last_Inspection_Date",
            "USER_last inspection date",
            "last_inspection_date",
            "Last Inspection Date",
        ),
        "USER_city": get_value(
            row,
            col_lookup,
            "USER_city",
            "USER_City",
            "City",
            "city",
        ),
        "USER_address": get_value(
            row,
            col_lookup,
            "USER_address",
            "USER_Address",
            "Address",
            "address",
        ),
        "quality_score": score,
        "quality_label": quality_label_from_score(score),
    }


def build_feature(
    source: dict[str, Any], google_fields: dict[str, Any], source_row_number: int
) -> dict[str, Any]:
    map_lon, map_lat = preferred_lon_lat(source)

    geometry = None
    if is_probably_lon_lat(map_lon, map_lat):
        geometry = {
            "longitude": map_lon,
            "latitude": map_lat,
            "spatialReference": {"wkid": 4326},
        }

    return {
        "type": "Feature",
        "geometry": geometry,
        "attributes": {
            "source_row_number": source_row_number,
            **source,
            **google_fields,
        },
    }


# ---------------------------------------------------------------------------
# Stage 4: score inspections + enrich with Google Places + download photos
# ---------------------------------------------------------------------------


def enrich_geocoded(
    input_csv: Path,
    output_json: Path,
    max_rows: int | None,
    request_delay: float,
    fetch_photos: bool,
    location_bias_radius: float,
    photos_dir: Path = DEFAULT_PHOTOS_DIR,
    intermediate_json: Path | None = None,
    photo_manifest: Path | None = None,
) -> None:
    if not input_csv.exists():
        raise FileNotFoundError(f"Geocoded CSV not found: {input_csv}")

    load_dotenv(PROJECT_ROOT / ".env")
    api_key = os.getenv("GOOGLE_MAPS_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Missing GOOGLE_MAPS_API_KEY. Create a .env file containing:\n"
            "GOOGLE_MAPS_API_KEY=your_key_here"
        )

    features: list[dict[str, Any]] = []
    source_row_count = 0

    with input_csv.open("r", encoding="utf-8-sig", newline="") as infile:
        reader = csv.DictReader(infile)
        if not reader.fieldnames:
            raise RuntimeError("Input CSV has no headers.")

        col_lookup = make_column_lookup(reader.fieldnames)

        for index, row in enumerate(reader, start=1):
            if max_rows is not None and index > max_rows:
                break

            source_row_count += 1
            source = selected_source_fields(row, col_lookup)
            lon, lat = preferred_lon_lat(source)

            city = get_value(row, col_lookup, "City", "USER_city", "USER_City", "city")
            region = get_value(
                row,
                col_lookup,
                "RegionAbbr",
                "Region",
                "USER_state",
                "state",
            )

            search_query = build_search_query(
                facility=source["USER_facility"],
                match_addr=source["Match_addr"],
                postal=source["Postal"],
                city=city,
                region=region,
            )

            print(f"[{index}] Searching: {search_query or '[no query]'}")

            google_fields: dict[str, Any] = {
                "google_status": "",
                "google_place_id": "",
                "google_name": "",
                "google_address": "",
                "google_lat": None,
                "google_lng": None,
                "google_distance_meters": None,
                "google_rating": None,
                "google_review_count": None,
                "google_price_label": "",
                "google_price_bucket": "",
                "google_price_level": "",
                "google_price_range_start": None,
                "google_price_range_end": None,
                "google_maps_uri": "",
                "google_photo_name": "",
                "google_photo_width_px": None,
                "google_photo_height_px": None,
                "google_photo_author_attributions": [],
                "google_photo_media_name": "",
                "google_photo_uri": "",
                "google_photo_error": "",
                "google_search_query": search_query,
                "google_error": "",
            }

            if not search_query:
                google_fields["google_status"] = "SKIPPED"
                google_fields["google_error"] = (
                    "No facility/address data available for search."
                )
                features.append(build_feature(source, google_fields, index))
                continue

            try:
                place = google_text_search(
                    api_key=api_key,
                    query=search_query,
                    lon=lon,
                    lat=lat,
                    location_bias_radius=location_bias_radius,
                )

                if not place:
                    google_fields["google_status"] = "NOT_FOUND"
                    google_fields["google_error"] = "No Google Places match returned."
                else:
                    price_label, price_bucket, price_start, price_end = (
                        format_price_range(place)
                    )
                    location = place.get("location") or {}
                    photo_fields = primary_photo_fields(place)

                    if fetch_photos and photo_fields["google_photo_name"]:
                        try:
                            photo_fields.update(
                                google_photo_media(
                                    api_key, photo_fields["google_photo_name"]
                                )
                            )
                        except Exception as photo_exc:  # keep place data even if photo fails
                            photo_fields["google_photo_media_name"] = ""
                            photo_fields["google_photo_uri"] = ""
                            photo_fields["google_photo_error"] = str(photo_exc).replace(
                                api_key, "[redacted]"
                            )

                    google_lat = parse_float(location.get("latitude"))
                    google_lng = parse_float(location.get("longitude"))

                    distance_meters = None
                    if is_probably_lon_lat(lon, lat) and is_probably_lon_lat(
                        google_lng, google_lat
                    ):
                        distance_meters = round(
                            haversine_meters(lon, lat, google_lng, google_lat), 1
                        )

                    google_fields.update(
                        {
                            "google_status": "OK",
                            "google_place_id": place.get("id", ""),
                            "google_name": (place.get("displayName") or {}).get(
                                "text", ""
                            ),
                            "google_address": place.get("formattedAddress", ""),
                            "google_lat": google_lat,
                            "google_lng": google_lng,
                            "google_distance_meters": distance_meters,
                            "google_rating": place.get("rating"),
                            "google_review_count": place.get("userRatingCount"),
                            "google_price_label": price_label,
                            "google_price_bucket": price_bucket,
                            "google_price_level": place.get("priceLevel", ""),
                            "google_price_range_start": price_start,
                            "google_price_range_end": price_end,
                            "google_maps_uri": place.get("googleMapsUri", ""),
                            **photo_fields,
                            "google_error": "",
                        }
                    )

            except requests.HTTPError as exc:
                status_code = ""
                response_text = ""
                if exc.response is not None:
                    status_code = str(exc.response.status_code)
                    response_text = exc.response.text
                google_fields["google_status"] = "ERROR"
                google_fields["google_error"] = f"HTTP {status_code}: {response_text}".replace(
                    api_key, "[redacted]"
                )

            except Exception as exc:
                google_fields["google_status"] = "ERROR"
                google_fields["google_error"] = str(exc).replace(api_key, "[redacted]")

            features.append(build_feature(source, google_fields, index))
            if request_delay > 0:
                time.sleep(request_delay)

    mapped_count = sum(1 for feature in features if feature.get("geometry"))
    google_ok_count = sum(
        1
        for feature in features
        if feature["attributes"].get("google_status") == "OK"
    )

    output_data = {
        "type": "RestaurantInspectionGoogleJoin",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source_file": str(input_csv),
        "output_file": str(output_json),
        "metadata": {
            "source_row_count": source_row_count,
            "feature_count": len(features),
            "mapped_feature_count": mapped_count,
            "google_ok_count": google_ok_count,
            "coordinate_assumption": (
                "DisplayX=longitude, DisplayY=latitude, WGS84/EPSG:4326. "
                "X/Y are retained only as fallback coordinates."
            ),
            "quality_score_mapping": {
                "0": "Unsatisfactory",
                "1": "Satisfactory",
                "2": "Good",
            },
            "google_fields_requested": FIELD_MASK.split(","),
            "photos_requested": fetch_photos,
        },
        "features": features,
    }

    # Retain the enrichment result before downloading, so photos can be retried
    # without repeating Google Places searches or the ArcGIS step.
    intermediate_json = intermediate_json or ENRICHED_DIR / f"{output_json.stem}.remote_photos.json"
    photo_manifest = photo_manifest or ENRICHED_DIR / f"{output_json.stem}.photo_manifest.json"
    write_json(intermediate_json, output_data)
    output_data = localize_photos(
        output_data, intermediate_json, output_json, photos_dir, photo_manifest
    )
    write_json(output_json, output_data)

    print()
    print(f"Done. Wrote {len(features):,} features to: {output_json}")
    print(f"Features with valid map coordinates: {mapped_count:,}")
    print(f"Google Places matches with status OK: {google_ok_count:,}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_GEOCODED_CSV)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_JSON)
    parser.add_argument("--max-rows", type=int, default=None, help="Process only the first N rows.")
    parser.add_argument("--request-delay", type=float, default=0.10,
                        help="Seconds between Google Places searches (default: 0.10).")
    parser.add_argument("--no-photos", action="store_true", help="Skip photo media requests and downloads.")
    parser.add_argument("--location-radius", type=float, default=LOCATION_BIAS_RADIUS_METERS)
    parser.add_argument("--photos-dir", type=Path, default=DEFAULT_PHOTOS_DIR)
    parser.add_argument("--intermediate-output", type=Path, default=None,
                        help="Retained enriched JSON before photo downloads (default: data/enriched/<output>.remote_photos.json).")
    parser.add_argument("--photo-manifest", type=Path, default=None,
                        help="Photo download audit JSON (default: data/enriched/<output>.photo_manifest.json).")
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.max_rows is not None and args.max_rows < 1:
        parser.error("--max-rows must be positive.")
    if args.request_delay < 0:
        parser.error("--request-delay must be nonnegative.")
    enrich_geocoded(
        input_csv=args.input,
        output_json=args.output,
        max_rows=args.max_rows,
        request_delay=args.request_delay,
        fetch_photos=not args.no_photos,
        location_bias_radius=args.location_radius,
        photos_dir=args.photos_dir,
        intermediate_json=args.intermediate_output,
        photo_manifest=args.photo_manifest,
    )


if __name__ == "__main__":
    main()
