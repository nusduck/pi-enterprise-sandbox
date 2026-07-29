"""Read-only MySQL access. Every statement passes through sql_guard first."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any
from urllib.parse import unquote, urlparse

import pymysql
import pymysql.cursors

from .config import Settings
from .sql_guard import assert_select_only


class QueryError(RuntimeError):
    """Raised when a query fails or violates a guardrail."""


def _parse_dsn(dsn: str) -> dict[str, Any]:
    """Parse mysql://user:pass@host:port/db into pymysql.connect kwargs."""
    parsed = urlparse(dsn)
    if parsed.scheme not in ("mysql", "mysql+pymysql"):
        raise QueryError(f"unsupported DSN scheme: {parsed.scheme!r}")
    return {
        "host": parsed.hostname,
        "port": parsed.port or 3306,
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "database": (parsed.path or "/").lstrip("/") or None,
    }


@contextmanager
def _connection(settings: Settings, *, timeout_seconds: int, streaming: bool = False):
    conn = pymysql.connect(
        **_parse_dsn(settings.mysql_dsn),
        cursorclass=(
            pymysql.cursors.SSDictCursor if streaming else pymysql.cursors.DictCursor
        ),
        read_timeout=timeout_seconds,
        connect_timeout=10,
        autocommit=True,
    )
    try:
        with conn.cursor() as cursor:
            # MYSQL-side hard stop, independent of the client-side read_timeout
            # above; MAX_EXECUTION_TIME only applies to SELECT, which is all
            # this service ever runs.
            cursor.execute(f"SET SESSION MAX_EXECUTION_TIME={timeout_seconds * 1000}")
        yield conn
    finally:
        conn.close()


def describe_table(settings: Settings, table: str) -> list[dict[str, Any]]:
    if not table or not table.replace("_", "").isalnum():
        raise QueryError("invalid table name")
    with _connection(settings, timeout_seconds=settings.query_timeout_seconds) as conn:
        with conn.cursor() as cursor:
            # `table` is allowlist-validated above (alnum + underscore only),
            # so this interpolation cannot introduce injection; identifiers
            # cannot be passed as bound parameters in MySQL.
            cursor.execute(f"DESCRIBE `{table}`")
            return list(cursor.fetchall())


def run_query(
    settings: Settings,
    sql: str,
    params: list[Any] | None,
    limit: int | None,
) -> list[dict[str, Any]]:
    """Small, bounded exploratory query. Use export() for bulk pulls."""
    assert_select_only(sql)
    row_limit = min(limit, settings.query_max_rows) if limit else settings.query_max_rows
    with _connection(settings, timeout_seconds=settings.query_timeout_seconds) as conn:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or [])
            rows: list[dict[str, Any]] = []
            for row in cursor:
                rows.append(row)
                if len(rows) >= row_limit:
                    break
            return rows


def stream_query(
    settings: Settings,
    sql: str,
    params: list[Any] | None,
) -> Iterator[dict[str, Any]]:
    """Yield rows one at a time via a server-side cursor (bounded memory)."""
    assert_select_only(sql)
    with _connection(
        settings, timeout_seconds=settings.export_timeout_seconds, streaming=True
    ) as conn:
        with conn.cursor() as cursor:
            cursor.execute(sql, params or [])
            yield from cursor
