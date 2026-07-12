"""Database bootstrap for sandbox persistence — supports SQLite and PostgreSQL.

Usage::

    # Default SQLite (backward compatible)
    from sandbox.database import database
    database.initialize()

    # Explicit PostgreSQL
    db = Database("postgresql://user:pass@host:5432/sandbox")
    db.initialize()

The :class:`Database` class is a thin wrapper that delegates to the
appropriate backend (SQLiteBackend or PostgreSQLBackend) based on the
URL scheme.
"""

from __future__ import annotations

import abc
import hashlib
import json
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from sandbox.config import settings


# ── Shared schema (SQL strings by dialect) ────────────────────────────────

SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    agent_session_id TEXT,
    enterprise_session_id TEXT,
    user_id TEXT,
    caller_id TEXT NOT NULL DEFAULT 'unknown',
    status TEXT NOT NULL DEFAULT 'RUNNING',
    workspace_path TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ttl_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_session_id ON sessions(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_enterprise_session_id ON sessions(enterprise_session_id);

CREATE TABLE IF NOT EXISTS executions (
    execution_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    run_type TEXT,
    exit_code INTEGER,
    duration_ms REAL DEFAULT 0,
    truncated INTEGER DEFAULT 0,
    stdout_preview TEXT DEFAULT '',
    stderr_preview TEXT DEFAULT '',
    trace_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_session_id ON executions(session_id);
CREATE INDEX IF NOT EXISTS idx_executions_trace_id ON executions(trace_id);

CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER DEFAULT 0,
    source_execution_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    session_id TEXT,
    execution_id TEXT,
    trace_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_session_id ON audit_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_execution_id ON audit_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_audit_trace_id ON audit_logs(trace_id);

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New conversation',
    sandbox_session_id TEXT,
    workspace_path TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    owner_user_id TEXT,
    organization_id TEXT,
    interrupted INTEGER NOT NULL DEFAULT 0,
    last_run_id TEXT,
    legal_hold INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_sandbox_session ON conversations(sandbox_session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(organization_id);

CREATE TABLE IF NOT EXISTS agent_runs (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    owner_user_id TEXT,
    organization_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    lease_owner TEXT,
    lease_until TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    sandbox_session_id TEXT,
    workspace_id TEXT,
    model_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_lease_until ON agent_runs(lease_until);

CREATE TABLE IF NOT EXISTS agent_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_event_id ON agent_events(event_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_id ON agent_events(run_id);

CREATE TABLE IF NOT EXISTS tool_executions (
    tool_call_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    idempotency_key TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_executions_idempotency
    ON tool_executions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tool_executions_run_id ON tool_executions(run_id);

CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    reason TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending_approval',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_session_id ON approvals(session_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    organization_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id);
"""

PG_SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    agent_session_id TEXT,
    enterprise_session_id TEXT,
    user_id TEXT,
    caller_id TEXT NOT NULL DEFAULT 'unknown',
    status TEXT NOT NULL DEFAULT 'RUNNING',
    workspace_path TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    ttl_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent_session_id ON sessions(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_enterprise_session_id ON sessions(enterprise_session_id);

CREATE TABLE IF NOT EXISTS executions (
    execution_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING',
    run_type TEXT,
    exit_code INTEGER,
    duration_ms REAL DEFAULT 0,
    truncated INTEGER DEFAULT 0,
    stdout_preview TEXT DEFAULT '',
    stderr_preview TEXT DEFAULT '',
    trace_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_executions_session_id ON executions(session_id);
CREATE INDEX IF NOT EXISTS idx_executions_trace_id ON executions(trace_id);

CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT,
    size INTEGER DEFAULT 0,
    source_execution_id TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_session_id ON artifacts(session_id);

CREATE TABLE IF NOT EXISTS audit_logs (
    id SERIAL PRIMARY KEY,
    event_type TEXT NOT NULL,
    session_id TEXT,
    execution_id TEXT,
    trace_id TEXT,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_session_id ON audit_logs(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_execution_id ON audit_logs(execution_id);
CREATE INDEX IF NOT EXISTS idx_audit_trace_id ON audit_logs(trace_id);

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New conversation',
    sandbox_session_id TEXT,
    workspace_path TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    owner_user_id TEXT,
    organization_id TEXT,
    interrupted INTEGER NOT NULL DEFAULT 0,
    last_run_id TEXT,
    legal_hold INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_sandbox_session ON conversations(sandbox_session_id);
CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(organization_id);

CREATE TABLE IF NOT EXISTS agent_runs (
    run_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    owner_user_id TEXT,
    organization_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    lease_owner TEXT,
    lease_until TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    sandbox_session_id TEXT,
    workspace_id TEXT,
    model_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status);
CREATE INDEX IF NOT EXISTS idx_agent_runs_lease_until ON agent_runs(lease_until);

CREATE TABLE IF NOT EXISTS agent_events (
    run_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_event_id ON agent_events(event_id);
CREATE INDEX IF NOT EXISTS idx_agent_events_run_id ON agent_events(run_id);

CREATE TABLE IF NOT EXISTS tool_executions (
    tool_call_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'prepared',
    idempotency_key TEXT NOT NULL,
    summary TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_executions_idempotency
    ON tool_executions(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_tool_executions_run_id ON tool_executions(run_id);

CREATE TABLE IF NOT EXISTS approvals (
    approval_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    risk_level TEXT NOT NULL,
    reason TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending_approval',
    created_at TEXT NOT NULL,
    expires_at TEXT,
    decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_session_id ON approvals(session_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',
    organization_id TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id);
"""


# ── Immutable empty-database migrations ─────────────────────────────────

MIGRATION_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
)
"""


class MigrationChecksumError(RuntimeError):
    """An applied migration no longer matches its immutable source."""


@dataclass(frozen=True)
class Migration:
    """One immutable schema migration with optional PostgreSQL SQL."""

    version: str
    sql: str
    pg_sql: str | None = None

    @property
    def checksum(self) -> str:
        payload = f"{self.version}\0{self.sql}\0{self.pg_sql or self.sql}"
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def for_dialect(self, dialect: str) -> str:
        return self.pg_sql if dialect == "postgresql" and self.pg_sql else self.sql


BASELINE_MIGRATION = Migration("0001_baseline", SQLITE_SCHEMA, PG_SCHEMA)

# Pi SDK logical session tables (ADR 0002 §7.1 / Phase 1). Expand-only; never
# mutate BASELINE_MIGRATION (checksum fail-closed once applied).
# Conversation.agent_session_id is added via migrate_agent_session_schema so
# SQLite ALTER stays idempotent with the expand helper.
AGENT_SESSIONS_MIGRATION_SQL = """
CREATE TABLE IF NOT EXISTS agent_sessions (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sdk_session_id TEXT,
    workspace_id TEXT,
    sandbox_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    model_id TEXT,
    thinking_level TEXT,
    system_prompt_version TEXT,
    tool_registry_version TEXT,
    sdk_version TEXT,
    session_schema_version INTEGER NOT NULL DEFAULT 3,
    header_payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_compacted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation
    ON agent_sessions(conversation_id);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_sdk
    ON agent_sessions(sdk_session_id);

CREATE TABLE IF NOT EXISTS agent_session_entries (
    id TEXT PRIMARY KEY,
    agent_session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    entry_type TEXT NOT NULL,
    entry_payload TEXT NOT NULL DEFAULT '{}',
    parent_entry_id TEXT,
    branch_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (agent_session_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_agent_session_entries_session
    ON agent_session_entries(agent_session_id);
CREATE INDEX IF NOT EXISTS idx_agent_session_entries_type
    ON agent_session_entries(agent_session_id, entry_type);
"""

AGENT_SESSIONS_MIGRATION = Migration(
    "0002_agent_sessions",
    AGENT_SESSIONS_MIGRATION_SQL,
)

# B2 Process Manager — managed long-running process ledger (expand-only).
_PROCESS_EXECUTIONS_SQL = """
CREATE TABLE IF NOT EXISTS process_executions (
    process_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    run_id TEXT,
    command TEXT NOT NULL,
    cwd TEXT,
    env_json TEXT,
    status TEXT NOT NULL DEFAULT 'created',
    pid INTEGER,
    exit_code INTEGER,
    background INTEGER NOT NULL DEFAULT 0,
    timeout_seconds INTEGER,
    error TEXT,
    stdout_log TEXT NOT NULL DEFAULT '',
    stderr_log TEXT NOT NULL DEFAULT '',
    log_truncated INTEGER NOT NULL DEFAULT 0,
    log_total INTEGER NOT NULL DEFAULT 0,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    trace_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_process_executions_session_id
    ON process_executions(session_id);
CREATE INDEX IF NOT EXISTS idx_process_executions_run_id
    ON process_executions(run_id);
CREATE INDEX IF NOT EXISTS idx_process_executions_status
    ON process_executions(status);
"""

PROCESS_EXECUTIONS_MIGRATION = Migration(
    "0003_process_executions",
    _PROCESS_EXECUTIONS_SQL,
    _PROCESS_EXECUTIONS_SQL,
)

# B3 Streaming Execution Events — sequenced lifecycle + durable log chunks.
_EXECUTION_EVENTS_SQL = """
CREATE TABLE IF NOT EXISTS execution_events (
    event_id TEXT PRIMARY KEY,
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    run_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (source_type, source_id, sequence)
);
CREATE INDEX IF NOT EXISTS idx_execution_events_source
    ON execution_events(source_type, source_id, sequence);
CREATE INDEX IF NOT EXISTS idx_execution_events_run_id
    ON execution_events(run_id);

CREATE TABLE IF NOT EXISTS execution_log_chunks (
    source_type TEXT NOT NULL,
    source_id TEXT NOT NULL,
    stream TEXT NOT NULL,
    offset_start INTEGER NOT NULL,
    data TEXT NOT NULL,
    char_len INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (source_type, source_id, stream, offset_start)
);
CREATE INDEX IF NOT EXISTS idx_execution_log_chunks_source
    ON execution_log_chunks(source_type, source_id, offset_start);
"""

EXECUTION_EVENTS_MIGRATION = Migration(
    "0004_execution_events",
    _EXECUTION_EVENTS_SQL,
    _EXECUTION_EVENTS_SQL,
)

# B4 Tool Ledger Completion — expand tool_executions with ADR §4.4 fields.
# Expand-only ALTERs; never mutate BASELINE_MIGRATION (checksum fail-closed).
_TOOL_LEDGER_COLUMNS_SQL = """
ALTER TABLE tool_executions ADD COLUMN session_id TEXT;
ALTER TABLE tool_executions ADD COLUMN conversation_id TEXT;
ALTER TABLE tool_executions ADD COLUMN workspace_id TEXT;
ALTER TABLE tool_executions ADD COLUMN tool_name TEXT;
ALTER TABLE tool_executions ADD COLUMN arguments TEXT;
ALTER TABLE tool_executions ADD COLUMN execution_id TEXT;
ALTER TABLE tool_executions ADD COLUMN started_at TEXT;
ALTER TABLE tool_executions ADD COLUMN finished_at TEXT;
ALTER TABLE tool_executions ADD COLUMN result_summary TEXT;
ALTER TABLE tool_executions ADD COLUMN error TEXT;
ALTER TABLE tool_executions ADD COLUMN result_json TEXT;
"""

TOOL_LEDGER_MIGRATION = Migration(
    "0005_tool_ledger_fields",
    _TOOL_LEDGER_COLUMNS_SQL,
    _TOOL_LEDGER_COLUMNS_SQL,
)

# B6 Runtime Interaction — budget + recoverable approval payload on agent_runs.
_B6_RUN_COLUMNS_SQL = """
ALTER TABLE agent_runs ADD COLUMN budget_json TEXT;
ALTER TABLE agent_runs ADD COLUMN pending_approval_json TEXT;
"""

B6_RUNTIME_MIGRATION = Migration(
    "0006_b6_runtime_interaction",
    _B6_RUN_COLUMNS_SQL,
    _B6_RUN_COLUMNS_SQL,
)

_AGENT_RUN_USAGE_SQL = """
ALTER TABLE agent_runs ADD COLUMN usage TEXT;
"""

AGENT_RUN_USAGE_MIGRATION = Migration(
    "0007_agent_run_usage",
    _AGENT_RUN_USAGE_SQL,
    _AGENT_RUN_USAGE_SQL,
)


MIGRATIONS: tuple[Migration, ...] = (
    BASELINE_MIGRATION,
    AGENT_SESSIONS_MIGRATION,
    PROCESS_EXECUTIONS_MIGRATION,
    EXECUTION_EVENTS_MIGRATION,
    TOOL_LEDGER_MIGRATION,
    B6_RUNTIME_MIGRATION,
    AGENT_RUN_USAGE_MIGRATION,
)



# ── Abstract backend ──────────────────────────────────────────────────────

class DatabaseBackend(abc.ABC):
    """Abstract interface for a database backend."""

    @abc.abstractmethod
    def connect(self) -> Any:
        """Return a database connection."""

    @abc.abstractmethod
    def initialize(self) -> None:
        """Create all tables and indexes."""

    @abc.abstractmethod
    def param_style(self) -> str:
        """Return the parameter placeholder style (``?`` or ``%s``)."""

    @abc.abstractmethod
    def upsert_suffix(self, table: str, pk_column: str, columns: list[str]) -> str:
        """Return the ON CONFLICT / ON DUPLICATE suffix for an upsert."""

    @abc.abstractmethod
    def cast_bool(self, value: bool | int) -> Any:
        """Cast a Python bool to the backend-native type."""

    @abc.abstractmethod
    def parse_bool(self, value: Any) -> bool:
        """Parse a backend-native boolean back to Python bool."""


# ── SQLite backend ────────────────────────────────────────────────────────

class SQLiteBackend(DatabaseBackend):
    """SQLite database backend using the built-in ``sqlite3`` module."""

    def __init__(self, url: str) -> None:
        self.url = url
        self.path = self._sqlite_path(url)

    @staticmethod
    def _sqlite_path(url: str) -> Path:
        if not url.startswith("sqlite://"):
            raise ValueError(f"Only sqlite database URLs are supported for now: {url}")
        parsed = urlparse(url)
        if parsed.netloc and parsed.path:
            raw_path = parsed.path
        else:
            raw_path = url.removeprefix("sqlite:///")
        return Path(raw_path)

    def connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # timeout allows concurrent writers to wait on BEGIN IMMEDIATE locks
        conn = sqlite3.connect(self.path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = self.connect()
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("BEGIN IMMEDIATE")
            wrapped = _ConnectionWrapper(conn, self)
            apply_migrations(wrapped, dialect="sqlite")
            # Expand-safe columns/tables for DBs that predate versioned migrations
            migrate_agent_session_schema(wrapped, dialect="sqlite")
            migrate_process_schema(wrapped, dialect="sqlite")
            migrate_execution_events_schema(wrapped, dialect="sqlite")
            migrate_tool_ledger_schema(wrapped, dialect="sqlite")
            migrate_b6_runtime_schema(wrapped, dialect="sqlite")
            migrate_agent_run_usage_schema(wrapped, dialect="sqlite")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def param_style(self) -> str:
        return "?"

    def upsert_suffix(self, table: str, pk_column: str, columns: list[str]) -> str:
        col_set = ", ".join(f"{c}=excluded.{c}" for c in columns)
        return f"ON CONFLICT({pk_column}) DO UPDATE SET {col_set}"

    def cast_bool(self, value: bool | int) -> int:
        return 1 if value else 0

    def parse_bool(self, value: Any) -> bool:
        return bool(value)


# ── PostgreSQL backend ────────────────────────────────────────────────────

class PostgreSQLBackend(DatabaseBackend):
    """PostgreSQL database backend using ``psycopg2``."""

    def __init__(self, url: str) -> None:
        self.url = url

    def _connection_params(self) -> dict[str, Any]:
        """Parse a ``postgresql://`` URL into psycopg2 connection params."""
        parsed = urlparse(self.url)
        return {
            "host": parsed.hostname or "localhost",
            "port": parsed.port or 5432,
            "dbname": parsed.path.lstrip("/") if parsed.path else "sandbox",
            "user": parsed.username or "postgres",
            "password": parsed.password or "",
        }

    def connect(self):
        import psycopg2
        import psycopg2.extras

        params = self._connection_params()
        conn = psycopg2.connect(
            **params, cursor_factory=psycopg2.extras.RealDictCursor
        )
        conn.autocommit = False
        # Return dict-like rows so row["column_name"] works everywhere
        return conn

    def initialize(self) -> None:
        conn = self._connect_or_create_db()
        if conn is None:
            conn = self.connect()
        try:
            wrapped = _ConnectionWrapper(conn, self)
            apply_migrations(wrapped, dialect="postgresql")
            migrate_agent_session_schema(wrapped, dialect="postgresql")
            migrate_process_schema(wrapped, dialect="postgresql")
            migrate_execution_events_schema(wrapped, dialect="postgresql")
            migrate_tool_ledger_schema(wrapped, dialect="postgresql")
            migrate_b6_runtime_schema(wrapped, dialect="postgresql")
            migrate_agent_run_usage_schema(wrapped, dialect="postgresql")
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _connect_or_create_db(self):
        """Try to connect; if the database doesn't exist, create it."""
        import psycopg2

        try:
            return self.connect()
        except psycopg2.OperationalError:
            pass

        params = self._connection_params()
        dbname = params.pop("dbname", "sandbox")
        params["dbname"] = "postgres"
        try:
            admin_conn = psycopg2.connect(**params)
            admin_conn.autocommit = True
            with admin_conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM pg_database WHERE datname = %s", (dbname,)
                )
                if not cur.fetchone():
                    cur.execute(f'CREATE DATABASE "{dbname}" ENCODING "UTF8"')
            admin_conn.close()
        except Exception:
            return None  # best-effort; caller can create DB manually
        return None  # caller should retry connect()

    def param_style(self) -> str:
        return "%s"

    def upsert_suffix(self, table: str, pk_column: str, columns: list[str]) -> str:
        col_set = ", ".join(f"{c}=EXCLUDED.{c}" for c in columns)
        return f"ON CONFLICT({pk_column}) DO UPDATE SET {col_set}"

    def cast_bool(self, value: bool | int) -> bool:
        return bool(value)

    def parse_bool(self, value: Any) -> bool:
        return bool(value)


# ── Factory ───────────────────────────────────────────────────────────────

def create_backend(url: str) -> DatabaseBackend:
    """Return the appropriate backend implementation for *url*."""
    if url.startswith("sqlite://"):
        return SQLiteBackend(url)
    if url.startswith("postgresql://") or url.startswith("postgres://"):
        return PostgreSQLBackend(url)
    raise ValueError(
        f"Unsupported database URL scheme: {url}. "
        f"Expected sqlite://... or postgresql://..."
    )


# ── Connection wrapper (normalises sqlite3 / psycopg2 APIs) ─────────────

class _ConnectionWrapper:
    """Wraps a raw DB-API connection so repositories use a single API."""

    def __init__(self, conn: Any, backend: DatabaseBackend) -> None:
        self._conn = conn
        self._backend = backend

    def execute(self, sql: str, params: tuple | None = None) -> Any:
        """Execute SQL and return a cursor-like object.

        Repositories use ``?`` placeholders throughout; PostgreSQL uses
        ``%s``, so the wrapper performs the translation automatically.
        """
        if params is None:
            params = ()
        if isinstance(self._backend, PostgreSQLBackend):
            # Translate ? → %s for psycopg2
            pg_sql = sql.replace("?", "%s")
            cur = self._conn.cursor()
            cur.execute(pg_sql, params)
            return cur
        # SQLite — Connection.execute() returns a Cursor directly
        return self._conn.execute(sql, params)

    def executescript(self, script: str) -> None:
        """Execute a multi-statement script (SQLite only; no-op on PG)."""
        if isinstance(self._backend, SQLiteBackend):
            self._conn.executescript(script)
        else:
            with self._conn.cursor() as cur:
                for statement in script.split(";"):
                    stmt = statement.strip()
                    if stmt:
                        cur.execute(stmt + ";")

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()

    def close(self) -> None:
        self._conn.close()

    @property
    def backend(self) -> DatabaseBackend:
        return self._backend

    def __enter__(self) -> _ConnectionWrapper:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


def _row_value(row: Any, key: str, index: int = 0) -> Any:
    try:
        return row[key]
    except (KeyError, IndexError, TypeError):
        return row[index]


def _execute_statements(conn: _ConnectionWrapper, script: str) -> None:
    """Execute simple schema SQL without SQLite ``executescript`` auto-commit."""
    for statement in script.split(";"):
        sql = statement.strip()
        if sql:
            conn.execute(sql)


def apply_migrations(
    conn: _ConnectionWrapper,
    *,
    dialect: str,
    migrations: tuple[Migration, ...] | None = None,
) -> None:
    """Apply immutable migrations inside the caller-owned transaction."""
    selected = MIGRATIONS if migrations is None else migrations
    versions = [migration.version for migration in selected]
    if len(versions) != len(set(versions)):
        raise ValueError("migration versions must be unique")

    conn.execute(MIGRATION_TABLE_SQL)
    for migration in selected:
        row = conn.execute(
            "SELECT checksum FROM schema_migrations WHERE version = ?",
            (migration.version,),
        ).fetchone()
        if row is not None:
            actual = str(_row_value(row, "checksum"))
            if actual != migration.checksum:
                raise MigrationChecksumError(
                    f"migration {migration.version} checksum mismatch: "
                    f"database={actual} source={migration.checksum}"
                )
            continue

        _execute_statements(conn, migration.for_dialect(dialect))
        conn.execute(
            "INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)",
            (
                migration.version,
                migration.checksum,
                datetime.now(timezone.utc).isoformat(),
            ),
        )


# ── Ownership schema migration (dual dialect) ─────────────────────────────

def _table_columns(conn: Any, table: str, dialect: str) -> set[str]:
    """Return existing column names for *table*."""
    if dialect == "sqlite":
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        # sqlite3.Row supports both index and key access
        cols: set[str] = set()
        for row in rows:
            try:
                cols.add(row["name"])
            except (KeyError, IndexError, TypeError):
                cols.add(row[1])
        return cols
    # PostgreSQL
    rows = conn.execute(
        """
        SELECT column_name FROM information_schema.columns
        WHERE table_name = ? AND table_schema = 'public'
        """,
        (table,),
    ).fetchall()
    cols = set()
    for row in rows:
        try:
            cols.add(row["column_name"])
        except (KeyError, IndexError, TypeError):
            cols.add(row[0])
    return cols


def _count_scalar(conn: Any, sql: str, params: tuple = ()) -> int:
    row = conn.execute(sql, params).fetchone()
    if row is None:
        return 0
    try:
        return int(row[0])
    except (KeyError, IndexError, TypeError):
        # RealDictCursor single-column row
        return int(next(iter(dict(row).values())))


def migrate_ownership_schema(conn: Any, dialect: str = "sqlite") -> dict[str, int]:
    """Ensure org/ownership columns exist, seed bootstrap, backfill null owners.

    Safe to run repeatedly. Returns a small report with orphan counts before/after.
    """
    from datetime import datetime, timezone

    from sandbox.security.ownership import (
        BOOTSTRAP_ORG_ID,
        BOOTSTRAP_ORG_NAME,
        BOOTSTRAP_USER_ID,
    )

    now = datetime.now(timezone.utc).isoformat()
    report = {"orphans_before": 0, "orphans_after": 0, "backfilled": 0}

    # organizations table (CREATE IF NOT EXISTS already in schema; re-run for old DBs)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS organizations (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
        """
    )

    # conversations ownership columns
    conv_cols = _table_columns(conn, "conversations", dialect)
    if "owner_user_id" not in conv_cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN owner_user_id TEXT")
    if "organization_id" not in conv_cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN organization_id TEXT")

    # users.organization_id
    user_cols = _table_columns(conn, "users", dialect)
    if "organization_id" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN organization_id TEXT")

    # Indexes (IF NOT EXISTS)
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_owner ON conversations(owner_user_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations(organization_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id)"
    )

    # Bootstrap org
    conn.execute(
        """
        INSERT INTO organizations (id, name, created_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO NOTHING
        """,
        (BOOTSTRAP_ORG_ID, BOOTSTRAP_ORG_NAME, now),
    )

    # Bootstrap user (inactive password; used only for legacy ownership binding)
    existing = conn.execute(
        "SELECT id FROM users WHERE id = ?", (BOOTSTRAP_USER_ID,)
    ).fetchone()
    if not existing:
        # password_hash is a non-login placeholder
        conn.execute(
            """
            INSERT INTO users (
                id, username, email, password_hash, display_name,
                role, organization_id, is_active, created_at, updated_at, last_login_at
            ) VALUES (?, ?, NULL, ?, ?, 'admin', ?, 0, ?, ?, NULL)
            """,
            (
                BOOTSTRAP_USER_ID,
                "bootstrap",
                "bootstrap-disabled",
                "Bootstrap",
                BOOTSTRAP_ORG_ID,
                now,
                now,
            ),
        )

    # Backfill users without organization_id
    conn.execute(
        "UPDATE users SET organization_id = ? WHERE organization_id IS NULL OR organization_id = ''",
        (BOOTSTRAP_ORG_ID,),
    )

    # Count orphans before backfill
    report["orphans_before"] = _count_scalar(
        conn,
        """
        SELECT COUNT(*) FROM conversations
        WHERE owner_user_id IS NULL OR owner_user_id = ''
        """,
    )

    if report["orphans_before"]:
        conn.execute(
            """
            UPDATE conversations
            SET owner_user_id = ?, organization_id = ?
            WHERE owner_user_id IS NULL OR owner_user_id = ''
            """,
            (BOOTSTRAP_USER_ID, BOOTSTRAP_ORG_ID),
        )
        report["backfilled"] = report["orphans_before"]

    # Also fill org when owner is set but org is missing
    conn.execute(
        """
        UPDATE conversations
        SET organization_id = ?
        WHERE organization_id IS NULL OR organization_id = ''
        """,
        (BOOTSTRAP_ORG_ID,),
    )

    report["orphans_after"] = _count_scalar(
        conn,
        """
        SELECT COUNT(*) FROM conversations
        WHERE owner_user_id IS NULL OR owner_user_id = ''
        """,
    )
    return report


def count_conversation_orphans(db: "Database | None" = None) -> int:
    """Return count of conversations still missing owner_user_id."""
    target = db or database
    with target.connect() as conn:
        return _count_scalar(
            conn,
            """
            SELECT COUNT(*) FROM conversations
            WHERE owner_user_id IS NULL OR owner_user_id = ''
            """,
        )


def migrate_agent_session_schema(conn: Any, dialect: str = "sqlite") -> dict[str, int]:
    """Ensure agent session tables/columns exist (expand-only, dual dialect).

    Safe to run repeatedly. Creates agent_runs / agent_events / tool_executions /
    agent_sessions / agent_session_entries if missing and ALTERs conversations for
    interrupted / last_run_id / legal_hold / agent_session_id.
    """
    report = {"tables_ensured": 0, "columns_added": 0}

    # Conversation optional columns
    conv_cols = _table_columns(conn, "conversations", dialect)
    if "interrupted" not in conv_cols:
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0"
        )
        report["columns_added"] += 1
    if "last_run_id" not in conv_cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN last_run_id TEXT")
        report["columns_added"] += 1
    if "legal_hold" not in conv_cols:
        conn.execute(
            "ALTER TABLE conversations ADD COLUMN legal_hold INTEGER NOT NULL DEFAULT 0"
        )
        report["columns_added"] += 1
    if "agent_session_id" not in conv_cols:
        conn.execute("ALTER TABLE conversations ADD COLUMN agent_session_id TEXT")
        report["columns_added"] += 1
    # Index is safe to re-create
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_conversations_agent_session "
        "ON conversations(agent_session_id)"
    )

    # agent_runs
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_runs (
            run_id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            owner_user_id TEXT,
            organization_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            lease_owner TEXT,
            lease_until TEXT,
            version INTEGER NOT NULL DEFAULT 0,
            sandbox_session_id TEXT,
            workspace_id TEXT,
            model_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_conversation ON agent_runs(conversation_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_status ON agent_runs(status)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_runs_lease_until ON agent_runs(lease_until)"
    )
    report["tables_ensured"] += 1

    # agent_events (append-only, unique sequence per run)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_events (
            run_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_id TEXT NOT NULL,
            type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            schema_version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            PRIMARY KEY (run_id, sequence)
        )
        """
    )
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_event_id ON agent_events(event_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_events_run_id ON agent_events(run_id)"
    )
    report["tables_ensured"] += 1

    # tool_executions ledger
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_executions (
            tool_call_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'prepared',
            idempotency_key TEXT NOT NULL,
            summary TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_executions_idempotency
            ON tool_executions(idempotency_key)
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_executions_run_id ON tool_executions(run_id)"
    )
    report["tables_ensured"] += 1

    # Logical Pi SDK agent sessions (ADR 0002 §7.1)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_sessions (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            sdk_session_id TEXT,
            workspace_id TEXT,
            sandbox_session_id TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            model_id TEXT,
            thinking_level TEXT,
            system_prompt_version TEXT,
            tool_registry_version TEXT,
            sdk_version TEXT,
            session_schema_version INTEGER NOT NULL DEFAULT 3,
            header_payload TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            last_compacted_at TEXT
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_conversation "
        "ON agent_sessions(conversation_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_sessions_sdk "
        "ON agent_sessions(sdk_session_id)"
    )
    report["tables_ensured"] += 1

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_session_entries (
            id TEXT PRIMARY KEY,
            agent_session_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            entry_type TEXT NOT NULL,
            entry_payload TEXT NOT NULL DEFAULT '{}',
            parent_entry_id TEXT,
            branch_id TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (agent_session_id, sequence)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_session_entries_session "
        "ON agent_session_entries(agent_session_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_session_entries_type "
        "ON agent_session_entries(agent_session_id, entry_type)"
    )
    report["tables_ensured"] += 1

    return report


def migrate_process_schema(conn: Any, dialect: str = "sqlite") -> dict[str, int]:
    """Ensure process_executions table exists (expand-only, dual dialect).

    Safe to run repeatedly. Complements immutable migration
    ``0003_process_executions`` for older DBs that only ran expand migrations.
    """
    report = {"tables_ensured": 0}
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS process_executions (
            process_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            run_id TEXT,
            command TEXT NOT NULL,
            cwd TEXT,
            env_json TEXT,
            status TEXT NOT NULL DEFAULT 'created',
            pid INTEGER,
            exit_code INTEGER,
            background INTEGER NOT NULL DEFAULT 0,
            timeout_seconds INTEGER,
            error TEXT,
            stdout_log TEXT NOT NULL DEFAULT '',
            stderr_log TEXT NOT NULL DEFAULT '',
            log_truncated INTEGER NOT NULL DEFAULT 0,
            log_total INTEGER NOT NULL DEFAULT 0,
            started_at TEXT,
            finished_at TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            trace_id TEXT
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_process_executions_session_id
            ON process_executions(session_id)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_process_executions_run_id
            ON process_executions(run_id)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_process_executions_status
            ON process_executions(status)
        """
    )
    report["tables_ensured"] += 1
    return report


def migrate_execution_events_schema(conn: Any, dialect: str = "sqlite") -> dict[str, int]:
    """Ensure execution_events + execution_log_chunks (B3, expand-only)."""
    report = {"tables_ensured": 0}
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS execution_events (
            event_id TEXT PRIMARY KEY,
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            sequence INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL DEFAULT '{}',
            run_id TEXT,
            created_at TEXT NOT NULL,
            UNIQUE (source_type, source_id, sequence)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_execution_events_source
            ON execution_events(source_type, source_id, sequence)
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_execution_events_run_id
            ON execution_events(run_id)
        """
    )
    report["tables_ensured"] += 1
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS execution_log_chunks (
            source_type TEXT NOT NULL,
            source_id TEXT NOT NULL,
            stream TEXT NOT NULL,
            offset_start INTEGER NOT NULL,
            data TEXT NOT NULL,
            char_len INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (source_type, source_id, stream, offset_start)
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_execution_log_chunks_source
            ON execution_log_chunks(source_type, source_id, offset_start)
        """
    )
    report["tables_ensured"] += 1
    return report


# ADR §4.4 ledger fields added after baseline thin tool_executions table.
_TOOL_LEDGER_EXPAND_COLUMNS: tuple[str, ...] = (
    "session_id",
    "conversation_id",
    "workspace_id",
    "tool_name",
    "arguments",
    "execution_id",
    "started_at",
    "finished_at",
    "result_summary",
    "error",
    "result_json",
)


def migrate_tool_ledger_schema(conn: Any, dialect: str = "sqlite") -> dict[str, int]:
    """Ensure tool_executions ADR §4.4 columns exist (expand-only, dual dialect).

    Safe to run repeatedly. Complements immutable migration
    ``0005_tool_ledger_fields`` for DBs that only ran expand helpers.
    """
    report = {"columns_added": 0, "tables_ensured": 0}
    # Ensure base table exists (thin schema)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS tool_executions (
            tool_call_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'prepared',
            idempotency_key TEXT NOT NULL,
            summary TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_tool_executions_idempotency
            ON tool_executions(idempotency_key)
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_executions_run_id ON tool_executions(run_id)"
    )
    report["tables_ensured"] += 1

    cols = _table_columns(conn, "tool_executions", dialect)
    for col in _TOOL_LEDGER_EXPAND_COLUMNS:
        if col not in cols:
            conn.execute(f"ALTER TABLE tool_executions ADD COLUMN {col} TEXT")
            report["columns_added"] += 1
    return report


_B6_RUN_EXPAND_COLUMNS = (
    "budget_json",
    "pending_approval_json",
)


def migrate_b6_runtime_schema(conn: Any, dialect: str = "sqlite") -> dict[str, int]:
    """Ensure agent_runs B6 columns (budget + pending approval) exist.

    Expand-only; safe to run repeatedly. Complements ``0006_b6_runtime_interaction``.
    """
    report = {"columns_added": 0}
    cols = _table_columns(conn, "agent_runs", dialect)
    if not cols:
        return report
    for col in _B6_RUN_EXPAND_COLUMNS:
        if col not in cols:
            conn.execute(f"ALTER TABLE agent_runs ADD COLUMN {col} TEXT")
            report["columns_added"] += 1
    return report


def migrate_agent_run_usage_schema(conn: Any, dialect: str = "sqlite") -> dict[str, int]:
    """Ensure agent_runs.usage column exists (expand-only, dual dialect).

    Safe to run repeatedly. Complements immutable migration
    ``0007_agent_run_usage`` for DBs that only ran expand helpers.
    """
    report = {"columns_added": 0, "tables_ensured": 0}
    # Ensure base table exists (thin schema from agent session migrate)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_runs (
            run_id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            owner_user_id TEXT,
            organization_id TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            lease_owner TEXT,
            lease_until TEXT,
            version INTEGER NOT NULL DEFAULT 0,
            sandbox_session_id TEXT,
            workspace_id TEXT,
            model_id TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
        """
    )
    report["tables_ensured"] += 1
    cols = _table_columns(conn, "agent_runs", dialect)
    if "usage" not in cols:
        conn.execute("ALTER TABLE agent_runs ADD COLUMN usage TEXT")
        report["columns_added"] += 1
    return report




# ── Database wrapper (backward-compatible) ────────────────────────────────

class Database:
    """Small database helper supporting SQLite and PostgreSQL.

    Accepts **sqlite://** or **postgresql://** URLs.

    Usage::

        db = Database()
        db.initialize()
        with db.connect() as conn:
            conn.execute(...)
    """

    def __init__(self, url: str | None = None) -> None:
        self.url = url or settings.database_url
        self._backend = create_backend(self.url)

    @property
    def backend(self) -> DatabaseBackend:
        """Expose the underlying backend for advanced use."""
        return self._backend

    # ── Delegated properties (backward compat shims) ─────────────────────

    @property
    def path(self) -> Path | None:
        """SQLite database file path (None for PostgreSQL)."""
        if isinstance(self._backend, SQLiteBackend):
            return self._backend.path
        return None

    # ── Delegated methods ────────────────────────────────────────────────

    def connect(self) -> _ConnectionWrapper:
        """Open a connection via the active backend, wrapped in a uniform API."""
        raw = self._backend.connect()
        return _ConnectionWrapper(raw, self._backend)

    def initialize(self) -> None:
        """Create all tables and indexes via the active backend."""
        self._backend.initialize()

    def migrate_ownership(self) -> dict[str, int]:
        """Run ownership migration / backfill; return orphan report."""
        dialect = (
            "sqlite"
            if isinstance(self._backend, SQLiteBackend)
            else "postgresql"
        )
        with self.connect() as conn:
            report = migrate_ownership_schema(conn, dialect=dialect)
            conn.commit()
        return report

    def migrate_agent_session(self) -> dict[str, int]:
        """Run agent session schema expand migration; return report."""
        dialect = (
            "sqlite"
            if isinstance(self._backend, SQLiteBackend)
            else "postgresql"
        )
        with self.connect() as conn:
            report = migrate_agent_session_schema(conn, dialect=dialect)
            conn.commit()
        return report

    def migrate_process(self) -> dict[str, int]:
        """Run process_executions expand migration; return report."""
        dialect = (
            "sqlite"
            if isinstance(self._backend, SQLiteBackend)
            else "postgresql"
        )
        with self.connect() as conn:
            report = migrate_process_schema(conn, dialect=dialect)
            conn.commit()
        return report

    def migrate_execution_events(self) -> dict[str, int]:
        """Run execution_events / log_chunks expand migration; return report."""
        dialect = (
            "sqlite"
            if isinstance(self._backend, SQLiteBackend)
            else "postgresql"
        )
        with self.connect() as conn:
            report = migrate_execution_events_schema(conn, dialect=dialect)
            conn.commit()
        return report

    def migrate_tool_ledger(self) -> dict[str, int]:
        """Run tool_executions ADR field expand migration; return report."""
        dialect = (
            "sqlite"
            if isinstance(self._backend, SQLiteBackend)
            else "postgresql"
        )
        with self.connect() as conn:
            report = migrate_tool_ledger_schema(conn, dialect=dialect)
            conn.commit()
        return report

    def migrate_b6_runtime(self) -> dict[str, int]:
        """Run B6 runtime interaction expand migration; return report."""
        dialect = (
            "sqlite"
            if isinstance(self._backend, SQLiteBackend)
            else "postgresql"
        )
        with self.connect() as conn:
            report = migrate_b6_runtime_schema(conn, dialect=dialect)
            conn.commit()
        return report

    def migrate_agent_run_usage(self) -> dict[str, int]:
        """Run agent_runs.usage expand migration; return report."""
        dialect = (
            "sqlite"
            if isinstance(self._backend, SQLiteBackend)
            else "postgresql"
        )
        with self.connect() as conn:
            report = migrate_agent_run_usage_schema(conn, dialect=dialect)
            conn.commit()
        return report


    # ── Convenience helpers ──────────────────────────────────────────────

    @staticmethod
    def _json_dumps(value: Any) -> str:
        return json.dumps(value, ensure_ascii=False, default=str)

    @staticmethod
    def _json_loads(value: str | None) -> Any:
        if not value:
            return {}
        return json.loads(value)


# ── Module-level singleton ────────────────────────────────────────────────

database = Database()
database.initialize()
