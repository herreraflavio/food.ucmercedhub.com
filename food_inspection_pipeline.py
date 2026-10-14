#!/usr/bin/env python3
"""Compatibility entry point; implementation lives in scripts/prepare_data.py and enrich_data.py."""

from __future__ import annotations

import argparse
import sys


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "enrich"))
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        parser.print_help()
        return
    args = parser.parse_args(sys.argv[1:2])
    if args.command == "prepare":
        from scripts.prepare_data import main as run
    else:
        from scripts.enrich_data import main as run
    run(sys.argv[2:])


if __name__ == "__main__":
    main()
