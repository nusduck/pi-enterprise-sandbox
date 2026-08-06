"""Readonly check that the database can support tool-execution claims.

Verifying the schema is a different concern from validating a claim against it,
and it runs at most once per validator. INFORMATION_SCHEMA only — this module
never issues DDL, and a missing column or index fails closed rather than
letting a claim path silently degrade.
"""

from __future__ import annotations

from typing import Any

from sandbox.app.persistence.errors import SchemaGapError

#: Columns added by migration 20260718000008 that the claim path depends on.
CLAIM_REQUIRED_COLUMNS: dict[str, tuple[str, ...]] = {
    "sandbox_executions": (
        "tool_execution_id",
        "tool_call_id",
        "request_hash",
        "request_hash_version",
        "execution_fence_token",
    ),
    "tool_executions": (
        "request_hash",
        "request_hash_version",
        "execution_fence_token",
    ),
}

#: Uniques that make the claim race safe; without them concurrent first claims
#: would both succeed instead of one replaying the other.
CLAIM_REQUIRED_INDEXES: tuple[tuple[str, str], ...] = (
    ("sandbox_executions", "uk_sandbox_execution_run_tool_call"),
    ("sandbox_executions", "uk_sandbox_execution_tool_execution"),
)


def probe_claim_schema_capability(conn: Any) -> None:
    """Raise :class:`SchemaGapError` when the claim schema is incomplete."""
    missing: list[str] = []
    for table, columns in CLAIM_REQUIRED_COLUMNS.items():
        for col in columns:
            conn.execute(
                """
                SELECT COLUMN_NAME AS name
                FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE()
                  AND TABLE_NAME = %s
                  AND COLUMN_NAME = %s
                LIMIT 1
                """,
                (table, col),
            )
            if conn.fetchone() is None:
                missing.append(f"column:{table}.{col}")

    for table, index_name in CLAIM_REQUIRED_INDEXES:
        conn.execute(
            """
            SELECT INDEX_NAME AS name
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = %s
              AND INDEX_NAME = %s
            LIMIT 1
            """,
            (table, index_name),
        )
        if conn.fetchone() is None:
            missing.append(f"index:{table}.{index_name}")

    if missing:
        raise SchemaGapError(
            "Sandbox claim schema capability missing: " + ", ".join(sorted(missing))
        )


__all__ = [
    "CLAIM_REQUIRED_COLUMNS",
    "CLAIM_REQUIRED_INDEXES",
    "probe_claim_schema_capability",
]
