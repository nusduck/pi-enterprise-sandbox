"""PyMySQL-only database adapter for Sandbox execution domain.

Strict ``mysql://`` and ``mysql+pymysql://`` DSNs (aligned with
``sandbox.config`` / compose). Both normalize to PyMySQL connect kwargs.
Rejects mysql2 / mysql+other / sqlite / postgres / bare DSNs.
Error messages never echo credentials or full DSNs.

No DDL is performed by this module. Connections carry connect/read/write
timeouts and a hard concurrent-open bound. ``ping`` is passive (no silent
reconnect fallback).
"""

from __future__ import annotations

import re
import threading
from contextlib import contextmanager
from typing import Any, Iterator, Protocol, Sequence
from urllib.parse import unquote, urlparse

from sandbox.app.persistence.errors import MysqlConfigError, MysqlDependencyError

# Accepted formal schemes (compose uses mysql+pymysql://; bare mysql:// also ok).
_MYSQL_SCHEMES = frozenset({"mysql", "mysql+pymysql"})

# Safe defaults — overridden by Settings / MysqlDatabase kwargs.
_DEFAULT_CONNECT_TIMEOUT = 5
_DEFAULT_READ_TIMEOUT = 30
_DEFAULT_WRITE_TIMEOUT = 30
_DEFAULT_MAX_CONNECTIONS = 8


def describe_rejected_mysql_url(normalized: str) -> str:
    """Classify a rejected URL without echoing credentials."""
    lower = normalized.lower()
    # Require :// so bare "user:pass@host" is not misread as scheme=user.
    scheme_match = re.match(r"^([a-z][a-z0-9+.-]*)://", lower)
    if scheme_match:
        return f"scheme={scheme_match.group(1)}"
    if "@" in normalized:
        return "bare-credential-string"
    return "bare-string"


def assert_mysql_connection_url(url: str | None) -> str:
    """Strict MySQL DSN gate: only ``mysql://`` or ``mysql+pymysql://``.

    Rejects empty, sqlite, postgres, mysql2://, other mysql+… dialects, and bare
    user:pass@host. Error messages never include the full URL (credential leak).
    """
    if url is None or str(url).strip() == "":
        raise MysqlConfigError(
            "MySQL connection URL is required (set TEST_MYSQL_URL or "
            "SANDBOX_MYSQL_URL / SANDBOX_DATABASE_URL). Only mysql:// or "
            "mysql+pymysql:// are accepted; SQLite, PostgreSQL, and in-memory "
            "stores are not supported."
        )
    normalized = str(url).strip()
    lower = normalized.lower()

    if lower.startswith("mysql://") or lower.startswith("mysql+pymysql://"):
        parsed = urlparse(normalized)
        scheme = (parsed.scheme or "").lower()
        if scheme not in _MYSQL_SCHEMES:
            kind = describe_rejected_mysql_url(normalized)
            raise MysqlConfigError(
                f"Unsupported database URL for Sandbox MySQL ({kind}). "
                "Only mysql:// or mysql+pymysql:// with a host are accepted."
            )
        if not parsed.hostname:
            kind = describe_rejected_mysql_url(normalized)
            raise MysqlConfigError(
                f"Unsupported database URL for Sandbox MySQL ({kind}). "
                "Only mysql:// or mysql+pymysql:// with a host are accepted."
            )
        return normalized

    kind = describe_rejected_mysql_url(normalized)
    raise MysqlConfigError(
        f"Unsupported database URL for Sandbox MySQL ({kind}). "
        "Only mysql:// or mysql+pymysql:// are accepted; mysql2://, other "
        "mysql+, PostgreSQL, SQLite, and bare DSNs are rejected."
    )


def load_pymysql():
    """Import PyMySQL at runtime so unit tests need not install the driver."""
    try:
        import pymysql  # type: ignore[import-untyped]
        import pymysql.cursors  # type: ignore[import-untyped]
    except ImportError as err:
        raise MysqlDependencyError(
            'Package "PyMySQL" is not installed. Install PyMySQL to use the '
            "Sandbox MySQL adapter (unit tests inject a fake connection).",
            cause=err,
        ) from err
    return pymysql, pymysql.cursors


