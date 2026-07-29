"""Bulk export: stream a SELECT to Parquet in bounded-memory batches.

Row count can be 10^5-10^6; buffering the full result set in memory
before writing would defeat the point of a server-side cursor, so rows
are written to the Parquet file in fixed-size batches as they arrive.
"""

from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

from .config import Settings
from .db import stream_query


class ExportError(RuntimeError):
    """Raised when an export fails or exceeds its row guardrail."""


def export_to_parquet(
    settings: Settings,
    sql: str,
    params: list[Any] | None,
    *,
    batch_size: int | None = None,
) -> tuple[Path, int]:
    """Stream *sql* to a temp Parquet file. Returns (path, row_count).

    The caller owns the returned file and must remove it after use —
    sandbox_client.push_dataset() does this on both success and failure.
    """
    batch_size = batch_size or settings.export_row_batch_size
    tmp_path = Path(tempfile.mkstemp(suffix=".parquet")[1])

    row_count = 0
    writer: pq.ParquetWriter | None = None
    batch_rows: list[dict[str, Any]] = []

    try:
        for row in stream_query(settings, sql, params):
            batch_rows.append(row)
            row_count += 1

            if row_count > settings.export_max_rows:
                raise ExportError(
                    f"export exceeds BIZDB_EXPORT_MAX_ROWS={settings.export_max_rows}; "
                    "narrow the query (add filters/date range) or raise the "
                    "limit deliberately"
                )

            if len(batch_rows) >= batch_size:
                writer = _write_batch(tmp_path, writer, batch_rows)
                batch_rows = []

        if batch_rows:
            writer = _write_batch(tmp_path, writer, batch_rows)

        if writer is None:
            # Zero-row result: still produce a valid, readable Parquet file
            # rather than an empty/corrupt one.
            pq.write_table(pa.Table.from_pylist([]), tmp_path)
        else:
            writer.close()

        return tmp_path, row_count
    except Exception:
        tmp_path.unlink(missing_ok=True)
        raise


def _write_batch(
    path: Path,
    writer: pq.ParquetWriter | None,
    rows: list[dict[str, Any]],
) -> pq.ParquetWriter:
    table = pa.Table.from_pylist(rows)
    if writer is None:
        writer = pq.ParquetWriter(path, table.schema)
    writer.write_table(table)
    return writer
