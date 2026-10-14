#!/usr/bin/env python3
"""Download restaurant photos and replace remote URLs with paths relative to JSON.

Also works with GeoJSON properties or a plain array of restaurant records.
Existing place data and author attributions are preserved when a photo fails.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import time
from copy import deepcopy
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlsplit

import requests
from dotenv import load_dotenv

if __package__:
    from .paths import PROJECT_ROOT, DEFAULT_OUTPUT_JSON, DEFAULT_PHOTOS_DIR, ENRICHED_DIR
else:
    from paths import PROJECT_ROOT, DEFAULT_OUTPUT_JSON, DEFAULT_PHOTOS_DIR, ENRICHED_DIR

REQUEST_TIMEOUT_SECONDS = 20
IMAGE_EXTENSIONS = (".jpg", ".png", ".webp", ".gif", ".avif")
PHOTO_FIELDS = (
    "google_photo_name", "google_photo_width_px", "google_photo_height_px",
    "google_photo_author_attributions", "google_photo_media_name", "google_photo_uri",
)


def write_json(path: Path, data: Any) -> None:
    """Publish complete JSON atomically, keeping an existing file on write failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as outfile:
            json.dump(data, outfile, ensure_ascii=False, indent=2)
            outfile.write("\n")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def image_extension(content: bytes) -> str:
    """Check actual file signatures so an HTML error page is never saved as a photo."""
    if content.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if content[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return ".webp"
    if content[4:8] == b"ftyp" and content[8:12] in (b"avif", b"avis"):
        return ".avif"
    raise ValueError("Photo response was empty or was not a supported image.")


def photo_file_stem(attributes: dict[str, Any], photo_uri: str) -> str:
    name = attributes.get("google_name") or attributes.get("USER_facility") or "restaurant"
    slug = re.sub(r"[^a-z0-9]+", "-", str(name).casefold()).strip("-")[:60]
    identity = "|".join(
        str(value or "")
        for value in (
            attributes.get("google_place_id"),
            attributes.get("google_photo_name") or photo_uri,
        )
    )
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:16]
    return f"{slug or 'restaurant'}-{digest}"