def parse_mysql_url(
    url: str,
    *,
    connect_timeout: int = _DEFAULT_CONNECT_TIMEOUT,
    read_timeout: int = _DEFAULT_READ_TIMEOUT,
    write_timeout: int = _DEFAULT_WRITE_TIMEOUT,
) -> dict[str, Any]:
    """Parse a validated MySQL URL into PyMySQL connect kwargs.

    Both ``mysql://`` and ``mysql+pymysql://`` normalize to the same kwargs.
    Password is kept only in the returned dict for connect(); callers must not
    log the result.
    """
    validated = assert_mysql_connection_url(url)
    parsed = urlparse(validated)
    scheme = (parsed.scheme or "").lower()
    if scheme not in _MYSQL_SCHEMES:
        kind = describe_rejected_mysql_url(validated)
        raise MysqlConfigError(
            f"Unsupported database URL for Sandbox MySQL ({kind}). "
            "Only mysql:// or mysql+pymysql:// are accepted."
        )
    database = (parsed.path or "").lstrip("/")
    if not database:
        raise MysqlConfigError(
            "MySQL connection URL must include a database name path "
            "(mysql://user@host:3306/dbname or mysql+pymysql://…)."
        )
    if type(connect_timeout) is not int or isinstance(connect_timeout, bool) or connect_timeout < 1:
        raise MysqlConfigError("connect_timeout must be a positive integer")
    if type(read_timeout) is not int or isinstance(read_timeout, bool) or read_timeout < 1:
        raise MysqlConfigError("read_timeout must be a positive integer")
    if type(write_timeout) is not int or isinstance(write_timeout, bool) or write_timeout < 1:
        raise MysqlConfigError("write_timeout must be a positive integer")

    port = parsed.port or 3306
    user = unquote(parsed.username) if parsed.username else None
    password = unquote(parsed.password) if parsed.password is not None else ""
    return {
        "host": parsed.hostname,
        "port": int(port),
        "user": user,
        "password": password,
        "database": database,
        "charset": "utf8mb4",
        "autocommit": False,
        "connect_timeout": int(connect_timeout),
        "read_timeout": int(read_timeout),
        "write_timeout": int(write_timeout),
    }


class DbConnection(Protocol):
    """Minimal connection protocol used by repositories (real or fake)."""

    def execute(
        self,
        sql: str,
        params: Sequence[Any] | None = None,
    ) -> Any: ...

    def fetchone(self) -> dict[str, Any] | None: ...

    def fetchall(self) -> list[dict[str, Any]]: ...

    def commit(self) -> None: ...

    def rollback(self) -> None: ...

    def close(self) -> None: ...


class PyMysqlConnection:
    """Thin wrapper around a PyMySQL connection with DictCursor semantics."""

    def __init__(self, raw: Any, *, on_close: Any | None = None) -> None:
        self._raw = raw
        self._cursor: Any | None = None
        self._on_close = on_close
        self._closed = False

    def execute(
        self,
        sql: str,
        params: Sequence[Any] | None = None,
    ) -> Any:
        if self._cursor is None:
            _, cursors = load_pymysql()
            self._cursor = self._raw.cursor(cursors.DictCursor)
        self._cursor.execute(sql, params or ())
        return self._cursor

    def fetchone(self) -> dict[str, Any] | None:
        if self._cursor is None:
            return None
        row = self._cursor.fetchone()
        return dict(row) if row is not None else None

    def fetchall(self) -> list[dict[str, Any]]:
        if self._cursor is None:
            return []
        rows = self._cursor.fetchall() or []
        return [dict(r) for r in rows]

    @property
    def rowcount(self) -> int:
        if self._cursor is None:
            return 0
        return int(self._cursor.rowcount or 0)

    def commit(self) -> None:
        self._raw.commit()

    def rollback(self) -> None:
        self._raw.rollback()

    def ping(self, *, reconnect: bool = False) -> bool:
        """Passive liveness check. Default reconnect=False (no silent reopen)."""
        if reconnect:
            # Explicit only — never used by MysqlDatabase.ping.
            self._raw.ping(reconnect=True)
            return True
        # Prefer SELECT 1 so fakes / servers without ping still work; fall back
        # to driver ping(reconnect=False).
        try:
            self.execute("SELECT 1")
            row = self.fetchone()
            return row is not None
        except Exception:
            try:
                self._raw.ping(reconnect=False)
                return True
            except Exception:
                return False

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            if self._cursor is not None:
                try:
                    self._cursor.close()
                finally:
                    self._cursor = None
            self._raw.close()
        finally:
            if self._on_close is not None:
                try:
                    self._on_close()
                except Exception:
                    pass


