"""Environment-driven configuration for biz-db-mcp.

All secrets (MySQL DSN, Sandbox service token) are read from process
environment only — never from CLI args or a config file — so they never
show up in `ps`, shell history, or a committed file. This mirrors how
this repo's own MCP adapter resolves `secretRef` values from the calling
process's env (see agent/src/infrastructure/mcp/pi-mcp-adapter-factory.js).
"""

from __future__ import annotations

import os
from dataclasses import dataclass


class ConfigError(RuntimeError):
    """Raised when a required environment variable is missing or invalid."""


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ConfigError(f"{name} is required")
    return value


def _optional_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise ConfigError(f"{name} must be an integer, got {raw!r}") from exc


@dataclass(frozen=True)
class Settings:
    mysql_dsn: str

    sandbox_base_url: str
    sandbox_api_token: str
    sandbox_api_token_header: str

    query_max_rows: int
    query_timeout_seconds: int

    export_timeout_seconds: int
    export_max_rows: int
    export_row_batch_size: int


def load_settings() -> Settings:
    return Settings(
        mysql_dsn=_require("BIZDB_MYSQL_DSN"),
        sandbox_base_url=_require("BIZDB_SANDBOX_BASE_URL"),
        sandbox_api_token=_require("BIZDB_SANDBOX_API_TOKEN"),
        sandbox_api_token_header=os.environ.get(
            "BIZDB_SANDBOX_API_TOKEN_HEADER", "X-API-Key"
        ).strip()
        or "X-API-Key",
        query_max_rows=_optional_int("BIZDB_QUERY_MAX_ROWS", 200),
        query_timeout_seconds=_optional_int("BIZDB_QUERY_TIMEOUT_SECONDS", 10),
        export_timeout_seconds=_optional_int("BIZDB_EXPORT_TIMEOUT_SECONDS", 600),
        export_max_rows=_optional_int("BIZDB_EXPORT_MAX_ROWS", 2_000_000),
        export_row_batch_size=_optional_int("BIZDB_EXPORT_ROW_BATCH_SIZE", 20_000),
    )
