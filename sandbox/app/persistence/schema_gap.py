"""Positive schema capability vs Agent MySQL migration (PR-02).

Source of truth:
  agent/src/infrastructure/mysql/migrations/20260718000001_core_platform_schema.js
  agent/src/infrastructure/mysql/schema-tables.js

PR-02 owns Sandbox execution-domain tables in the Agent-owned Knex migration.
This module documents and validates that capability; it does not re-author
Conversation / Message / Run schema (Agent authority).
"""

from __future__ import annotations

from typing import Any

# ---------------------------------------------------------------------------
# agent_sessions ↔ sandbox_sessions relationship
# ---------------------------------------------------------------------------
#
# agent_sessions.sandbox_session_id is NOT NULL and is a **logical unique
# reference** (no FK to sandbox_sessions). sandbox_sessions.agent_session_id is
# likewise a **logical unique reference** (no FK to agent_sessions).
#
# Rationale: a cyclic FK would force an impossible create order when Agent
# persists agent_sessions with a pre-allocated sandbox_session_id before Sandbox
# inserts sandbox_sessions. Either side may be inserted first; child rows
# (process_executions, sandbox_executions) FK to sandbox_sessions once present.
#
# PR-07A 1:1 ownership uniques (stable names):
#   uk_agent_sessions_workspace_id
#   uk_agent_sessions_sandbox_session_id
#   uk_sandbox_sessions_agent_session_id
#   uk_sandbox_sessions_workspace_id
SANDBOX_AGENT_SESSION_RELATIONSHIP = (
    "logical_unique_reference_no_cyclic_fk"
)

AGENT_SANDBOX_OWNERSHIP_UNIQUES: tuple[str, ...] = (
    "uk_agent_sessions_workspace_id",
    "uk_agent_sessions_sandbox_session_id",
    "uk_sandbox_sessions_agent_session_id",
    "uk_sandbox_sessions_workspace_id",
)

MIGRATION_FILE = (
    "agent/src/infrastructure/mysql/migrations/"
    "20260718000001_core_platform_schema.js"
)

# All Sandbox execution-domain tables present in the Agent core migration.
EXECUTION_DOMAIN_TABLES: tuple[str, ...] = (
    "sandbox_sessions",
    "process_executions",
    "sandbox_executions",
    "sandbox_audit_events",
    "datasets",
    "artifacts",
)

# Backward-compatible alias used by older imports/tests.
EXECUTION_DOMAIN_TABLES_PRESENT: tuple[str, ...] = EXECUTION_DOMAIN_TABLES

# Agent-owned tables — Sandbox must NOT re-author Conversation/Message/Run here.
AGENT_AUTHORITY_TABLES: tuple[str, ...] = (
    "conversations",
    "messages",
    "runs",
    "run_events",
    "agent_sessions",
    "agent_session_snapshots",
    "tool_executions",
    "approvals",
    "domain_outbox",
    "idempotency_records",
)

