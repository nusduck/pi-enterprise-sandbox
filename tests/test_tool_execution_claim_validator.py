"""PR-07B batch 2B: hermetic unit tests for ToolExecutionClaimValidator.

Fake DB only — no real MySQL, Docker, network, or uv. Covers claim races/1062,
lock order, owner masking, mismatch conflict, legacy NULL fail-closed,
finalize idempotency/conflicts, UNKNOWN sticky, and crash recovery.
"""

from __future__ import annotations

import re
from contextlib import contextmanager
from typing import Any, Sequence

import pytest

from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_FAILED,
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
)
from sandbox.app.persistence.errors import (
    ConflictError,
    IdempotencyKeyReuseError,
    NotFoundError,
    SchemaGapError,
)
from sandbox.app.persistence.repositories.execution_repository import ExecutionRepository
from sandbox.app.persistence.repositories.tool_execution_claim_validator import (
    MYSQL_ER_DUP_ENTRY,
    ToolExecutionClaimValidator,
    _require_positive_int,
)

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
OTHER_USER = "01K0G2PAV8FPMVC9QHJG7JPN99"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT = "01K0G2PAV8FPMVC9QHJG7JPN52"
SBX = "01K0G2PAV8FPMVC9QHJG7JPN55"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
TE = "01K0G2PAV8FPMVC9QHJG7JPN5K"
EXEC = "01K0G2PAV8FPMVC9QHJG7JPN60"
WS = "01K0G2PAV8FPMVC9QHJG7JPN56"
WS_OTHER = "01K0G2PAV8FPMVC9QHJG7JPN57"
TC = "tc-claim-1"
HASH = "67299dd95ff1e9e856fb845da8ef636af2e7726214ccd61de3f6992ba25064c2"
HASH2 = "0c30d7c3316941a7b48a5234311243f7f6679da3def35ce7e003313210b6366f"
FENCE = 7
TRACE = "a" * 32


class DupEntryError(Exception):
    """Simulate MySQL ER_DUP_ENTRY (1062)."""

    def __init__(self, message: str = "Duplicate entry") -> None:
        super().__init__(MYSQL_ER_DUP_ENTRY, message)
        self.args = (MYSQL_ER_DUP_ENTRY, message)
        self.errno = MYSQL_ER_DUP_ENTRY
        self.code = MYSQL_ER_DUP_ENTRY


class FakeCursorResult:
    def __init__(self, rowcount: int = 0) -> None:
        self.rowcount = rowcount


