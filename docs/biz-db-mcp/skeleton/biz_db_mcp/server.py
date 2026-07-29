"""biz-db-mcp: MCP server exposing read-only business MySQL access.

Tools:
  - describe_table(table): schema introspection.
  - query(sql, params?, limit?): small exploratory SELECT, bounded rows.
  - export(...): bulk SELECT streamed to Parquet, pushed into a Sandbox
    session as a Dataset. Returns a pointer (dataset_id/row_count), never
    the raw rows.

See docs/biz-db-mcp/README.md for the full design, guardrails, and the
open "session identity" question `export`'s signature calls out below.
"""

from __future__ import annotations

from typing import Any

from mcp.server.fastmcp import FastMCP

from . import db, sandbox_client
from .audit import log_call
from .config import load_settings
from .export import export_to_parquet

settings = load_settings()
mcp = FastMCP("biz-db-mcp")


@mcp.tool()
def describe_table(table: str) -> list[dict[str, Any]]:
    """Return column metadata for a table (DESCRIBE)."""
    with log_call("describe_table", table=table):
        return db.describe_table(settings, table)


@mcp.tool()
def query(
    sql: str,
    params: list[Any] | None = None,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    """Run a small, bounded read-only SELECT. Use `export` for bulk pulls."""
    with log_call("query", sql=sql, limit=limit):
        return db.run_query(settings, sql, params, limit)


@mcp.tool()
def export(
    sql: str,
    dataset_name: str,
    session_id: str,
    org_id: str,
    user_id: str,
    params: list[Any] | None = None,
    conversation_id: str | None = None,
) -> dict[str, Any]:
    """Stream a SELECT to Parquet and register it as a Sandbox Dataset.

    `session_id`/`org_id`/`user_id` identify which Sandbox session receives
    the Dataset. In this skeleton they are plain tool arguments; a real
    deployment should not let the model freely supply them (see README
    "session identity" section) — inject/validate them against the calling
    Run before trusting this call.
    """
    with log_call(
        "export", sql=sql, session_id=session_id, dataset_name=dataset_name
    ):
        tmp_path, row_count = export_to_parquet(settings, sql, params)
        result = sandbox_client.push_dataset(
            settings,
            session_id=session_id,
            acting_org_id=org_id,
            acting_user_id=user_id,
            dataset_name=dataset_name,
            file_path=tmp_path,
            conversation_id=conversation_id,
        )
        result["row_count"] = row_count
        return result


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