def download_photo(photo_uri: str, photos_dir: Path, attributes: dict[str, Any]) -> Path:
    """Reuse a complete download; otherwise save validated bytes with a safe filename."""
    stem = photo_file_stem(attributes, photo_uri)
    photos_dir.mkdir(parents=True, exist_ok=True)
    for extension in IMAGE_EXTENSIONS:
        existing = photos_dir / (stem + extension)
        if existing.is_file() and existing.stat().st_size:
            with existing.open("rb") as infile:
                try:
                    if image_extension(infile.read(32)) == extension:
                        return existing
                except ValueError:
                    pass

    with requests.get(photo_uri, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        response.raise_for_status()
        content = response.content
    destination = photos_dir / (stem + image_extension(content))
    temporary = destination.with_suffix(destination.suffix + ".part")
    try:
        temporary.write_bytes(content)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def relative_photo_uri(photo_path: Path, output_json: Path) -> str:
    return Path(os.path.relpath(photo_path.resolve(), output_json.parent.resolve())).as_posix()


def refresh_google_photo(api_key: str, attributes: dict[str, Any]) -> dict[str, Any]:
    """Refresh expired photo references by place ID without changing restaurant data."""
    place_id = str(attributes.get("google_place_id") or "")
    if not place_id:
        raise ValueError("An expired photo cannot be refreshed without a Google place ID.")
    headers = {"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": "photos"}
    with requests.get(
        f"https://places.googleapis.com/v1/places/{quote(place_id, safe='')}",
        headers=headers, timeout=REQUEST_TIMEOUT_SECONDS,
    ) as response:
        response.raise_for_status()
        photos = response.json().get("photos") or []
    if not photos:
        raise ValueError("Google currently has no photo for this place.")
    first = photos[0]
    photo_name = first.get("name", "")
    if not photo_name:
        raise ValueError("Google returned an empty photo reference.")
    with requests.get(
        f"https://places.googleapis.com/v1/{photo_name}/media",
        headers={"X-Goog-Api-Key": api_key},
        params={"maxWidthPx": 640, "maxHeightPx": 400, "skipHttpRedirect": "true"},
        timeout=REQUEST_TIMEOUT_SECONDS,
    ) as response:
        response.raise_for_status()
        media = response.json()
    uri = media.get("photoUri", "")
    if not uri:
        raise ValueError("Google returned an empty photo URI.")
    return {
        "google_photo_name": photo_name,
        "google_photo_width_px": first.get("widthPx"),
        "google_photo_height_px": first.get("heightPx"),
        "google_photo_author_attributions": first.get("authorAttributions") or [],
        "google_photo_media_name": media.get("name", ""),
        "google_photo_uri": uri,
    }


def localize_photos(
    data: Any,
    input_json: Path,
    output_json: Path,
    photos_dir: Path,
    manifest_path: Path,
    request_delay: float = 0.0,
    refresh_api_key: str | None = None,
) -> Any:
    """Return a copy containing only usable local photo paths, plus a saved audit log."""
    output = deepcopy(data)
    features = output if isinstance(output, list) else output.get("features", [])
    if not isinstance(features, list):
        raise ValueError("Input must be a JSON array or contain a features array.")
    relative_photo_uri(photos_dir, output_json)
    # A refresh changes Google's photo reference. Retain its metadata in the
    # manifest so retrying the original input reuses the image and correct author.
    cached_records = {}
    if manifest_path.is_file():
        try:
            previous = json.loads(manifest_path.read_text(encoding="utf-8"))
            for record in previous.get("photos", []):
                if record.get("local_uri") and record.get("photo_fields"):
                    cached_records[(record.get("source_row_number"), record.get("google_place_id", ""), record.get("source_uri", ""))] = record
        except (OSError, ValueError, AttributeError, TypeError):
            pass
    records = []
    local_count = 0
    error_count = 0
    for index, feature in enumerate(features, start=1):
        attributes = feature.get("attributes", feature.get("properties", feature))
        uri = str(attributes.get("google_photo_uri") or "").strip()
        record = {
            "source_row_number": attributes.get("source_row_number", index),
            "google_place_id": attributes.get("google_place_id", ""),
            "source_uri": uri,
            "local_uri": "",
            "status": "NO_PHOTO",
            "error": "",
        }
        try:
            if uri:
                parsed = urlsplit(uri)
                cached = cached_records.get((record["source_row_number"], attributes.get("google_place_id", ""), uri))
                cached_path = output_json.parent / cached["local_uri"] if cached else None
                if cached_path is not None:
                    try:
                        with cached_path.open("rb") as infile:
                            image_extension(infile.read(32))
                    except (OSError, ValueError):
                        cached_path = None
                if cached_path is not None:
                    attributes.update({key: value for key, value in cached["photo_fields"].items() if key in PHOTO_FIELDS})
                    photo_path = cached_path
                    if cached.get("refreshed_uri"):
                        record["refreshed_uri"] = cached["refreshed_uri"]
                elif parsed.scheme in ("http", "https"):
                    try:
                        photo_path = download_photo(uri, photos_dir, attributes)
                    except requests.HTTPError as exc:
                        if not refresh_api_key or exc.response is None or exc.response.status_code not in (400, 403, 404, 410):
                            raise
                        refreshed = refresh_google_photo(refresh_api_key, attributes)
                        attributes.update(refreshed)
                        record["refreshed_uri"] = refreshed["google_photo_uri"]
                        photo_path = download_photo(refreshed["google_photo_uri"], photos_dir, attributes)
                elif not parsed.scheme and not parsed.netloc:
                    photo_path = input_json.parent / unquote(parsed.path)
                    if not photo_path.is_file():
                        raise FileNotFoundError("Referenced local photo does not exist.")
                    with photo_path.open("rb") as infile:
                        image_extension(infile.read(32))
                else:
                    raise ValueError("Unsupported photo URL scheme.")
                local_uri = relative_photo_uri(photo_path, output_json)
                attributes["google_photo_uri"] = local_uri
                attributes["google_photo_error"] = ""
                record.update(local_uri=local_uri, status="LOCAL")
                local_count += 1
                print(f"[{index}/{len(features)}] Local photo: {photo_path.name}")
            else:
                attributes["google_photo_uri"] = ""
                if attributes.get("google_photo_error"):
                    record.update(status="ERROR", error=attributes["google_photo_error"])
                    error_count += 1
        except (requests.RequestException, OSError, ValueError) as exc:
            api_key = refresh_api_key or os.getenv("GOOGLE_MAPS_API_KEY", "")
            error = str(exc)
            if api_key:
                error = error.replace(api_key, "[redacted]")
            attributes["google_photo_uri"] = ""
            attributes["google_photo_error"] = error
            record.update(status="ERROR", error=error)
            error_count += 1
            print(f"[{index}/{len(features)}] Photo unavailable; retained restaurant data.")
        record["photo_fields"] = {key: attributes[key] for key in PHOTO_FIELDS if key in attributes}
        records.append(record)
        if request_delay > 0 and uri:
            time.sleep(request_delay)

    if isinstance(output, dict):
        if "output_file" in output:
            output["output_file"] = str(output_json)
        output.setdefault("metadata", {}).update(
            local_photo_count=local_count,
            photo_download_error_count=error_count,
            photo_uri_base="JSON file directory",
        )
    write_json(manifest_path, {
        "input_file": str(input_json),
        "output_file": str(output_json),
        "local_photo_count": local_count,
        "photo_download_error_count": error_count,
        "photos": records,
    })
    print(f"Photos: {local_count} local, {error_count} errors. Manifest: {manifest_path}")
    return output


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=ENRICHED_DIR / "restaurant_data.remote_photos.json")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT_JSON)
    parser.add_argument("--photos-dir", type=Path, default=DEFAULT_PHOTOS_DIR)
    parser.add_argument("--manifest", type=Path, default=None)
    parser.add_argument("--request-delay", type=float, default=0.10)
    parser.add_argument("--refresh-google-photos", action="store_true",
                        help="Use GOOGLE_MAPS_API_KEY to refresh expired photo URLs after HTTP 400/403/404/410.")
    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.request_delay < 0:
        parser.error("--request-delay must be nonnegative.")
    api_key = None
    if args.refresh_google_photos:
        load_dotenv(PROJECT_ROOT / ".env")
        api_key = os.getenv("GOOGLE_MAPS_API_KEY")
        if not api_key:
            parser.error("--refresh-google-photos requires GOOGLE_MAPS_API_KEY in the environment or project .env.")
    with args.input.open(encoding="utf-8-sig") as infile:
        data = json.load(infile)
    manifest = args.manifest or ENRICHED_DIR / f"{args.output.stem}.photo_manifest.json"
    output = localize_photos(data, args.input, args.output, args.photos_dir, manifest, args.request_delay, api_key)
    write_json(args.output, output)
    print(f"Output: {args.output}")


if __name__ == "__main__":
    main()
