# Merced Food Inspection → Restaurant Map Data Pipeline

This workflow starts with the Merced County food inspection CSV, keeps facilities in the **City of Merced**, geocodes their addresses in **ArcGIS Pro**, adds a numeric inspection-quality score, and then enriches each facility with **Google Places** data such as rating, review count, price information, Maps URL, and optional photo metadata.

The old three-script sequence (`parse.py` → `post_cleaning.py` → `join_google_restaurant_data.py`) has been consolidated into a single Python program with two commands. The ArcGIS Pro geocoding step remains manual and sits between the two commands.

## Files you need

Keep these in the same working folder:

- `food_inspection_pipeline.py` — the pipeline script.
- `food_inspection_table.csv` — raw Merced County inspection export.
- `.env` — required only for the Google enrichment stage.

The source inspection data came from:

`https://apps.co.merced.ca.us/publicapplets/pages/foodinspect/FoodInspect.aspx`

## Python setup

Install the required packages once:

```bash
pip install pandas requests python-dotenv
```

For the Google step, create a `.env` file in the working folder:

```text
GOOGLE_MAPS_API_KEY=your_google_maps_api_key_here
```

Do not commit the `.env` file or API key to Git.

---

## Step 1 — Prepare the county inspection CSV

Place the raw export at:

```text
food_inspection_table.csv
```

Run:

```bash
python food_inspection_pipeline.py prepare
```

Default output:

```text
merced_food_inspections_for_geocoding.csv
```

This step:

1. Keeps only rows whose `City` is `Merced`.
2. Removes the `Detail` column when it exists.
3. Leaves the remaining inspection fields intact for geocoding.

You can override filenames if needed:

```bash
python food_inspection_pipeline.py prepare --input food_inspection_table.csv --output merced_food_inspections_for_geocoding.csv
```

---

## Step 2 — Geocode in ArcGIS Pro

Use `merced_food_inspections_for_geocoding.csv` as the input table.

In ArcGIS Pro:

1. Geocode the facility **Address** field using the normal address-locator/geocoding workflow.
2. Review unmatched or obviously incorrect locations before continuing.
3. Make sure the exported geocoder result contains usable coordinate fields. The pipeline prefers `DisplayX` / `DisplayY` and falls back to `X` / `Y`.
4. Export the geocoded result as a CSV named:

```text
geocode_address.csv
```

The enrichment script is tolerant of ArcGIS field prefixes such as `USER_Facility`, `USER_Current_Rating`, `USER_Address`, and similar capitalization/underscore variations.

---

## Step 3 — Add quality score and Google Places data

Before running the full dataset, test a small sample:

```bash
python food_inspection_pipeline.py enrich --max-rows 10
```

If the matches look correct, run the full file:

```bash
python food_inspection_pipeline.py enrich
```

Default input:

```text
geocode_address.csv
```

Default output:

```text
restaurant_data.json
```

The inspection score is added automatically during this step:

| Inspection rating | `quality_score` |
|---|---:|
| Unsatisfactory | 0 |
| Satisfactory | 1 |
| Good | 2 |

Unknown or missing rating values are left as `null` instead of being incorrectly treated as Unsatisfactory.

For each facility, the Google step attempts to add:

- Google Place ID and matched name/address
- Google coordinates
- distance between the ArcGIS point and Google result
- Google rating
- Google review count
- price range / price bucket when available
- Google Maps URL
- first photo metadata and a photo URI when available
- search/match status and error fields for auditing

The final JSON also contains map geometry using ArcGIS `DisplayX` / `DisplayY` when valid, with `X` / `Y` as a fallback.

### Useful options

Test only a few rows:

```bash
python food_inspection_pipeline.py enrich --max-rows 10
```

Skip Google photo requests:

```bash
python food_inspection_pipeline.py enrich --no-photos
```

Use a different input/output file:

```bash
python food_inspection_pipeline.py enrich --input geocode_address.csv --output restaurant_data.json
```

Change the Google location-bias radius:

```bash
python food_inspection_pipeline.py enrich --location-radius 750
```

---

## Short version: run order

```text
1. Download/export food_inspection_table.csv
                ↓
2. python food_inspection_pipeline.py prepare
                ↓
   merced_food_inspections_for_geocoding.csv
                ↓
3. ArcGIS Pro: geocode Address + review matches + export CSV
                ↓
   geocode_address.csv
                ↓
4. python food_inspection_pipeline.py enrich --max-rows 10
                ↓
5. Verify Google matches
                ↓
6. python food_inspection_pipeline.py enrich
                ↓
   restaurant_data.json
```

## What the consolidated script replaces

You no longer need to run these separately:

```text
parse.py
post_cleaning.py
join_google_restaurant_data.py
```

Their responsibilities are now:

- `prepare` command = old `parse.py`
- ArcGIS Pro = same geocoding step as before
- `enrich` command = old `post_cleaning.py` + `join_google_restaurant_data.py`

## Recommended audit before publishing

After the final run, check facilities with any of these conditions before using the JSON in the map:

- `google_status` is not `OK`
- `google_distance_meters` is unexpectedly large
- Google name/address does not correspond to the inspection facility
- ArcGIS point is unmatched or visibly misplaced

Google matching uses the facility name, geocoded address, city/region/postal information, and a coordinate bias around the ArcGIS point. It still returns the top result, so manual review of suspicious matches is worthwhile.