class ClaimFakeConnection:
    """Mini store with FOR SHARE/UPDATE, JOIN tool_executions+runs, 1062 uniques."""

    def __init__(self, store: dict[str, list[dict[str, Any]]]) -> None:
        self.store = store
        self.statements: list[tuple[str, tuple[Any, ...]]] = []
        self.lock_order: list[str] = []
        self._result_rows: list[dict[str, Any]] = []
        self.rowcount = 0
        self.committed = False
        self.rolled_back = False
        self.closed = False
        # Injected race: after N inserts that would succeed, raise 1062 and
        # optionally pre-seed the winning row.
        self.dup_on_insert: bool = False
        self.dup_seed_row: dict[str, Any] | None = None
        # Claim schema capability probe (INFORMATION_SCHEMA). Default present.
        self.claim_schema_capable: bool = True
        self.missing_claim_columns: set[tuple[str, str]] = set()
        self.missing_claim_indexes: set[tuple[str, str]] = set()

    def execute(
        self, sql: str, params: Sequence[Any] | None = None
    ) -> FakeCursorResult:
        params_t = tuple(params or ())
        if "?" in sql.replace("%s", ""):
            raise AssertionError(f"sqlite-style '?' not allowed: {sql!r}")
        if params_t:
            assert sql.count("%s") == len(params_t), (
                f"placeholder mismatch: {sql!r} vs {params_t!r}"
            )
        self.statements.append((sql, params_t))
        self._result_rows = []
        self.rowcount = 0
        self._dispatch(sql, params_t)
        return FakeCursorResult(self.rowcount)

    def _norm(self, sql: str) -> str:
        return " ".join(sql.split())

    def _dispatch(self, sql: str, params: tuple[Any, ...]) -> None:
        n = self._norm(sql)
        upper = n.upper()

        # Track lock order by first FOR SHARE / FOR UPDATE table touch
        if "FOR SHARE" in upper or "FOR UPDATE" in upper:
            self._record_lock(upper)

        if upper.startswith("INSERT INTO"):
            self._handle_insert(n, params)
        elif upper.startswith("SELECT"):
            self._handle_select(n, params)
        elif upper.startswith("UPDATE"):
            self._handle_update(n, params)
        else:
            pass

    def _record_lock(self, upper: str) -> None:
        # Order tables as they appear in FROM / JOIN
        if "FROM AGENT_SESSIONS" in upper:
            self.lock_order.append("agent_sessions")
        elif "FROM RUNS" in upper and "TOOL_EXECUTIONS" not in upper:
            self.lock_order.append("runs")
        elif "FROM SANDBOX_SESSIONS" in upper:
            self.lock_order.append("sandbox_sessions")
        elif "FROM TOOL_EXECUTIONS" in upper or "TOOL_EXECUTIONS TE" in upper:
            self.lock_order.append("tool_executions")
        elif "FROM SANDBOX_EXECUTIONS" in upper:
            self.lock_order.append("sandbox_executions")

    def _handle_insert(self, sql: str, params: tuple[Any, ...]) -> None:
        m = re.search(r"INSERT INTO\s+([`\w]+)", sql, flags=re.IGNORECASE)
        assert m
        table = m.group(1).strip("`")
        cols_m = re.search(r"\(([^)]+)\)\s*VALUES", sql, flags=re.IGNORECASE)
        assert cols_m
        cols = [c.strip().strip("`") for c in cols_m.group(1).split(",")]
        assert len(cols) == len(params)
        row = dict(zip(cols, params, strict=True))

        if table == "sandbox_executions":
            # Unique (run_id, tool_call_id) and unique tool_execution_id
            for existing in self.store.get(table, []):
                if (
                    existing.get("run_id") == row.get("run_id")
                    and existing.get("tool_call_id") == row.get("tool_call_id")
                    and row.get("tool_call_id") is not None
                ):
                    raise DupEntryError("uk_sandbox_execution_run_tool_call")
                if (
                    row.get("tool_execution_id") is not None
                    and existing.get("tool_execution_id") == row.get("tool_execution_id")
                ):
                    raise DupEntryError("uk_sandbox_execution_tool_execution")
            if self.dup_on_insert:
                if self.dup_seed_row is not None:
                    self.store.setdefault(table, []).append(dict(self.dup_seed_row))
                self.dup_on_insert = False
                raise DupEntryError("race")

        self.store.setdefault(table, []).append(row)
        self.rowcount = 1

    def _match_eq(self, row: dict[str, Any], col: str, val: Any) -> bool:
        # Strip table alias te.col / r.col
        c = col.split(".")[-1].strip("`")
        return row.get(c) == val

    def _handle_select(self, sql: str, params: tuple[Any, ...]) -> None:
        upper = sql.upper()
        # Readonly claim capability probe (INFORMATION_SCHEMA).
        if "INFORMATION_SCHEMA.COLUMNS" in upper:
            table_name = str(params[0]) if params else ""
            col_name = str(params[1]) if len(params) > 1 else ""
            if (
                self.claim_schema_capable
                and (table_name, col_name) not in self.missing_claim_columns
            ):
                self._result_rows = [{"name": col_name}]
            else:
                self._result_rows = []
            return
        if "INFORMATION_SCHEMA.STATISTICS" in upper:
            table_name = str(params[0]) if params else ""
            index_name = str(params[1]) if len(params) > 1 else ""
            if (
                self.claim_schema_capable
                and (table_name, index_name) not in self.missing_claim_indexes
            ):
                self._result_rows = [{"name": index_name}]
            else:
                self._result_rows = []
            return
        # JOIN path: tool_executions te INNER JOIN runs r
        # Simple FROM table (tool_executions is direct FOR UPDATE — no JOIN)
        m = re.search(r"FROM\s+([`\w]+)", sql, flags=re.IGNORECASE)
        assert m, f"cannot parse FROM: {sql}"
        table = m.group(1).strip("`")
        where_m = re.search(
            r"WHERE\s+(.+?)(?:FOR\s+(?:UPDATE|SHARE)|$)",
            sql,
            flags=re.IGNORECASE | re.DOTALL,
        )
        rows = list(self.store.get(table, []))
        if where_m:
            where_sql = where_m.group(1).strip()
            parts = re.split(r"\s+AND\s+", where_sql, flags=re.IGNORECASE)
            idx = 0
            filtered = []
            for row in rows:
                ok = True
                p_idx = 0
                for part in parts:
                    part = part.strip()
                    if not part:
                        continue
                    mm = re.match(
                        r"([`\w.]+)\s*=\s*%s", part, flags=re.IGNORECASE
                    )
                    if not mm:
                        raise AssertionError(f"unsupported WHERE: {part!r}")
                    col = mm.group(1)
                    if not self._match_eq(row, col, params[p_idx]):
                        ok = False
                        break
                    p_idx += 1
                if ok:
                    # ensure we consumed all params for this where
                    if p_idx != len(params):
                        # partial — still ok if all parts matched
                        pass
                    filtered.append(row)
                idx += 1
            # Correct filter: re-evaluate properly
            filtered = []
            for row in rows:
                p_idx = 0
                ok = True
                for part in parts:
                    part = part.strip()
                    if not part:
                        continue
                    mm = re.match(
                        r"([`\w.]+)\s*=\s*%s", part, flags=re.IGNORECASE
                    )
                    if not mm:
                        raise AssertionError(f"unsupported WHERE: {part!r}")
                    if not self._match_eq(row, mm.group(1), params[p_idx]):
                        ok = False
                        break
                    p_idx += 1
                if ok and p_idx == len(params):
                    filtered.append(dict(row))
            rows = filtered
        else:
            rows = [dict(r) for r in rows]

        self._result_rows = rows
        self.rowcount = len(rows)

    def _handle_update(self, sql: str, params: tuple[Any, ...]) -> None:
        m = re.search(r"UPDATE\s+([`\w]+)", sql, flags=re.IGNORECASE)
        assert m
        table = m.group(1).strip("`")
        set_m = re.search(
            r"SET\s+(.+?)\s+WHERE\s+(.+)$",
            sql,
            flags=re.IGNORECASE | re.DOTALL,
        )
        assert set_m
        set_sql = set_m.group(1).strip()
        where_sql = set_m.group(2).strip()
        # strip FOR UPDATE if any (shouldn't be on UPDATE)
        where_sql = re.sub(
            r"\s+FOR\s+(UPDATE|SHARE)\s*$",
            "",
            where_sql,
            flags=re.IGNORECASE,
        )

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
        where_parts = re.split(r"\s+AND\s+", where_sql, flags=re.IGNORECASE)

        updated = 0
        for row in self.store.get(table, []):
            p_idx = 0
            match = True
            for part in where_parts:
                part = part.strip()
                mm = re.match(r"([`\w.]+)\s*=\s*%s", part, flags=re.IGNORECASE)
                if not mm:
                    raise AssertionError(f"unsupported UPDATE WHERE: {part!r}")
                if not self._match_eq(row, mm.group(1), where_params[p_idx]):
                    match = False
                    break
                p_idx += 1
            if not match or p_idx != len(where_params):
                continue
            # apply set
            s_idx = 0
            for part in set_parts:
                mco = re.match(
                    r"([`\w]+)\s*=\s*COALESCE\s*\(\s*%s\s*,\s*[`\w]+\s*\)",
                    part,
                    flags=re.IGNORECASE,
                )
                if mco:
                    col = mco.group(1).strip("`")
                    val = set_params[s_idx]
                    s_idx += 1
                    if val is not None:
                        row[col] = val
                    continue
                mm = re.match(r"([`\w]+)\s*=\s*%s", part, flags=re.IGNORECASE)
                if not mm:
                    raise AssertionError(f"unsupported SET: {part!r}")
                row[mm.group(1).strip("`")] = set_params[s_idx]
                s_idx += 1
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


