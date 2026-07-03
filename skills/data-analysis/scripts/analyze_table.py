#!/usr/bin/env python3
"""Summarize CSV/Excel tables."""

from __future__ import annotations

import argparse
import csv
from pathlib import Path
from statistics import mean


def summarize_with_stdlib(path: Path) -> str:
    with path.open(newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    columns = rows[0].keys() if rows else []
    lines = [f"Rows: {len(rows)}", "Columns: " + ", ".join(columns), "", "Summary:"]
    for col in columns:
        values = []
        for row in rows:
            try:
                values.append(float(row[col]))
            except (TypeError, ValueError):
                pass
        if values:
            lines.append(f"{col}: count={len(values)} mean={mean(values):.6g} min={min(values):.6g} max={max(values):.6g}")
        else:
            lines.append(f"{col}: count={len(rows)} non_numeric")
    return "\n".join(lines)


def summarize_with_pandas(path: Path, chart: str | None = None) -> str:
    import pandas as pd

    if path.suffix.lower() in {".xlsx", ".xls"}:
        df = pd.read_excel(path)
    else:
        df = pd.read_csv(path)
    output = [
        f"Rows: {len(df)}",
        "Columns: " + ", ".join(map(str, df.columns)),
        "",
        "Summary:",
        df.describe(include="all").to_string(),
    ]
    if chart:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt

        numeric = df.select_dtypes(include="number")
        if numeric.empty:
            raise SystemExit("No numeric columns available for chart")
        numeric.iloc[:, 0].plot(kind="line", title=str(numeric.columns[0]))
        plt.tight_layout()
        plt.savefig(chart)
        output.append(f"Chart written: {chart}")
    return "\n".join(output)


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize a CSV or Excel table")
    parser.add_argument("input", help="CSV/XLSX file path")
    parser.add_argument("--chart", help="Optional output PNG for first numeric column")
    args = parser.parse_args()

    path = Path(args.input)
    try:
        print(summarize_with_pandas(path, args.chart))
    except ModuleNotFoundError:
        if path.suffix.lower() in {".xlsx", ".xls"} or args.chart:
            raise
        print(summarize_with_stdlib(path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
