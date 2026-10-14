# UC Merced food inspection map

The data workflow has four layers: **scrape → prepare → manually geocode in ArcGIS Pro → enrich with Google Places and download photos**. The static web app reads the final JSON and local photos. See [the pipeline guide](docs/data-pipeline.md) for each input, output, and handoff.

## Project structure

```text
.
├── scripts/
│   ├── prepare_data.py         # Filter the county CSV for geocoding
│   ├── enrich_data.py          # Join Google Places data and download photos
│   ├── download_photos.py      # Download/retry photos from existing JSON or GeoJSON
│   └── paths.py                # Project-relative default paths
├── data/
│   ├── raw/                    # Original scraped county CSV
│   ├── prepared/               # Clean CSV handed to ArcGIS Pro
│   ├── geocoded/               # Manual ArcGIS Pro CSV export
│   └── enriched/               # Enrichment intermediate JSON and photo audit manifest
├── website/                    # The complete deployable static site
│   ├── restaurant_map.html
│   ├── data/restaurant_data.json
│   └── assets/
│       ├── css/restaurant_map.css
│       ├── js/restaurant_map.js
│       └── images/             # Branding, map pin, chevron, and restaurants/ photos
├── docs/
│   ├── data-pipeline.md
│   └── archive/                # Original notes and unrelated ArcGIS setup HTML
├── tests/                      # Pipeline/photo regression tests and browser smoke test
├── food_inspection_pipeline.py # Compatibility wrapper for old prepare/enrich commands
├── requirements.txt
└── .env.example
```

## Setup and run

Use Python 3.10 or newer. On Windows, from the project root:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Create a root `.env` using `.env.example` and set `GOOGLE_MAPS_API_KEY` for enrichment. Existing credentials remain private; `.env` and `secrets/` are ignored by Git and excluded from the website directory.

```powershell
# Save the scraped county table to data/raw/food_inspection_table.csv first.
.\.venv\Scripts\python.exe scripts/prepare_data.py

# Manual ArcGIS Pro step: geocode, review, then export to
# data/geocoded/merced_food_inspections_geocoded.csv.

.\.venv\Scripts\python.exe scripts/enrich_data.py
.\.venv\Scripts\python.exe -m http.server 8000 --directory website
```

Open [the local map](http://localhost:8000/restaurant_map.html). Publish the **whole `website/` directory**, including `data/` and `assets/`, and retain `restaurant_map.html` as the page entry point. ArcGIS SDK/map services and analytics still use their existing external services; restaurant images load from the site.

Selecting a search suggestion establishes the first analysis pin. Result cards and later search suggestions browse restaurants while keeping that pin and its result list fixed. Use the pin button to redrop the analysis pin, or Clear to start over. Filters apply to the current pin.

The collapsible **Nearby food metrics** card shows unweighted averages and bucket counts for inspection quality (0–2), Google ratings (0–5), estimated meal price, and distance from the pin. It summarizes all locations within the radius, including locations that do not match the filters. Missing values are counted separately and excluded from averages; inspection retains the existing quality-code interpretation (0 includes unsatisfactory/missing codes), and price uses the existing estimated meal-price helper. Buckets are fixed across selections, and the most common buckets are highlighted. The Food Desert Risk Index still uses its original calculation and updates its original card, but its display is disabled by `SHOW_FOOD_DESERT_RISK_INDEX` in the map JavaScript. Both the new card and results remain hidden until a location is selected and disappear on Clear.

The old commands `python food_inspection_pipeline.py prepare` and `python food_inspection_pipeline.py enrich` still dispatch to the separate scripts, using the organized paths.

## Checks

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

`tests/browser_smoke.cjs` uses Playwright to check the actual map, search, photo loading, filters, and analysis controls against a running local server. See its file comment for setup and invocation.