class ClaimFakeDatabase:
    def __init__(self) -> None:
        self.store: dict[str, list[dict[str, Any]]] = {
            "agent_sessions": [],
            "runs": [],
            "sandbox_sessions": [],
            "tool_executions": [],
            "sandbox_executions": [],
        }
        self.last_conn: ClaimFakeConnection | None = None
        self.connections: list[ClaimFakeConnection] = []
        self.claim_schema_capable: bool = True
        self.missing_claim_columns: set[tuple[str, str]] = set()
        self.missing_claim_indexes: set[tuple[str, str]] = set()

    def connect(self) -> ClaimFakeConnection:
        conn = ClaimFakeConnection(self.store)
        conn.claim_schema_capable = self.claim_schema_capable
        conn.missing_claim_columns = set(self.missing_claim_columns)
        conn.missing_claim_indexes = set(self.missing_claim_indexes)
        self.last_conn = conn
        self.connections.append(conn)
        return conn

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

    @contextmanager
    def connection(self):
        conn = self.connect()
        try:
            yield conn
        finally:
            conn.close()


def seed_happy(db: ClaimFakeDatabase, **overrides: Any) -> None:
    """Seed parent rows + bound RUNNING tool_execution for happy-path claim."""
    agent = {
        "agent_session_id": AGENT,
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "sandbox_session_id": SBX,
        "workspace_id": WS,
        "status": "ACTIVE",
        "execution_fence_token": FENCE,
    }
    run = {
        "run_id": RUN,
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT,
        "status": "RUNNING",
    }
    sbx = {
        "sandbox_session_id": SBX,
        "org_id": ORG,
        "user_id": USER,
        "agent_session_id": AGENT,
        "workspace_id": WS,
        "status": "RUNNING",
    }
    te = {
        "tool_execution_id": TE,
        "run_id": RUN,
        "agent_session_id": AGENT,
        "tool_call_id": TC,
        "tool_name": "bash",
        "tool_source": "sandbox",
        "status": "RUNNING",
        "request_hash": HASH,
        "request_hash_version": 1,
        "execution_fence_token": FENCE,
        "trace_id": TRACE,
    }
    agent.update(overrides.get("agent") or {})
    run.update(overrides.get("run") or {})
    sbx.update(overrides.get("sbx") or {})
    te.update(overrides.get("te") or {})
    db.store["agent_sessions"] = [agent]
    db.store["runs"] = [run]
    db.store["sandbox_sessions"] = [sbx]
    db.store["tool_executions"] = [te]
    if "sandbox" in overrides:
        db.store["sandbox_executions"] = [overrides["sandbox"]]


