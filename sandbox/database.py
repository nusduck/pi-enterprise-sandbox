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
import json
import sqlite3
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

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New conversation',
    sandbox_session_id TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_sandbox_session ON conversations(sandbox_session_id);
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

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New conversation',
    sandbox_session_id TEXT,
    messages TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_sandbox_session ON conversations(sandbox_session_id);
"""


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
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        return conn

    def initialize(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(SQLITE_SCHEMA)
            conn.commit()

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
        import psycopg2

        conn = self._connect_or_create_db()
        if conn is None:
            conn = self.connect()

        with conn:
            with conn.cursor() as cur:
                cur.execute(PG_SCHEMA)
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

    def close(self) -> None:
        self._conn.close()

    def __enter__(self) -> _ConnectionWrapper:
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()


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
