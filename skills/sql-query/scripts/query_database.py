#!/usr/bin/env python3
"""Run read-only SQL queries."""

from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from urllib.parse import urlparse

MUTATING_PREFIXES = (
    "insert", "update", "delete", "drop", "alter", "create", "truncate",
    "replace", "merge", "grant", "revoke", "vacuum", "pragma",
)


def ensure_readonly(sql: str) -> None:
    normalized = sql.strip().lower().lstrip("(")
    if not (normalized.startswith("select") or normalized.startswith("with")):
        raise SystemExit("Only read-only SELECT/WITH queries are allowed by default")
    if any(token in normalized for token in [";insert", ";update", ";delete", ";drop", ";alter", ";create"]):
        raise SystemExit("Only read-only queries are allowed; multiple statements are blocked")
    first = normalized.split(None, 1)[0]
    if first in MUTATING_PREFIXES:
        raise SystemExit("Only read-only queries are allowed by default")


def sqlite_path(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "sqlite":
        raise SystemExit("Only sqlite:// URLs are currently supported by this script")
    return parsed.path


def main() -> int:
    parser = argparse.ArgumentParser(description="Execute a read-only SQL query")
    parser.add_argument("database_url", help="Database URL, e.g. sqlite:///tmp.db")
    parser.add_argument("sql", help="Read-only SELECT/WITH query")
    args = parser.parse_args()

    try:
        ensure_readonly(args.sql)
        with sqlite3.connect(sqlite_path(args.database_url)) as conn:
            conn.row_factory = sqlite3.Row
            rows = conn.execute(args.sql).fetchall()
            writer = csv.writer(sys.stdout)
            if rows:
                writer.writerow(rows[0].keys())
                for row in rows:
                    writer.writerow([row[key] for key in row.keys()])
            else:
                print("(no rows)")
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
