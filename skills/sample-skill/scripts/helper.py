#!/usr/bin/env python3
"""Sample helper script for data analysis skill."""

import csv
import json
import sys
from collections import Counter
from pathlib import Path


def analyze_csv(filepath: str) -> dict:
    """Read a CSV file and return basic statistics."""
    rows = []
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)

    if not rows:
        return {"error": "Empty CSV", "row_count": 0}

    columns = list(rows[0].keys())
    stats = {
        "row_count": len(rows),
        "columns": columns,
        "column_count": len(columns),
    }

    # Numeric column stats
    for col in columns:
        values = []
        for r in rows:
            try:
                values.append(float(r[col]))
            except (ValueError, TypeError):
                pass
        if values:
            stats[f"{col}_min"] = min(values)
            stats[f"{col}_max"] = max(values)
            stats[f"{col}_avg"] = sum(values) / len(values)

    return stats


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python helper.py <csv_file>")
        sys.exit(1)

    result = analyze_csv(sys.argv[1])
    print(json.dumps(result, indent=2))