def base_claim(**extra: Any) -> dict[str, Any]:
    d = {
        "org_id": ORG,
        "user_id": USER,
        "execution_id": EXEC,
        "sandbox_session_id": SBX,
        "run_id": RUN,
        "agent_session_id": AGENT,
        "conversation_id": CONV,
        "tool_execution_id": TE,
        "tool_call_id": TC,
        "tool_name": "bash",
        "kind": "bash",
        "request_hash": HASH,
        "request_hash_version": 1,
        "execution_fence_token": FENCE,
        "trace_id": TRACE,
    }
    d.update(extra)
    return d


# ── claim happy / idempotent ───────────────────────────────────────────────


class TestClaimHappyPath:
    def test_claim_creates_running_with_identity(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        out = v.claim(base_claim())
        assert out["created"] is True
        assert out["workspace_id"] == WS
        ex = out["execution"]
        assert ex.status == SANDBOX_EXECUTION_STATUS_RUNNING
        assert ex.tool_execution_id == TE
        assert ex.tool_call_id == TC
        assert ex.request_hash == HASH
        assert ex.request_hash_version == 1
        assert ex.execution_fence_token == FENCE
        assert ex.run_id == RUN
        assert ex.agent_session_id == AGENT
        assert db.last_conn is not None
        assert db.last_conn.committed is True

    def test_claim_lock_order(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        v.claim(base_claim())
        order = db.last_conn.lock_order if db.last_conn else []
        # Required prefix order
        expected_prefix = [
            "agent_sessions",
            "runs",
            "sandbox_sessions",
            "tool_executions",
        ]
        assert order[:4] == expected_prefix

    def test_same_identity_replay_created_false_no_second_row(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        r1 = v.claim(base_claim())
        assert r1["created"] is True
        assert r1["workspace_id"] == WS
        r2 = v.claim(base_claim(execution_id="01K0G2PAV8FPMVC9QHJG7JPN61"))
        assert r2["created"] is False
        assert r2["workspace_id"] == WS
        assert r2["execution"].execution_id == EXEC
        assert len(db.store["sandbox_executions"]) == 1

    def test_different_hash_is_idempotency_key_reuse_conflict(self) -> None:
        """Sandbox row for run+toolCall exists with hash A; claim carries hash B.

        Tool ledger is pre-bound to B so parent validation passes; sandbox
        replay then detects identity/hash reuse conflict.
        """
        db = ClaimFakeDatabase()
        seed_happy(db, te={"request_hash": HASH2})
        db.store["sandbox_executions"] = [
            {
                "execution_id": EXEC,
                "org_id": ORG,
                "user_id": USER,
                "sandbox_session_id": SBX,
                "run_id": RUN,
                "agent_session_id": AGENT,
                "kind": "bash",
                "status": SANDBOX_EXECUTION_STATUS_RUNNING,
                "exit_code": None,
                "error_code": None,
                "trace_id": TRACE,
                "result_json": None,
                "started_at": "2026-07-18 00:00:00.000",
                "completed_at": None,
                "created_at": "2026-07-18 00:00:00.000",
                "tool_execution_id": TE,
                "tool_call_id": TC,
                "request_hash": HASH,
                "request_hash_version": 1,
                "execution_fence_token": FENCE,
            }
        ]
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(IdempotencyKeyReuseError) as ei:
            v.claim(base_claim(request_hash=HASH2))
        assert ei.value.code == "IDEMPOTENCY_KEY_REUSE"

    def test_kind_mismatch_vs_tool_name_rejected(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="kind == tool_name"):
            v.claim(base_claim(kind="python", tool_name="bash"))

    def test_kind_replay_mismatch_is_idempotency_reuse(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        v.claim(base_claim())
        # Same hash/identity but kind would differ — kind is stored; re-claim
        # with matching tool ledger requires same kind==tool_name; seed another
        # sandbox row path via existing row with different kind.
        db.store["sandbox_executions"][0]["kind"] = "python"
        with pytest.raises(IdempotencyKeyReuseError) as ei:
            v.claim(base_claim())
        assert ei.value.code == "IDEMPOTENCY_KEY_REUSE"

    def test_strict_positive_int_rejects_bool_str_float(self) -> None:
        for bad in (True, False, "1", 1.0, 1.5, None, 0, -1):
            with pytest.raises(ConflictError, match="positive integer"):
                _require_positive_int(bad, "field")
        assert _require_positive_int(1, "field") == 1
        assert _require_positive_int(7, "field") == 7


class TestClaimRaces:
    def test_1062_race_replays_winner(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        # Pre-configure first connection's insert to 1062 after seeding winner
        winner = {
            "execution_id": "01K0G2PAV8FPMVC9QHJG7JPN6A",
            "org_id": ORG,
            "user_id": USER,
            "sandbox_session_id": SBX,
            "run_id": RUN,
            "agent_session_id": AGENT,
            "kind": "bash",
            "status": SANDBOX_EXECUTION_STATUS_RUNNING,
            "exit_code": None,
            "error_code": None,
            "trace_id": TRACE,
            "result_json": None,
            "started_at": "2026-07-18 00:00:00.000",
            "completed_at": None,
            "created_at": "2026-07-18 00:00:00.000",
            "tool_execution_id": TE,
            "tool_call_id": TC,
            "request_hash": HASH,
            "request_hash_version": 1,
            "execution_fence_token": FENCE,
        }

        class RaceDb(ClaimFakeDatabase):
            def connect(self) -> ClaimFakeConnection:  # type: ignore[override]
                conn = super().connect()
                conn.dup_on_insert = True
                conn.dup_seed_row = winner
                return conn

        race_db = RaceDb()
        seed_happy(race_db)
        v2 = ToolExecutionClaimValidator(race_db)
        out = v2.claim(base_claim())
        assert out["created"] is False
        assert out["execution"].execution_id == winner["execution_id"]

    def test_1062_on_tool_execution_id_without_run_tool_call_is_data_conflict(
        self,
    ) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        # Existing row with same tool_execution_id but different run/tool_call
        db.store["sandbox_executions"] = [
            {
                "execution_id": "01K0G2PAV8FPMVC9QHJG7JPN6B",
                "org_id": ORG,
                "user_id": USER,
                "sandbox_session_id": SBX,
                "run_id": "01K0G2PAV8FPMVC9QHJG7JPN9Z",
                "agent_session_id": AGENT,
                "kind": "bash",
                "status": SANDBOX_EXECUTION_STATUS_RUNNING,
                "exit_code": None,
                "error_code": None,
                "trace_id": TRACE,
                "result_json": None,
                "started_at": None,
                "completed_at": None,
                "created_at": "2026-07-18 00:00:00.000",
                "tool_execution_id": TE,
                "tool_call_id": "other-tc",
                "request_hash": HASH,
                "request_hash_version": 1,
                "execution_fence_token": FENCE,
            }
        ]
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="data conflict|unique tool_execution"):
            v.claim(base_claim())


class TestOwnerMaskingAndConflicts:
    def test_foreign_owner_agent_session_not_found(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, agent={"user_id": OTHER_USER})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(NotFoundError, match="Agent session"):
            v.claim(base_claim())

    def test_foreign_owner_run_not_found(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, run={"user_id": OTHER_USER})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(NotFoundError, match="Run not found"):
            v.claim(base_claim())

    def test_foreign_owner_sandbox_session_not_found(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, sbx={"user_id": OTHER_USER})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(NotFoundError, match="Sandbox session"):
            v.claim(base_claim())

    def test_same_owner_fence_mismatch_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="fence"):
            v.claim(base_claim(execution_fence_token=99))

    def test_same_owner_run_status_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, run={"status": "SUCCEEDED"})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="RUNNING"):
            v.claim(base_claim())

    def test_bidirectional_binding_mismatch_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, sbx={"agent_session_id": "01K0G2PAV8FPMVC9QHJG7JPN9A"})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="binding"):
            v.claim(base_claim())

    def test_legacy_null_tool_identity_fail_closed(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(
            db,
            te={
                "request_hash": None,
                "request_hash_version": None,
                "execution_fence_token": None,
            },
        )
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="NULL request identity"):
            v.claim(base_claim())

    def test_tool_not_running_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, te={"status": "SUCCEEDED"})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="RUNNING"):
            v.claim(base_claim())

    def test_missing_tool_execution_not_found(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        db.store["tool_executions"] = []
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(NotFoundError, match="Tool execution"):
            v.claim(base_claim())


class TestWorkspaceIdBinding:
    """PR-07B: lock-validated workspace_id on agent+sandbox parents."""

    def test_happy_returns_workspace_id(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        out = ToolExecutionClaimValidator(db).claim(base_claim())
        assert out["created"] is True
        assert out["workspace_id"] == WS
        # Must not be derived from claim body (body has no workspace_id).
        assert "workspace_id" not in base_claim()

    def test_replay_returns_same_workspace_id(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        r1 = v.claim(base_claim())
        r2 = v.claim(base_claim(execution_id="01K0G2PAV8FPMVC9QHJG7JPN61"))
        assert r1["workspace_id"] == WS
        assert r2["created"] is False
        assert r2["workspace_id"] == WS
        assert r1["workspace_id"] == r2["workspace_id"]

    def test_missing_agent_workspace_id_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, agent={"workspace_id": None})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="workspace_id") as ei:
            v.claim(base_claim())
        assert not isinstance(ei.value, NotFoundError)
        assert ei.value.code == "CONFLICT"

    def test_missing_sandbox_workspace_id_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, sbx={"workspace_id": None})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="workspace_id") as ei:
            v.claim(base_claim())
        assert ei.value.code == "CONFLICT"

    def test_invalid_agent_workspace_id_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, agent={"workspace_id": "not-a-ulid"})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="formal ULID") as ei:
            v.claim(base_claim())
        assert ei.value.code == "CONFLICT"

    def test_invalid_sandbox_workspace_id_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, sbx={"workspace_id": "../escape"})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="formal ULID") as ei:
            v.claim(base_claim())
        assert ei.value.code == "CONFLICT"

    def test_workspace_id_mismatch_conflict_not_not_found(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, agent={"workspace_id": WS}, sbx={"workspace_id": WS_OTHER})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="workspace_id mismatch") as ei:
            v.claim(base_claim())
        # Must not owner-mask as NotFound (tenant existence leak).
        assert type(ei.value) is ConflictError
        assert ei.value.code == "CONFLICT"

    def test_empty_workspace_id_conflict(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db, agent={"workspace_id": "   "})
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="workspace_id"):
            v.claim(base_claim())

    def test_race_replay_includes_workspace_id(self) -> None:
        winner = {
            "execution_id": "01K0G2PAV8FPMVC9QHJG7JPN6A",
            "org_id": ORG,
            "user_id": USER,
            "sandbox_session_id": SBX,
            "run_id": RUN,
            "agent_session_id": AGENT,
            "kind": "bash",
            "status": SANDBOX_EXECUTION_STATUS_RUNNING,
            "exit_code": None,
            "error_code": None,
            "trace_id": TRACE,
            "result_json": None,
            "started_at": "2026-07-18 00:00:00.000",
            "completed_at": None,
            "created_at": "2026-07-18 00:00:00.000",
            "tool_execution_id": TE,
            "tool_call_id": TC,
            "request_hash": HASH,
            "request_hash_version": 1,
            "execution_fence_token": FENCE,
        }

        class RaceDb(ClaimFakeDatabase):
            def connect(self) -> ClaimFakeConnection:  # type: ignore[override]
                conn = super().connect()
                conn.dup_on_insert = True
                conn.dup_seed_row = winner
                return conn

        race_db = RaceDb()
        seed_happy(race_db)
        out = ToolExecutionClaimValidator(race_db).claim(base_claim())
        assert out["created"] is False
        assert out["workspace_id"] == WS
        assert out["execution"].execution_id == winner["execution_id"]

    def test_lock_order_preserved_with_workspace_validation(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        ToolExecutionClaimValidator(db).claim(base_claim())
        order = db.last_conn.lock_order if db.last_conn else []
        assert order[:4] == [
            "agent_sessions",
            "runs",
            "sandbox_sessions",
            "tool_executions",
        ]


class TestFinalize:
    def _claimed(self) -> tuple[ClaimFakeDatabase, ToolExecutionClaimValidator]:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        v.claim(base_claim())
        return db, v

    def test_finalize_running_to_success(self) -> None:
        db, v = self._claimed()
        out = v.finalize(
            {
                "org_id": ORG,
                "user_id": USER,
                "execution_id": EXEC,
                "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                "execution_fence_token": FENCE,
                "result_json": {"exitCode": 0},
                "exit_code": 0,
            }
        )
        assert out["changed"] is True
        assert out["execution"].status == SANDBOX_EXECUTION_STATUS_SUCCESS
        assert out["execution"].result_json == {"exitCode": 0}

    def test_finalize_idempotent_same_terminal(self) -> None:
        db, v = self._claimed()
        payload = {
            "org_id": ORG,
            "user_id": USER,
            "execution_id": EXEC,
            "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
            "execution_fence_token": FENCE,
            "result_json": {"ok": True},
            "exit_code": 0,
            "error_code": None,
        }
        v.finalize(payload)
        out = v.finalize(payload)
        assert out["changed"] is False
        assert out["execution"].status == SANDBOX_EXECUTION_STATUS_SUCCESS

    def test_finalize_result_conflict(self) -> None:
        db, v = self._claimed()
        v.finalize(
            {
                "org_id": ORG,
                "user_id": USER,
                "execution_id": EXEC,
                "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                "execution_fence_token": FENCE,
                "result_json": {"a": 1},
                "exit_code": 0,
            }
        )
        with pytest.raises(ConflictError, match="terminal conflict|result"):
            v.finalize(
                {
                    "org_id": ORG,
                    "user_id": USER,
                    "execution_id": EXEC,
                    "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                    "execution_fence_token": FENCE,
                    "result_json": {"a": 2},
                    "exit_code": 0,
                }
            )

    def test_finalize_exit_code_conflict(self) -> None:
        db, v = self._claimed()
        v.finalize(
            {
                "org_id": ORG,
                "user_id": USER,
                "execution_id": EXEC,
                "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                "execution_fence_token": FENCE,
                "result_json": {"ok": True},
                "exit_code": 0,
            }
        )
        with pytest.raises(ConflictError, match="terminal conflict"):
            v.finalize(
                {
                    "org_id": ORG,
                    "user_id": USER,
                    "execution_id": EXEC,
                    "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                    "execution_fence_token": FENCE,
                    "result_json": {"ok": True},
                    "exit_code": 1,
                }
            )

    def test_finalize_error_code_conflict(self) -> None:
        db, v = self._claimed()
        v.finalize(
            {
                "org_id": ORG,
                "user_id": USER,
                "execution_id": EXEC,
                "status": SANDBOX_EXECUTION_STATUS_FAILED,
                "execution_fence_token": FENCE,
                "result_json": {},
                "error_code": "E1",
            }
        )
        with pytest.raises(ConflictError, match="terminal conflict"):
            v.finalize(
                {
                    "org_id": ORG,
                    "user_id": USER,
                    "execution_id": EXEC,
                    "status": SANDBOX_EXECUTION_STATUS_FAILED,
                    "execution_fence_token": FENCE,
                    "result_json": {},
                    "error_code": "E2",
                }
            )

    def test_finalize_status_conflict(self) -> None:
        db, v = self._claimed()
        v.finalize(
            {
                "org_id": ORG,
                "user_id": USER,
                "execution_id": EXEC,
                "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                "execution_fence_token": FENCE,
                "result_json": {},
            }
        )
        with pytest.raises(ConflictError, match="terminal conflict"):
            v.finalize(
                {
                    "org_id": ORG,
                    "user_id": USER,
                    "execution_id": EXEC,
                    "status": SANDBOX_EXECUTION_STATUS_FAILED,
                    "execution_fence_token": FENCE,
                    "result_json": {},
                }
            )

    def test_finalize_fence_mismatch(self) -> None:
        db, v = self._claimed()
        with pytest.raises(ConflictError, match="fence"):
            v.finalize(
                {
                    "org_id": ORG,
                    "user_id": USER,
                    "execution_id": EXEC,
                    "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                    "execution_fence_token": 1,
                    "result_json": {},
                }
            )

    def test_finalize_foreign_owner_not_found(self) -> None:
        db, v = self._claimed()
        with pytest.raises(NotFoundError):
            v.finalize(
                {
                    "org_id": ORG,
                    "user_id": OTHER_USER,
                    "execution_id": EXEC,
                    "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                    "execution_fence_token": FENCE,
                    "result_json": {},
                }
            )

    def test_unknown_is_sticky(self) -> None:
        db, v = self._claimed()
        v.mark_unknown_for_crash_recovery(
            {
                "org_id": ORG,
                "user_id": USER,
                "execution_id": EXEC,
                "execution_fence_token": FENCE,
            }
        )
        assert db.store["sandbox_executions"][0]["status"] == (
            SANDBOX_EXECUTION_STATUS_UNKNOWN
        )
        with pytest.raises(ConflictError, match="UNKNOWN is sticky"):
            v.finalize(
                {
                    "org_id": ORG,
                    "user_id": USER,
                    "execution_id": EXEC,
                    "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
                    "execution_fence_token": FENCE,
                    "result_json": {},
                }
            )

    def test_crash_recovery_running_to_unknown(self) -> None:
        db, v = self._claimed()
        out = v.mark_unknown_for_crash_recovery(
            {
                "org_id": ORG,
                "user_id": USER,
                "execution_id": EXEC,
                "execution_fence_token": FENCE,
            }
        )
        assert out["changed"] is True
        assert out["execution"].status == SANDBOX_EXECUTION_STATUS_UNKNOWN
        assert out["execution"].error_code == "CRASH_RECOVERY_UNKNOWN"
        # Idempotent replay of same UNKNOWN
        out2 = v.mark_unknown_for_crash_recovery(
            {
                "org_id": ORG,
                "user_id": USER,
                "execution_id": EXEC,
                "execution_fence_token": FENCE,
            }
        )
        assert out2["changed"] is False

    def test_legacy_null_sandbox_row_not_replayable(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        db.store["sandbox_executions"] = [
            {
                "execution_id": EXEC,
                "org_id": ORG,
                "user_id": USER,
                "sandbox_session_id": SBX,
                "run_id": RUN,
                "agent_session_id": AGENT,
                "kind": "bash",
                "status": SANDBOX_EXECUTION_STATUS_RUNNING,
                "exit_code": None,
                "error_code": None,
                "trace_id": TRACE,
                "result_json": None,
                "started_at": None,
                "completed_at": None,
                "created_at": "2026-07-18 00:00:00.000",
                "tool_execution_id": None,
                "tool_call_id": TC,
                "request_hash": None,
                "request_hash_version": None,
                "execution_fence_token": None,
            }
        ]
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(ConflictError, match="NULL claim identity"):
            v.claim(base_claim())


class TestClaimSchemaCapabilityProbe:
    def test_missing_index_fail_closed(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        db.missing_claim_indexes.add(
            ("sandbox_executions", "uk_sandbox_execution_run_tool_call")
        )
        v = ToolExecutionClaimValidator(db)
        with pytest.raises(SchemaGapError, match="fail closed|missing"):
            v.claim(base_claim())

    def test_schema_capable_flag_skips_probe(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        db.claim_schema_capable = False
        v = ToolExecutionClaimValidator(db, schema_capable=True)
        out = v.claim(base_claim())
        assert out["created"] is True


class TestBlindUpdateStatusGuard:
    def test_update_status_refuses_claimed_row(self) -> None:
        db = ClaimFakeDatabase()
        seed_happy(db)
        v = ToolExecutionClaimValidator(db)
        v.claim(base_claim())
        repo = ExecutionRepository(db)
        with db.connection() as conn:
            with pytest.raises(ConflictError, match="claim identity|finalize"):
                repo.update_status(
                    conn,
                    EXEC,
                    {"org_id": ORG, "user_id": USER},
                    status=SANDBOX_EXECUTION_STATUS_SUCCESS,
                )

    def test_update_status_allows_legacy_row(self) -> None:
        db = ClaimFakeDatabase()
        # Legacy create via ExecutionRepository without claim fields
        repo = ExecutionRepository(db)
        with db.connection() as conn:
            repo.create(
                conn,
                {
                    "execution_id": EXEC,
                    "org_id": ORG,
                    "user_id": USER,
                    "sandbox_session_id": SBX,
                    "run_id": RUN,
                    "agent_session_id": AGENT,
                    "kind": "bash",
                    "status": SANDBOX_EXECUTION_STATUS_RUNNING,
                    "trace_id": TRACE,
                },
            )
            updated = repo.update_status(
                conn,
                EXEC,
                {"org_id": ORG, "user_id": USER},
                status=SANDBOX_EXECUTION_STATUS_SUCCESS,
                exit_code=0,
            )
            assert updated.status == SANDBOX_EXECUTION_STATUS_SUCCESS
