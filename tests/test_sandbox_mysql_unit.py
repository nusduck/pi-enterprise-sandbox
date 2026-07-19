"""Unit tests for Sandbox MySQL execution-domain persistence (PR-02).

Uses an in-memory fake connection — no PyMySQL / MySQL server required.
Covers: DSN gate (no credential leak), parameterized SQL, transaction
commit/rollback, ownership SQL predicates, schema capability report,
no silent exception swallow.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from typing import Any, Sequence

import pytest

from sandbox.app.domain.types import OwnerScope
from sandbox.app.persistence.db import (
    MysqlDatabase,
    assert_mysql_connection_url,
    describe_rejected_mysql_url,
)
from sandbox.app.persistence.errors import (
    MysqlConfigError,
    MysqlDependencyError,
    NotFoundError,
    OwnershipError,
)
from sandbox.app.persistence.ownership import require_owner_scope
from sandbox.app.persistence.repositories.artifact_repository import ArtifactRepository
from sandbox.app.persistence.repositories.audit_repository import AuditRepository
from sandbox.app.persistence.repositories.dataset_repository import DatasetRepository
from sandbox.app.persistence.repositories.execution_repository import ExecutionRepository
from sandbox.app.persistence.repositories.process_repository import ProcessRepository
from sandbox.app.persistence.repositories.session_repository import SessionRepository
from sandbox.app.persistence.schema_gap import (
    EXECUTION_DOMAIN_TABLES,
    EXECUTION_DOMAIN_TABLES_PRESENT,
    SCHEMA_GAP_MISSING_TABLES,
    SANDBOX_AGENT_SESSION_RELATIONSHIP,
    report_schema_capability,
    report_schema_gap,
    validate_execution_domain_capability,
)

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER2 = "01K0G2PAV8FPMVC9QHJG7JPN5A"
SBX = "01K0G2PAV8FPMVC9QHJG7JPN55"
WSP = "01K0G2PAV8FPMVC9QHJG7JPN56"
AGENT_SESS = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
EXEC = "01K0G2PAV8FPMVC9QHJG7JPN60"
PROC = "01K0G2PAV8FPMVC9QHJG7JPN61"
DS = "01K0G2PAV8FPMVC9QHJG7JPN62"
ART = "01K0G2PAV8FPMVC9QHJG7JPN63"
AUD = "01K0G2PAV8FPMVC9QHJG7JPN64"
TRACE = "a" * 32


# ── Fake MySQL connection (parameterized SQL recorder + mini store) ─────────


class FakeCursorResult:
    def __init__(self, rowcount: int = 0) -> None:
        self.rowcount = rowcount


class FakeConnection:
    """Records (sql, params) and supports a minimal table store for repos."""

    def __init__(self, store: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.statements: list[tuple[str, tuple[Any, ...]]] = []
        self.store: dict[str, list[dict[str, Any]]] = store if store is not None else {}
        self.committed = False
        self.rolled_back = False
        self.closed = False
        self._result_rows: list[dict[str, Any]] = []
        self.rowcount = 0
        self.fail_on_execute: Exception | None = None

    def execute(
        self,
        sql: str,
        params: Sequence[Any] | None = None,
    ) -> FakeCursorResult:
        if self.fail_on_execute is not None:
            raise self.fail_on_execute
        params_t = tuple(params or ())
        # Guard: parameterized MySQL style only (reject sqlite '?').
        if "?" in sql.replace("%s", ""):
            raise AssertionError(f"sqlite-style '?' placeholder not allowed: {sql!r}")
        if params_t:
            assert sql.count("%s") == len(params_t), (
                f"placeholder/param mismatch: {sql!r} vs {params_t!r}"
            )
        self.statements.append((sql, params_t))
        self._result_rows = []
        self.rowcount = 0
        self._dispatch(sql, params_t)
        return FakeCursorResult(self.rowcount)

    def _dispatch(self, sql: str, params: tuple[Any, ...]) -> None:
        normalized = " ".join(sql.split())
        upper = normalized.upper()
        if upper.startswith("INSERT INTO"):
            self._handle_insert(normalized, params)
        elif upper.startswith("SELECT"):
            self._handle_select(normalized, params)
        elif upper.startswith("UPDATE"):
            self._handle_update(normalized, params)
        elif upper.startswith("DELETE"):
            self._handle_delete(normalized, params)
        else:
            # Unknown statement — still recorded; empty result.
            pass

    def _table_from(self, sql: str, keyword: str) -> str:
        m = re.search(rf"{keyword}\s+([`\w]+)", sql, flags=re.IGNORECASE)
        if not m:
            raise AssertionError(f"cannot parse table from: {sql}")
        return m.group(1).strip("`")

    def _handle_insert(self, sql: str, params: tuple[Any, ...]) -> None:
        table = self._table_from(sql, "INTO")
        cols_m = re.search(r"\(([^)]+)\)\s*VALUES", sql, flags=re.IGNORECASE)
        if not cols_m:
            raise AssertionError(f"cannot parse columns: {sql}")
        cols = [c.strip().strip("`") for c in cols_m.group(1).split(",")]
        assert len(cols) == len(params)
        row = dict(zip(cols, params, strict=True))
        # Mirror MySQL GENERATED relative_path_hash for artifacts (STORED SHA2).
        if table == "artifacts" and "relative_path" in row and "relative_path_hash" not in row:
            import hashlib

            row["relative_path_hash"] = hashlib.sha256(
                str(row["relative_path"]).encode("utf-8")
            ).hexdigest().lower()
        self.store.setdefault(table, []).append(row)
        self.rowcount = 1

    def _match_where(
        self,
        row: dict[str, Any],
        where_sql: str,
        params: list[Any],
    ) -> bool:
        # Support AND-equality chains: col = %s, plus col <> 'lit' / col != 'lit'
        parts = re.split(r"\s+AND\s+", where_sql, flags=re.IGNORECASE)
        idx = 0
        for part in parts:
            part = part.strip()
            if not part:
                continue
            m_ne = re.match(
                r"([`\w]+)\s*(?:<>|!=)\s*'([^']*)'",
                part,
                flags=re.IGNORECASE,
            )
            if m_ne:
                col = m_ne.group(1).strip("`")
                if str(row.get(col)) == m_ne.group(2):
                    return False
                continue
            m = re.match(r"([`\w]+)\s*=\s*%s", part, flags=re.IGNORECASE)
            if not m:
                # Unsupported expression in fake — fail loudly (no silent skip).
                raise AssertionError(f"unsupported WHERE fragment in fake: {part!r}")
            col = m.group(1).strip("`")
            if idx >= len(params):
                raise AssertionError("WHERE params exhausted")
            if row.get(col) != params[idx]:
                return False
            idx += 1
        return True

    def _handle_delete(self, sql: str, params: tuple[Any, ...]) -> None:
        table = self._table_from(sql, "FROM")
        where_sql, where_params, _limit = self._parse_where_params(sql, params)
        rows = self.store.get(table, [])
        kept: list[dict[str, Any]] = []
        deleted = 0
        for row in rows:
            if where_sql:
                if self._match_where(row, where_sql, list(where_params)):
                    deleted += 1
                    continue
                kept.append(row)
            else:
                deleted += 1
        self.store[table] = kept
        self.rowcount = deleted

    def _parse_where_params(
        self,
        sql: str,
        params: tuple[Any, ...],
    ) -> tuple[str, list[Any], int | None]:
        where_m = re.search(
            r"WHERE\s+(.+?)(?:ORDER BY|LIMIT|$)",
            sql,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not where_m:
            return "", list(params), None
        where_sql = where_m.group(1).strip()
        # Count equality binds in WHERE
        n_where = len(re.findall(r"%s", where_sql))
        limit_m = re.search(r"LIMIT\s+%s", sql, flags=re.IGNORECASE)
        limit_val: int | None = None
        where_params = list(params[:n_where])
        if limit_m and len(params) > n_where:
            limit_val = int(params[n_where])
        return where_sql, where_params, limit_val

    def _handle_select(self, sql: str, params: tuple[Any, ...]) -> None:
        table = self._table_from(sql, "FROM")
        where_sql, where_params, limit = self._parse_where_params(sql, params)
        rows = list(self.store.get(table, []))
        if where_sql:
            rows = [r for r in rows if self._match_where(r, where_sql, where_params)]
        if "ORDER BY" in sql.upper() and "DESC" in sql.upper():
            # Keep insertion order as created_at proxy; reverse for DESC.
            rows = list(reversed(rows))
        if limit is not None:
            rows = rows[:limit]
        self._result_rows = rows
        self.rowcount = len(rows)

    def _handle_update(self, sql: str, params: tuple[Any, ...]) -> None:
        table = self._table_from(sql, "UPDATE")
        set_m = re.search(
            r"SET\s+(.+?)\s+WHERE\s+(.+)$",
            sql,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not set_m:
            raise AssertionError(f"cannot parse UPDATE: {sql}")
        set_sql = set_m.group(1).strip()
        where_sql = set_m.group(2).strip()
        # Parse assignments without breaking COALESCE(%s, col) on commas.
        set_parts: list[str] = []
        buf = ""
        depth = 0
        for ch in set_sql:
            if ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
            if ch == "," and depth == 0:
                set_parts.append(buf.strip())
                buf = ""
                continue
            buf += ch
        if buf.strip():
            set_parts.append(buf.strip())
        n_set = sum(p.count("%s") for p in set_parts)
        set_params = list(params[:n_set])
        where_params = list(params[n_set:])
        updated = 0
        for row in self.store.get(table, []):
            if not self._match_where(row, where_sql, where_params):
                continue
            p_idx = 0
            for part in set_parts:
                # col = %s  or col = COALESCE(%s, col)
                m = re.match(
                    r"([`\w]+)\s*=\s*COALESCE\s*\(\s*%s\s*,\s*[`\w]+\s*\)",
                    part,
                    flags=re.IGNORECASE,
                )
                if m:
                    col = m.group(1).strip("`")
                    val = set_params[p_idx]
                    p_idx += 1
                    if val is not None:
                        row[col] = val
                    continue
                m2 = re.match(r"([`\w]+)\s*=\s*%s", part, flags=re.IGNORECASE)
                if m2:
                    col = m2.group(1).strip("`")
                    row[col] = set_params[p_idx]
                    p_idx += 1
                    continue
                raise AssertionError(f"unsupported SET fragment: {part!r}")
            updated += 1
        self.rowcount = updated

    def fetchone(self) -> dict[str, Any] | None:
        if not self._result_rows:
            return None
        return dict(self._result_rows[0])

    def fetchall(self) -> list[dict[str, Any]]:
        return [dict(r) for r in self._result_rows]

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True

    def close(self) -> None:
        self.closed = True


class FakeDatabase:
    """MysqlDatabase-compatible handle that yields FakeConnection."""

    def __init__(self) -> None:
        self.store: dict[str, list[dict[str, Any]]] = {}
        self.last_conn: FakeConnection | None = None
        self.connections: list[FakeConnection] = []

    def connect(self) -> FakeConnection:
        conn = FakeConnection(store=self.store)
        self.last_conn = conn
        self.connections.append(conn)
        return conn

    @contextmanager
    def connection(self):
        conn = self.connect()
        try:
            yield conn
        finally:
            conn.close()

    @contextmanager
    def transaction(self):
        conn = self.connect()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


# ── DSN gate ────────────────────────────────────────────────────────────────


class TestMysqlDsnGate:
    def test_accepts_mysql_scheme(self) -> None:
        url = "mysql://u:p@localhost:3306/sandbox"
        assert assert_mysql_connection_url(url) == url

    def test_accepts_mysql_pymysql_scheme(self) -> None:
        url = "mysql+pymysql://admin:SuperSecretPassw0rd@db.example.com:3306/prod"
        assert assert_mysql_connection_url(url) == url

    def test_rejects_empty_sqlite_postgres_mysql2_and_bare(self) -> None:
        secret = "mysql+aiomysql://admin:SuperSecretPassw0rd@db.example.com:3306/prod"
        bare = "admin:SuperSecretPassw0rd@db.example.com/prod"
        cases = [
            "",
            None,
            "sqlite:///tmp/x.db",
            ":memory:",
            "postgresql://u:p@localhost/db",
            "postgres://u:p@localhost/db",
            "mysql2://u:p@localhost:3306/db",
            secret,
            bare,
            "http://example.com/db",
        ]
        for url in cases:
            with pytest.raises(MysqlConfigError):
                assert_mysql_connection_url(url)  # type: ignore[arg-type]

    def test_errors_never_echo_credentials_or_full_dsn(self) -> None:
        secret = "mysql2://admin:SuperSecretPassw0rd@db.example.com:3306/prod"
        bare = "admin:SuperSecretPassw0rd@db.example.com/prod"
        for url in (secret, bare, "nonsense@host/db"):
            with pytest.raises(MysqlConfigError) as ei:
                assert_mysql_connection_url(url)
            msg = str(ei.value)
            assert "SuperSecretPassw0rd" not in msg
            assert "admin:" not in msg
            assert url not in msg

    def test_describe_rejected_classifies_without_secrets(self) -> None:
        assert describe_rejected_mysql_url(
            "mysql2://admin:x@h/db"
        ).startswith("scheme=")
        assert describe_rejected_mysql_url("admin:x@h/db") == "bare-credential-string"

    def test_database_rejects_non_mysql_on_construct(self) -> None:
        with pytest.raises(MysqlConfigError):
            MysqlDatabase("sqlite:///:memory:")

    def test_parse_normalizes_both_schemes_to_pymysql_kwargs(self) -> None:
        from sandbox.app.persistence.db import parse_mysql_url

        for url in (
            "mysql://u:p@localhost:3306/sandbox",
            "mysql+pymysql://u:p@localhost:3306/sandbox",
        ):
            kwargs = parse_mysql_url(url)
            assert kwargs["host"] == "localhost"
            assert kwargs["port"] == 3306
            assert kwargs["user"] == "u"
            assert kwargs["password"] == "p"
            assert kwargs["database"] == "sandbox"
            assert kwargs["connect_timeout"] == 5
            assert kwargs["read_timeout"] == 30
            assert kwargs["write_timeout"] == 30
            assert "charset" in kwargs


# ── Schema capability (PR-02 owns all execution-domain tables) ───────────────


class TestSchemaCapability:
    def test_reports_positive_capability_no_missing_tables(self) -> None:
        report = report_schema_capability()
        assert report["status"] == "CAPABLE"
        assert report["missing_tables"] == []
        assert set(report["execution_domain_tables"]) == {
            "sandbox_sessions",
            "process_executions",
            "sandbox_executions",
            "sandbox_audit_events",
            "datasets",
            "artifacts",
        }
        assert "conversations" in report["agent_authority_tables_not_owned_here"]
        assert "messages" in report["agent_authority_tables_not_owned_here"]
        assert "runs" in report["agent_authority_tables_not_owned_here"]
        assert report["agent_sandbox_session_relationship"] == (
            SANDBOX_AGENT_SESSION_RELATIONSHIP
        )
        assert report["agent_sandbox_ownership_uniques"] == [
            "uk_agent_sessions_workspace_id",
            "uk_agent_sessions_sandbox_session_id",
            "uk_sandbox_sessions_agent_session_id",
            "uk_sandbox_sessions_workspace_id",
        ]
        assert "summary" in report
        # Backward-compatible alias
        assert report_schema_gap()["missing_tables"] == []
        assert SCHEMA_GAP_MISSING_TABLES == ()

    def test_table_specs_are_present_with_owner_columns(self) -> None:
        report = report_schema_capability()
        by_table = {item["table"]: item for item in report["table_specs"]}
        for name in (
            "sandbox_sessions",
            "sandbox_executions",
            "sandbox_audit_events",
            "process_executions",
        ):
            assert name in by_table
            assert by_table[name]["status"] == "PRESENT"
            assert by_table[name]["owner_columns"] == ("org_id", "user_id")
        assert by_table["sandbox_sessions"]["repository"] == "SessionRepository"
        assert by_table["sandbox_executions"]["repository"] == "ExecutionRepository"
        assert by_table["sandbox_audit_events"]["repository"] == "AuditRepository"
        assert by_table["process_executions"]["repository"] == "ProcessRepository"

    def test_present_tables_constant(self) -> None:
        assert EXECUTION_DOMAIN_TABLES_PRESENT == EXECUTION_DOMAIN_TABLES
        assert "sandbox_sessions" in EXECUTION_DOMAIN_TABLES
        assert "sandbox_executions" in EXECUTION_DOMAIN_TABLES
        assert "sandbox_audit_events" in EXECUTION_DOMAIN_TABLES
        assert "process_executions" in EXECUTION_DOMAIN_TABLES

    def test_validate_execution_domain_capability(self) -> None:
        ok = validate_execution_domain_capability(set(EXECUTION_DOMAIN_TABLES))
        assert ok["ok"] is True
        assert ok["missing"] == []
        bad = validate_execution_domain_capability({"datasets", "artifacts"})
        assert bad["ok"] is False
        assert "sandbox_sessions" in bad["missing"]


# ── Ownership ───────────────────────────────────────────────────────────────


class TestOwnership:
    def test_require_owner_scope_rejects_empty(self) -> None:
        with pytest.raises(OwnershipError):
            require_owner_scope(None)
        with pytest.raises(OwnershipError):
            require_owner_scope({"org_id": "", "user_id": USER})
        with pytest.raises(OwnershipError):
            require_owner_scope({"org_id": ORG, "user_id": ""})

    def test_require_owner_scope_accepts_dict_and_dataclass(self) -> None:
        s1 = require_owner_scope({"org_id": ORG, "user_id": USER})
        s2 = require_owner_scope(OwnerScope(org_id=ORG, user_id=USER))
        assert s1.org_id == ORG and s1.user_id == USER
        assert s2.org_id == ORG and s2.user_id == USER


# ── Transaction commit / rollback ───────────────────────────────────────────


class TestTransaction:
    def test_commit_on_success(self) -> None:
        db = FakeDatabase()

        with db.transaction() as conn:
            conn.execute(
                "INSERT INTO datasets (dataset_id, org_id, user_id, conversation_id, "
                "agent_session_id, original_filename, stored_relative_path, mime_type, "
                "size_bytes, sha256, status, created_at, completed_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    DS,
                    ORG,
                    USER,
                    CONV,
                    AGENT_SESS,
                    "f.csv",
                    "data/f.csv",
                    None,
                    1,
                    None,
                    "ready",
                    "2026-07-18 00:00:00.000",
                    None,
                ),
            )
        assert db.last_conn is not None
        assert db.last_conn.committed is True
        assert db.last_conn.rolled_back is False
        assert db.last_conn.closed is True

    def test_rollback_on_error_no_silent_catch(self) -> None:
        db = FakeDatabase()

        with pytest.raises(RuntimeError, match="boom"):
            with db.transaction() as conn:
                conn.execute(
                    "INSERT INTO datasets (dataset_id, org_id, user_id, conversation_id, "
                    "agent_session_id, original_filename, stored_relative_path, mime_type, "
                    "size_bytes, sha256, status, created_at, completed_at) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                    (
                        DS,
                        ORG,
                        USER,
                        CONV,
                        AGENT_SESS,
                        "f.csv",
                        "data/f.csv",
                        None,
                        1,
                        None,
                        "ready",
                        "2026-07-18 00:00:00.000",
                        None,
                    ),
                )
                raise RuntimeError("boom")
        assert db.last_conn is not None
        assert db.last_conn.rolled_back is True
        assert db.last_conn.committed is False
        assert db.last_conn.closed is True

    def test_mysql_database_transaction_with_injectable_connect(self) -> None:
        """MysqlDatabase.transaction uses same commit/rollback semantics."""
        store: dict[str, list[dict[str, Any]]] = {}
        created: list[FakeConnection] = []

        def connect_fn(**_kwargs: Any) -> FakeConnection:
            # Bypass real PyMySQL: MysqlDatabase wraps raw; we return Fake as raw
            # by using a custom subclass path — inject via monkeypatch style.
            conn = FakeConnection(store=store)
            created.append(conn)
            return conn

        # Build with valid URL; replace connect to avoid PyMySQL.
        db = MysqlDatabase("mysql://u:p@localhost:3306/sandbox")

        def fake_connect() -> FakeConnection:
            conn = FakeConnection(store=store)
            created.append(conn)
            return conn

        db.connect = fake_connect  # type: ignore[method-assign]

        with db.transaction() as conn:
            assert isinstance(conn, FakeConnection)
            conn.execute(
                "INSERT INTO artifacts (artifact_id, org_id, user_id, conversation_id, "
                "agent_session_id, run_id, relative_path, display_name, mime_type, "
                "size_bytes, sha256, status, created_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                (
                    ART,
                    ORG,
                    USER,
                    CONV,
                    AGENT_SESS,
                    RUN,
                    "out/a.txt",
                    "a.txt",
                    "text/plain",
                    3,
                    "b" * 64,
                    "ready",
                    "2026-07-18 00:00:00.000",
                ),
            )
        assert created[-1].committed is True

        with pytest.raises(ValueError, match="fail-tx"):
            with db.transaction() as conn:
                raise ValueError("fail-tx")
        assert created[-1].rolled_back is True


# ── Repositories: parameterized SQL + ownership ─────────────────────────────


class TestDatasetRepository:
    def test_create_and_get_enforces_owner(self) -> None:
        db = FakeDatabase()
        repo = DatasetRepository(db)
        scope = OwnerScope(org_id=ORG, user_id=USER)
        with db.connection() as conn:
            created = repo.create(
                conn,
                {
                    "dataset_id": DS,
                    "org_id": ORG,
                    "user_id": USER,
                    "conversation_id": CONV,
                    "agent_session_id": AGENT_SESS,
                    "original_filename": "data.csv",
                    "stored_relative_path": "uploads/data.csv",
                    "status": "uploading",
                    "size_bytes": 10,
                },
            )
            assert created.dataset_id == DS
            owned = repo.get_by_id(conn, DS, scope)
            assert owned is not None
            foreign = repo.get_by_id(
                conn, DS, OwnerScope(org_id=ORG, user_id=USER2)
            )
            assert foreign is None
            sql, params = conn.statements[-1]
            assert "org_id = %s" in sql and "user_id = %s" in sql
            assert ORG in params and USER2 in params

    def test_create_requires_owner_fields(self) -> None:
        db = FakeDatabase()
        repo = DatasetRepository(db)
        with db.connection() as conn:
            with pytest.raises(OwnershipError):
                repo.create(
                    conn,
                    {
                        "dataset_id": DS,
                        "conversation_id": CONV,
                        "agent_session_id": AGENT_SESS,
                        "original_filename": "x",
                        "stored_relative_path": "x",
                        "status": "ready",
                    },
                )

    def test_delete_incomplete_not_ready(self) -> None:
        db = FakeDatabase()
        repo = DatasetRepository(db)
        scope = OwnerScope(org_id=ORG, user_id=USER)
        with db.connection() as conn:
            repo.create(
                conn,
                {
                    "dataset_id": DS,
                    "org_id": ORG,
                    "user_id": USER,
                    "conversation_id": CONV,
                    "agent_session_id": AGENT_SESS,
                    "original_filename": "x.csv",
                    "stored_relative_path": "datasets/x/x.csv",
                    "status": "uploading",
                },
            )
            assert repo.delete(conn, DS, scope) is True
            assert repo.get_by_id(conn, DS, scope) is None

    def test_delete_does_not_remove_ready(self) -> None:
        db = FakeDatabase()
        repo = DatasetRepository(db)
        scope = OwnerScope(org_id=ORG, user_id=USER)
        with db.connection() as conn:
            repo.create(
                conn,
                {
                    "dataset_id": DS,
                    "org_id": ORG,
                    "user_id": USER,
                    "conversation_id": CONV,
                    "agent_session_id": AGENT_SESS,
                    "original_filename": "x.csv",
                    "stored_relative_path": "datasets/x/x.csv",
                    "status": "ready",
                    "sha256": "a" * 64,
                    "size_bytes": 1,
                },
            )
            assert repo.delete(conn, DS, scope) is False
            assert repo.get_by_id(conn, DS, scope) is not None


class TestArtifactRepository:
    def test_create_list_and_unique_lookup(self) -> None:
        db = FakeDatabase()
        repo = ArtifactRepository(db)
        scope = {"org_id": ORG, "user_id": USER}
        sha = "c" * 64
        with db.connection() as conn:
            repo.create(
                conn,
                {
                    "artifact_id": ART,
                    "org_id": ORG,
                    "user_id": USER,
                    "conversation_id": CONV,
                    "agent_session_id": AGENT_SESS,
                    "run_id": RUN,
                    "relative_path": "out/report.pdf",
                    "display_name": "report.pdf",
                    "mime_type": "application/pdf",
                    "size_bytes": 99,
                    "sha256": sha,
                    "status": "ready",
                },
            )
            rows = repo.list_for_owner(conn, scope, run_id=RUN)
            assert len(rows) == 1
            assert rows[0].artifact_id == ART
            found = repo.get_by_run_path_hash(
                conn,
                scope,
                run_id=RUN,
                relative_path="out/report.pdf",
                sha256=sha,
            )
            assert found is not None
            assert found.display_name == "report.pdf"
            # Foreign owner
            assert (
                repo.get_by_id(conn, ART, {"org_id": ORG, "user_id": USER2}) is None
            )


class TestProcessRepository:
    def test_sql_aligned_to_migration_columns_with_owner_scope(self) -> None:
        db = FakeDatabase()
        repo = ProcessRepository(db)
        scope = OwnerScope(org_id=ORG, user_id=USER)
        with db.connection() as conn:
            row = repo.create(
                conn,
                {
                    "process_id": PROC,
                    "org_id": ORG,
                    "user_id": USER,
                    "sandbox_session_id": SBX,
                    "run_id": RUN,
                    "execution_id": EXEC,
                    "command_json": {"argv": ["python", "job.py"]},
                    "status": "running",
                    "pid": 4242,
                    "stdout_path": ".runtime/out.log",
                    "stderr_path": ".runtime/err.log",
                },
            )
            assert row.process_id == PROC
            assert row.pid == 4242
            assert row.org_id == ORG and row.user_id == USER
            sql, params = conn.statements[0]
            assert "INSERT INTO process_executions" in sql
            assert "sandbox_session_id" in sql
            assert "command_json" in sql
            assert "org_id" in sql and "user_id" in sql
            assert ORG in params and USER in params
            assert SBX in params and RUN in params and EXEC in params
            listed = repo.list_by_sandbox_session(conn, SBX, scope)
            assert len(listed) == 1
            # Tenant isolation via SQL predicates
            foreign = repo.list_by_sandbox_session(
                conn, SBX, OwnerScope(org_id=ORG, user_id=USER2)
            )
            assert foreign == []
            repo.update_status(
                conn,
                PROC,
                scope,
                status="completed",
                exit_code=0,
                sandbox_session_id=SBX,
                command_json={
                    "argv": ["python", "job.py"],
                    "pgid": 4242,
                    "start_identity": "4242:trusted-start",
                },
            )
            done = repo.require_by_id(conn, PROC, scope, sandbox_session_id=SBX)
            assert done.status == "completed"
            assert done.exit_code == 0
            assert done.command_json["pgid"] == 4242
            assert done.command_json["start_identity"] == "4242:trusted-start"
            with pytest.raises(OwnershipError):
                repo.create(
                    conn,
                    {
                        "process_id": "01K0G2PAV8FPMVC9QHJG7JPN70",
                        "sandbox_session_id": SBX,
                        "run_id": RUN,
                        "execution_id": EXEC,
                        "command_json": {},
                        "status": "running",
                    },
                )

    def test_update_accepts_mysql_changed_rows_zero_when_owner_row_exists(self) -> None:
        db = FakeDatabase()
        repo = ProcessRepository(db)
        scope = OwnerScope(org_id=ORG, user_id=USER)
        with db.connection() as conn:
            repo.create(
                conn,
                {
                    "process_id": PROC,
                    "org_id": ORG,
                    "user_id": USER,
                    "sandbox_session_id": SBX,
                    "run_id": RUN,
                    "execution_id": EXEC,
                    "command_json": {"command": "sleep 1"},
                    "status": "running",
                },
            )
            original_execute = conn.execute

            def execute_with_changed_rows_semantics(sql, params=None):
                result = original_execute(sql, params)
                if sql.lstrip().upper().startswith("UPDATE"):
                    conn.rowcount = 0
                return result

            conn.execute = execute_with_changed_rows_semantics  # type: ignore[method-assign]
            updated = repo.update_status(
                conn,
                PROC,
                scope,
                status="running",
                sandbox_session_id=SBX,
            )
            assert updated.process_id == PROC
            assert updated.status == "running"


class TestSessionExecutionAuditRepos:
    def test_session_repo_parameterized_owner_sql(self) -> None:
        db = FakeDatabase()
        repo = SessionRepository(db)
        scope = OwnerScope(org_id=ORG, user_id=USER)
        with db.connection() as conn:
            created = repo.create(
                conn,
                {
                    "sandbox_session_id": SBX,
                    "org_id": ORG,
                    "user_id": USER,
                    "agent_session_id": AGENT_SESS,
                    "workspace_id": WSP,
                    "status": "active",
                },
            )
            assert created.sandbox_session_id == SBX
            sql, params = conn.statements[0]
            assert "INSERT INTO sandbox_sessions" in sql
            assert "org_id" in sql and "user_id" in sql
            assert all(isinstance(p, (str, type(None))) for p in params)
            assert repo.get_by_id(conn, SBX, {"org_id": ORG, "user_id": USER2}) is None
            with pytest.raises(NotFoundError):
                repo.require_by_id(conn, SBX, {"org_id": ORG, "user_id": USER2})
            owned = repo.get_by_id(conn, SBX, scope)
            assert owned is not None

    def test_execution_repo_parameterized_sql(self) -> None:
        db = FakeDatabase()
        repo = ExecutionRepository(db)
        with db.connection() as conn:
            row = repo.create(
                conn,
                {
                    "execution_id": EXEC,
                    "org_id": ORG,
                    "user_id": USER,
                    "sandbox_session_id": SBX,
                    "run_id": RUN,
                    "agent_session_id": AGENT_SESS,
                    "kind": "command",
                    "status": "running",
                    "trace_id": TRACE,
                },
            )
            assert row.kind == "command"
            sql, _ = conn.statements[0]
            assert "INSERT INTO sandbox_executions" in sql
            assert "org_id" in sql and "user_id" in sql
            assert "%s" in sql
            listed = repo.list_by_session(conn, SBX, {"org_id": ORG, "user_id": USER})
            assert len(listed) == 1
            assert (
                repo.list_by_session(conn, SBX, {"org_id": ORG, "user_id": USER2})
                == []
            )

    def test_audit_repo_owner_scoped_list(self) -> None:
        db = FakeDatabase()
        repo = AuditRepository(db)
        with db.connection() as conn:
            repo.insert(
                conn,
                {
                    "audit_id": AUD,
                    "org_id": ORG,
                    "user_id": USER,
                    "event_type": "execution.started",
                    "sandbox_session_id": SBX,
                    "execution_id": EXEC,
                    "trace_id": TRACE,
                    "payload_json": {"kind": "command"},
                },
            )
            rows = repo.list_by_trace_id(
                conn, TRACE, {"org_id": ORG, "user_id": USER}
            )
            assert len(rows) == 1
            assert rows[0].event_type == "execution.started"
            foreign = repo.list_by_trace_id(
                conn, TRACE, {"org_id": ORG, "user_id": USER2}
            )
            assert foreign == []


class TestNoSilentCatch:
    def test_execute_errors_propagate(self) -> None:
        db = FakeDatabase()
        repo = DatasetRepository(db)
        with db.connection() as conn:
            conn.fail_on_execute = RuntimeError("db down")
            with pytest.raises(RuntimeError, match="db down"):
                repo.get_by_id(
                    conn, DS, OwnerScope(org_id=ORG, user_id=USER)
                )

    def test_load_pymysql_dependency_error_not_swallowed(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import builtins

        from sandbox.app.persistence import db as dbmod

        real_import = builtins.__import__

        def blocked(name: str, globals=None, locals=None, fromlist=(), level=0):  # noqa: ANN001
            if name == "pymysql" or (isinstance(name, str) and name.startswith("pymysql.")):
                raise ImportError("blocked for test")
            return real_import(name, globals, locals, fromlist, level)

        monkeypatch.setattr(builtins, "__import__", blocked)
        with pytest.raises(MysqlDependencyError) as ei:
            dbmod.load_pymysql()
        assert ei.value.code == "MYSQL_DEPENDENCY_ERROR"
        assert "PyMySQL" in str(ei.value)


class TestNoAgentAuthorityLeak:
    def test_package_exports_exclude_conversation_message_run(self) -> None:
        import sandbox.app.persistence as p

        names = set(p.__all__)
        for forbidden in (
            "ConversationRepository",
            "MessageRepository",
            "RunRepository",
            "RunEventRepository",
        ):
            assert forbidden not in names