# Required columns / capability descriptors for validation and docs.
EXECUTION_DOMAIN_TABLE_SPECS: tuple[dict[str, Any], ...] = (
    {
        "table": "sandbox_sessions",
        "repository": "SessionRepository",
        "purpose": (
            "Sandbox Session lifecycle / workspace binding (plan §4.8). "
            "agent_session_id is a logical unique ref (no FK to agent_sessions). "
            "1:1 uniques: uk_sandbox_sessions_agent_session_id, "
            "uk_sandbox_sessions_workspace_id."
        ),
        "required_columns": (
            "sandbox_session_id CHAR(26) PK",
            "org_id CHAR(26) NOT NULL",
            "user_id CHAR(26) NOT NULL",
            "agent_session_id CHAR(26) NOT NULL",
            "workspace_id CHAR(26) NOT NULL",
            "status VARCHAR(32) NOT NULL",
            "created_at DATETIME(3) NOT NULL",
            "updated_at DATETIME(3) NOT NULL",
            "closed_at DATETIME(3) NULL",
        ),
        "unique_constraints": (
            "uk_sandbox_sessions_agent_session_id",
            "uk_sandbox_sessions_workspace_id",
        ),
        "owner_columns": ("org_id", "user_id"),
        "status": "PRESENT",
    },
    {
        "table": "sandbox_executions",
        "repository": "ExecutionRepository",
        "purpose": (
            "Concrete Sandbox tool executions (plan §4.9 kinds). "
            "Distinct from Agent tool_executions (run-scoped tool ledger)."
        ),
        "required_columns": (
            "execution_id CHAR(26) PK",
            "org_id CHAR(26) NOT NULL",
            "user_id CHAR(26) NOT NULL",
            "sandbox_session_id CHAR(26) NOT NULL",
            "run_id CHAR(26) NOT NULL",
            "agent_session_id CHAR(26) NOT NULL",
            "kind VARCHAR(64) NOT NULL",
            "status VARCHAR(32) NOT NULL",
            "exit_code INT NULL",
            "error_code VARCHAR(128) NULL",
            "trace_id CHAR(32) NULL",
            "result_json JSON NULL",
            "started_at DATETIME(3) NULL",
            "completed_at DATETIME(3) NULL",
            "created_at DATETIME(3) NOT NULL",
        ),
        "owner_columns": ("org_id", "user_id"),
        "status": "PRESENT",
    },
    {
        "table": "sandbox_audit_events",
        "repository": "AuditRepository",
        "purpose": (
            "Sandbox-side audit trail for executions / process / path actions. "
            "Not domain_outbox (Redis publish)."
        ),
        "required_columns": (
            "audit_id CHAR(26) PK",
            "org_id CHAR(26) NOT NULL",
            "user_id CHAR(26) NOT NULL",
            "event_type VARCHAR(128) NOT NULL",
            "sandbox_session_id CHAR(26) NULL",
            "execution_id CHAR(26) NULL",
            "process_id CHAR(26) NULL",
            "trace_id CHAR(32) NULL",
            "payload_json JSON NULL",
            "created_at DATETIME(3) NOT NULL",
        ),
        "owner_columns": ("org_id", "user_id"),
        "status": "PRESENT",
    },
    {
        "table": "process_executions",
        "repository": "ProcessRepository",
        "purpose": (
            "Long-running process handles (plan §8.13). Tenant ownership via "
            "org_id/user_id SQL predicates (not Python-only prechecks)."
        ),
        "required_columns": (
            "process_id CHAR(26) PK",
            "org_id CHAR(26) NOT NULL",
            "user_id CHAR(26) NOT NULL",
            "sandbox_session_id CHAR(26) NOT NULL",
            "run_id CHAR(26) NOT NULL",
            "execution_id CHAR(26) NOT NULL",
            "command_json JSON NOT NULL",
            "status VARCHAR(32) NOT NULL",
            "pid INT NULL",
            "exit_code INT NULL",
            "stdout_path VARCHAR(1024) NULL",
            "stderr_path VARCHAR(1024) NULL",
            "started_at DATETIME(3) NULL",
            "ended_at DATETIME(3) NULL",
            "created_at DATETIME(3) NOT NULL",
        ),
        "owner_columns": ("org_id", "user_id"),
        "status": "PRESENT",
    },
    {
        "table": "datasets",
        "repository": "DatasetRepository",
        "purpose": "User datasets streamed into workspace (plan §8.14).",
        "required_columns": (
            "dataset_id CHAR(26) PK",
            "org_id CHAR(26) NOT NULL",
            "user_id CHAR(26) NOT NULL",
            "conversation_id CHAR(26) NOT NULL",
            "agent_session_id CHAR(26) NOT NULL",
            "original_filename VARCHAR(1024) NOT NULL",
            "stored_relative_path VARCHAR(1024) NOT NULL",
            "status VARCHAR(32) NOT NULL",
            "created_at DATETIME(3) NOT NULL",
        ),
        "owner_columns": ("org_id", "user_id"),
        "status": "PRESENT",
    },
    {
        "table": "artifacts",
        "repository": "ArtifactRepository",
        "purpose": "Explicit user-deliverable artifacts (plan §8.15).",
        "required_columns": (
            "artifact_id CHAR(26) PK",
            "org_id CHAR(26) NOT NULL",
            "user_id CHAR(26) NOT NULL",
            "conversation_id CHAR(26) NOT NULL",
            "agent_session_id CHAR(26) NOT NULL",
            "run_id CHAR(26) NOT NULL",
            "relative_path VARCHAR(1024) NOT NULL",
            "relative_path_hash CHAR(64) GENERATED STORED (full-path SHA2)",
            "display_name VARCHAR(1024) NOT NULL",
            "size_bytes BIGINT NOT NULL",
            "sha256 CHAR(64) NOT NULL",
            "status VARCHAR(32) NOT NULL",
            "created_at DATETIME(3) NOT NULL",
            "UNIQUE uk_artifact_file (run_id, relative_path_hash, sha256)",
        ),
        "owner_columns": ("org_id", "user_id"),
        "status": "PRESENT",
    },
)

