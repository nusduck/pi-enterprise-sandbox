"""SQLite database bootstrap for sandbox persistence."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from urllib.parse import urlparse

from sandbox.config import settings


SCHEMA = """
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
"""


class Database:
    """Small sqlite helper with WAL initialization."""

    def __init__(self, url: str | None = None) -> None:
        self.url = url or settings.database_url
        self.path = self._sqlite_path(self.url)

    @staticmethod
    def _sqlite_path(url: str) -> Path:
        if not url.startswith("sqlite://"):
            raise ValueError(f"Only sqlite database URLs are supported for now: {url}")
        parsed = urlparse(url)
        if parsed.netloc and parsed.path:
            # sqlite:////absolute/path -> path contains absolute path.
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
            conn.executescript(SCHEMA)
            conn.commit()


database = Database()
database.initialize()
