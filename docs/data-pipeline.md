# Data pipeline and file contracts

Every automated stage keeps its input and writes a separate, named output. Defaults resolve from the project root even when a script is launched from another working directory. Explicit relative `--input`/`--output` arguments resolve from the current working directory.

| Layer | Work | Input | Retained output |
| --- | --- | --- | --- |
| 1. Scrape | Existing county scraping/export process | County food inspection page | `data/raw/food_inspection_table.csv` |
| 2. Prepare | `scripts/prepare_data.py` | Raw county CSV | `data/prepared/merced_food_inspections_for_geocoding.csv` |
| 3. Geocode | Manual work in ArcGIS Pro | Prepared CSV | `data/geocoded/merced_food_inspections_geocoded.csv` |
| 4. Enrich | `scripts/enrich_data.py` | Geocoded CSV + Google Places | `data/enriched/restaurant_data.remote_photos.json`, `data/enriched/restaurant_data.photo_manifest.json`, `website/data/restaurant_data.json`, `website/assets/images/restaurants/*` |

## 1. Scrape the county table

Source: [Merced County food inspection records](https://apps.co.merced.ca.us/publicapplets/pages/foodinspect/FoodInspect.aspx).

Save the original scraped table to `data/raw/food_inspection_table.csv` with these headers:

```text
Detail,Facility,Current Rating,Last Inspection Date,City,Address
```

The existing scraped CSV has been retained byte for byte. **The scraper source is not included in this project.** Continue using the existing scraping/export process and save its result to the path above; the project starts automation at preparation. For historical runs, keep separately dated source files, such as `data/raw/food_inspection_table.2026-10-13.csv`, and pass their paths explicitly.

## 2. Prepare the CSV

```powershell
python scripts/prepare_data.py
```

This keeps rows whose trimmed, case-insensitive `City` equals `Merced`, drops `Detail` if present, and preserves the other source fields. This is the same preparation behavior as before. Override the city or file paths when needed:

```powershell
python scripts/prepare_data.py --city Merced --input data/raw/food_inspection_table.csv --output data/prepared/merced_food_inspections_for_geocoding.csv
```

## 3. Manually geocode in ArcGIS Pro

1. Add `data/prepared/merced_food_inspections_for_geocoding.csv` as a table.
2. Geocode **Address**, using **City** and the California region where the locator supports them.
3. Review unmatched records and incorrect matches.
4. Export the geocoded table as **CSV**, preserving the inspection fields and coordinates, to `data/geocoded/merced_food_inspections_geocoded.csv`.
5. Ensure coordinates are longitude/latitude in **WGS84 / EPSG:4326**, not projected meters or feet. The script prefers valid `DisplayX`/`DisplayY` and falls back to `X`/`Y`.

Enrichment recognizes ArcGIS `USER_` prefixes and existing capitalization, spacing, and underscore variants. Keep facility, current rating, inspection date, city, and address fields, along with `Match_addr`, `Postal`, and coordinate fields when available. Rows without valid coordinates remain in the output for inspection; the web app omits them from the map.

**The original ArcGIS export is absent from the supplied folder.** The directory is ready for the manual export. The existing final dataset remains available to the web app, and photo migration does not require repeating geocoding.

## 4. Enrich and download photos

Set `GOOGLE_MAPS_API_KEY` in the project-root `.env` or environment. The key must have access to Places API (New).

First inspect a sample without replacing the live dataset:

```powershell
python scripts/enrich_data.py --max-rows 10 --output website/data/restaurant_data.sample.json
```

Then run the full dataset:

```powershell
python scripts/enrich_data.py
```

The search query, coordinate bias, top-result selection, pricing, distance, and inspection scoring are unchanged. Quality scores remain `0 = Unsatisfactory`, `1 = Satisfactory`, and `2 = Good`; unknown ratings stay `null`.

For each row, enrichment adds the matched Google place ID/name/address, coordinates, rating, review count, price range/bucket, Maps link, primary-photo metadata and author attributions, and match/error fields. It keeps the original ArcGIS geometry format and the `features[].attributes` contract used by the map.

The remote-photo enrichment result is stored **before downloads** in `data/enriched/<output-stem>.remote_photos.json`. Photos are downloaded to `website/assets/images/restaurants/`, using a readable restaurant slug and a hash of the place/photo identity. File extensions follow image signatures, files are written atomically, and existing valid downloads are reused.

The final `google_photo_uri` contains a portable, forward-slash path **relative to the JSON directory**, for example:

```json
{"google_photo_uri": "../assets/images/restaurants/restaurant-name-0123456789abcdef.jpg"}
```

The browser resolves that path against `./data/restaurant_data.json`. Author attributions remain available to the existing popup. A photo failure preserves the restaurant's data, leaves the URI blank for the existing placeholder, and records `google_photo_error`. A manifest at `data/enriched/<output-stem>.photo_manifest.json` records each source URL, local path, status, error, and photo metadata. Retrying the original input reuses successful refreshed downloads with their matching author attributions. JSON metadata includes local-photo and error counts.

### Retry photos from existing JSON or GeoJSON

```powershell
python scripts/download_photos.py
```

This reads the retained enrichment JSON and writes the final site JSON and manifest without repeating Places searches. For older datasets whose photo URLs no longer work:

```powershell
python scripts/download_photos.py --refresh-google-photos
```

With this opt-in flag, HTTP 400/403/404/410 triggers a Place Details request for **photos only**, followed by a fresh photo media request. It refreshes photo fields and their matching author attributions, while keeping ratings, pricing, coordinates, names, and inspection data. Google's [photo documentation](https://developers.google.com/maps/documentation/places/web-service/place-photos) explains that photo names can expire; [Place Details](https://developers.google.com/maps/documentation/places/web-service/place-details) supports fetching new photos by place ID.

`download_photos.py` also accepts a plain JSON record array or GeoJSON `features[].properties`. It preserves the input structure and geometry; it does not convert the app's JSON to GeoJSON.

### Options and generated files

- `--no-photos`: enrich place data without media requests or downloads.
- `--max-rows N`: process a sample; use a separate `--output` to preserve the current full dataset.
- `--request-delay SECONDS`: control the delay between requests (`0.10` by default).
- `--location-radius METERS`: set the existing search bias radius (`500` by default).
- `--input`, `--output`: choose stage files.
- `--photos-dir`: choose the photo destination. For deployment, keep it inside the served website.
- Enrichment's `--intermediate-output` and `--photo-manifest`: override retained output paths.
- Photo downloader's `--manifest`: override its audit path.

With a custom output such as `restaurant_data.sample.json`, default intermediate files use that same stem. Default final outputs replace the current files on rerun; retain dated filenames for historical snapshots. Keep raw CSV, prepared CSV, manual geocoding CSV, remote-photo intermediate, manifest, and final JSON for reproducibility.

## Web app and deployment

`website/restaurant_map.html`, `website/assets/css/restaurant_map.css`, and `website/assets/js/restaurant_map.js` contain the existing page markup, styles, and behavior. Branding, favicon, pin, and chevron are in `website/assets/images/`; CSS URLs resolve relative to the CSS file, and JS/page URLs resolve relative to the HTML page.

Serve `website/` over HTTP, rather than opening HTML through `file://`:

```powershell
python -m http.server 8000 --directory website
```

Deploy the entire `website/` directory. The app still uses the existing ArcGIS CDN, satellite basemap, reference-label layer, search behavior, risk scoring, filters, legend, benchmark controls, and Plausible analytics. Local photo paths travel with the deployable directory; no Google key is needed in the browser.

Review `google_status != OK`, suspicious name/address matches, unexpectedly large `google_distance_meters`, unmatched geometry, and photo-manifest failures when updating data.
