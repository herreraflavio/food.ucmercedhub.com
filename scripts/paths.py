"""Project defaults resolve from this file, independently of the working directory."""

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
ENRICHED_DIR = DATA_DIR / "enriched"
WEBSITE_DIR = PROJECT_ROOT / "website"

DEFAULT_SOURCE_CSV = DATA_DIR / "raw" / "food_inspection_table.csv"
DEFAULT_PREPARED_CSV = DATA_DIR / "prepared" / "merced_food_inspections_for_geocoding.csv"
DEFAULT_GEOCODED_CSV = DATA_DIR / "geocoded" / "merced_food_inspections_geocoded.csv"
DEFAULT_OUTPUT_JSON = WEBSITE_DIR / "data" / "restaurant_data.json"
DEFAULT_PHOTOS_DIR = WEBSITE_DIR / "assets" / "images" / "restaurants"
