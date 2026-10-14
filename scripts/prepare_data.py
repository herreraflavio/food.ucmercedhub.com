#!/usr/bin/env python3
"""Stage 2: prepare the raw county inspection table for manual geocoding."""

from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

if __package__:
    from .paths import DEFAULT_SOURCE_CSV, DEFAULT_PREPARED_CSV, DEFAULT_GEOCODED_CSV
else:
    from paths import DEFAULT_SOURCE_CSV, DEFAULT_PREPARED_CSV, DEFAULT_GEOCODED_CSV


def prepare_source(input_csv: Path, output_csv: Path, city: str = "Merced") -> None:
    """Filter the inspection export to one city and remove the Detail column."""
    if not input_csv.exists():
        raise FileNotFoundError(f"Input CSV not found: {input_csv}")

    df = pd.read_csv(input_csv)

    if "City" not in df.columns:
        raise RuntimeError("Input CSV must contain a 'City' column.")

    # Normalize only for comparison; preserve the source values themselves.
    city_mask = df["City"].astype(str).str.strip().str.casefold() == city.casefold()
    df = df.loc[city_mask].copy()

    if "Detail" in df.columns:
        df = df.drop(columns=["Detail"])

    output_csv.parent.mkdir(parents=True, exist_ok=True)
    df.to_csv(output_csv, index=False)

    print(f"Prepared {len(df):,} rows for geocoding.")
    print(f"Output: {output_csv}")
    print("Next: geocode the Address field in ArcGIS Pro, then export the result as")
    print(f"      {DEFAULT_GEOCODED_CSV}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Filter the county inspection table before ArcGIS Pro geocoding."
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_SOURCE_CSV)
    parser.add_argument("--output", type=Path, default=DEFAULT_PREPARED_CSV)
    parser.add_argument("--city", default="Merced")
    return parser


def main(argv: list[str] | None = None) -> None:
    args = build_parser().parse_args(argv)
    prepare_source(args.input, args.output, city=args.city)


if __name__ == "__main__":
    main()