class MysqlDatabase:
    """MySQL-only database handle with transaction context manager.

    Does not fall back to SQLite, PostgreSQL, or in-memory stores.
    Does not run DDL / migrations (Agent Knex owns schema).
    """

    def __init__(
        self,
        connection_url: str,
        *,
        connect_fn: Any | None = None,
        connect_timeout: int = _DEFAULT_CONNECT_TIMEOUT,
        read_timeout: int = _DEFAULT_READ_TIMEOUT,
        write_timeout: int = _DEFAULT_WRITE_TIMEOUT,
        max_connections: int = _DEFAULT_MAX_CONNECTIONS,
    ) -> None:
        if (
            type(max_connections) is not int
            or isinstance(max_connections, bool)
            or max_connections < 1
        ):
            raise MysqlConfigError("max_connections must be a positive integer")
        self._url = assert_mysql_connection_url(connection_url)
        self._connect_fn = connect_fn  # injectable for tests
        self._connect_kwargs = parse_mysql_url(
            self._url,
            connect_timeout=connect_timeout,
            read_timeout=read_timeout,
            write_timeout=write_timeout,
        )
        self._max_connections = int(max_connections)
        self._open_gate = threading.BoundedSemaphore(self._max_connections)
        self._open_count = 0
        self._open_lock = threading.Lock()

    @property
    def connection_url(self) -> str:
        """Return the validated URL (may contain credentials — do not log)."""
        return self._url

    @property
    def max_connections(self) -> int:
        return self._max_connections

    @property
    def open_connection_count(self) -> int:
        with self._open_lock:
            return self._open_count

    def connect(self) -> PyMysqlConnection:
        acquired = self._open_gate.acquire(blocking=True, timeout=self._connect_kwargs["connect_timeout"])
        if not acquired:
            raise MysqlConfigError(
                f"MySQL connection limit reached "
                f"(max_connections={self._max_connections})"
            )
        try:
            if self._connect_fn is not None:
                raw = self._connect_fn(**self._safe_connect_kwargs())
                if isinstance(raw, PyMysqlConnection):
                    # Re-wrap so we still track the open-gate release.
                    conn = PyMysqlConnection(raw._raw, on_close=self._release_open)
                else:
                    conn = PyMysqlConnection(raw, on_close=self._release_open)
            else:
                pymysql, cursors = load_pymysql()
                kwargs = dict(self._connect_kwargs)
                kwargs["cursorclass"] = cursors.DictCursor
                raw = pymysql.connect(**kwargs)
                conn = PyMysqlConnection(raw, on_close=self._release_open)
            with self._open_lock:
                self._open_count += 1
            return conn
        except Exception:
            self._open_gate.release()
            raise

    def _release_open(self) -> None:
        with self._open_lock:
            if self._open_count > 0:
                self._open_count -= 1
        try:
            self._open_gate.release()
        except ValueError:
            # Over-release guard (double close).
            pass

    def _safe_connect_kwargs(self) -> dict[str, Any]:
        # Copy without mutating stored password dict in place beyond connect.
        return dict(self._connect_kwargs)

    def ping(self) -> bool:
        """Passive liveness probe: open, SELECT 1 / ping(reconnect=False), close.

        Never runs DDL. Never falls back to another database.
        """
        try:
            conn = self.connect()
        except Exception:
            return False
        try:
            return bool(conn.ping(reconnect=False))
        except Exception:
            return False
        finally:
            conn.close()

    @contextmanager
    def connection(self) -> Iterator[DbConnection]:
        conn = self.connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self) -> Iterator[DbConnection]:
        """Run work in a single transaction; commit on success, rollback on error.

        Exceptions propagate (no silent catch). No DDL helpers.
        """
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            # No silent catch: rollback then re-raise the original error.
            conn.rollback()
            raise
        finally:
            conn.close()


def create_mysql_database(
    connection_url: str,
    *,
    connect_timeout: int = _DEFAULT_CONNECT_TIMEOUT,
    read_timeout: int = _DEFAULT_READ_TIMEOUT,
    write_timeout: int = _DEFAULT_WRITE_TIMEOUT,
    max_connections: int = _DEFAULT_MAX_CONNECTIONS,
    connect_fn: Any | None = None,
) -> MysqlDatabase:
    """Factory: validate DSN then build MysqlDatabase (no DDL)."""
    return MysqlDatabase(
        connection_url,
        connect_fn=connect_fn,
        connect_timeout=connect_timeout,
        read_timeout=read_timeout,
        write_timeout=write_timeout,
        max_connections=max_connections,
    )