SCHEMA_CAPABILITY_NOTES: tuple[str, ...] = (
    "All Sandbox execution-domain tables are owned by the Agent Knex migration "
    f"({MIGRATION_FILE}).",
    "agent_sessions.sandbox_session_id and sandbox_sessions.agent_session_id are "
    "logical unique references (no cyclic FK).",
    "PR-07A 1:1 ownership uniques: "
    + ", ".join(AGENT_SANDBOX_OWNERSHIP_UNIQUES)
    + ".",
    "process_executions, sandbox_sessions, sandbox_executions, sandbox_audit_events, "
    "datasets, and artifacts all carry org_id + user_id; repositories must enforce "
    "owner scope via SQL predicates.",
    "artifacts UNIQUE is (run_id, relative_path_hash, sha256) where "
    "relative_path_hash is STORED SHA2 of full relative_path (InnoDB 3072-safe).",
    "Sandbox must not create Conversation/Message/Run repositories; those remain "
    "Agent authority.",
    "Engine/charset: InnoDB + utf8mb4 (utf8mb4_unicode_ci).",
)

# Positive capability document (replaces expected-gap MISSING tables report).
SCHEMA_CAPABILITY: dict[str, Any] = {
    "migration": MIGRATION_FILE,
    "execution_domain_tables": list(EXECUTION_DOMAIN_TABLES),
    "table_specs": list(EXECUTION_DOMAIN_TABLE_SPECS),
    "agent_authority_tables_not_owned_here": list(AGENT_AUTHORITY_TABLES),
    "agent_sandbox_session_relationship": SANDBOX_AGENT_SESSION_RELATIONSHIP,
    "agent_sandbox_ownership_uniques": list(AGENT_SANDBOX_OWNERSHIP_UNIQUES),
    "missing_tables": [],  # PR-02 owns all required Sandbox tables
    "notes": list(SCHEMA_CAPABILITY_NOTES),
}

# Backward-compatible names (gap report is empty — capability is present).
SCHEMA_GAP_MISSING_TABLES: tuple[dict[str, Any], ...] = ()
SCHEMA_GAP_NOTES: tuple[str, ...] = SCHEMA_CAPABILITY_NOTES
SCHEMA_GAP: dict[str, Any] = SCHEMA_CAPABILITY


def report_schema_capability() -> dict[str, Any]:
    """Return a copy of the positive schema capability report."""
    return {
        "migration": SCHEMA_CAPABILITY["migration"],
        "execution_domain_tables": list(SCHEMA_CAPABILITY["execution_domain_tables"]),
        "table_specs": [dict(item) for item in SCHEMA_CAPABILITY["table_specs"]],
        "agent_authority_tables_not_owned_here": list(
            SCHEMA_CAPABILITY["agent_authority_tables_not_owned_here"]
        ),
        "agent_sandbox_session_relationship": SCHEMA_CAPABILITY[
            "agent_sandbox_session_relationship"
        ],
        "agent_sandbox_ownership_uniques": list(
            SCHEMA_CAPABILITY["agent_sandbox_ownership_uniques"]
        ),
        "missing_tables": [],
        "notes": list(SCHEMA_CAPABILITY["notes"]),
        "summary": (
            f"{len(EXECUTION_DOMAIN_TABLES)} execution-domain table(s) present: "
            + ", ".join(EXECUTION_DOMAIN_TABLES)
        ),
        "status": "CAPABLE",
    }


def report_schema_gap() -> dict[str, Any]:
    """Backward-compatible alias — reports capability (no expected gaps)."""
    return report_schema_capability()


def is_table_present(table: str) -> bool:
    return table in EXECUTION_DOMAIN_TABLES


def is_table_schema_gap(table: str) -> bool:
    """No longer expected: PR-02 owns all Sandbox execution-domain tables."""
    return False


def validate_execution_domain_capability(
    present_tables: set[str] | frozenset[str] | list[str],
) -> dict[str, Any]:
    """Validate that all required execution-domain tables are present.

    ``present_tables`` is typically loaded from information_schema (live) or
    from CORE_TABLES_CREATE_ORDER (static/unit).
    """
    present = set(present_tables)
    missing = [t for t in EXECUTION_DOMAIN_TABLES if t not in present]
    return {
        "ok": len(missing) == 0,
        "required": list(EXECUTION_DOMAIN_TABLES),
        "missing": missing,
        "present": sorted(present.intersection(EXECUTION_DOMAIN_TABLES)),
        "relationship": SANDBOX_AGENT_SESSION_RELATIONSHIP,
    }
