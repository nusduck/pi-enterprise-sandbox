"""Atomic Sandbox tool-execution claim validator (PR-07B batch 2B).

Owns its DB transaction for authoritative claim validation, insert, and
finalize CAS. No HTTP / HMAC / Redis / FastAPI in this batch.

Lock / validation order within one transaction:
  1. agent_sessions     FOR SHARE
  2. runs               FOR SHARE
  3. sandbox_sessions   FOR SHARE
  4. tool_executions    FOR UPDATE
  5. sandbox_executions FOR UPDATE / reload

Parent SHARE locks prevent lifecycle/fence changes while allowing distinct
tool calls to proceed concurrently.

Owner masking: foreign-owner resources → NotFoundError.
Same-owner binding/status/hash/fence mismatches → ConflictError.
Legacy rows with nullable identity fields fail closed.
"""

from __future__ import annotations

import json
from typing import Any

from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
    SANDBOX_EXECUTION_TERMINAL_STATUSES,
    ExecutionRecord,
    OwnerScope,
    can_transition_sandbox_execution,
    is_terminal_sandbox_execution_status,
)
from sandbox.app.persistence.errors import (
    ConflictError,
    IdempotencyKeyReuseError,
    NotFoundError,
    SchemaGapError,
)
from sandbox.app.persistence.mappers import dumps_json, map_execution, to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope
from sandbox.app.persistence.repositories._base import require_db
from sandbox.security.path_validation import validate_formal_id

# MySQL ER_DUP_ENTRY — only duplicate error caught on claim insert.
MYSQL_ER_DUP_ENTRY = 1062

REQUEST_HASH_RE_LEN = 64
TOOL_SOURCE_SANDBOX = "sandbox"
AGENT_SESSION_ACTIVE = "ACTIVE"
RUN_STATUS_RUNNING = "RUNNING"
SANDBOX_SESSION_RUNNING = "RUNNING"

# PR-07B claim capability (migration 20260718000008) — readonly probe targets.
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
CLAIM_REQUIRED_INDEXES: tuple[tuple[str, str], ...] = (
    ("sandbox_executions", "uk_sandbox_execution_run_tool_call"),
    ("sandbox_executions", "uk_sandbox_execution_tool_execution"),
)


def _is_mysql_dup(err: BaseException) -> bool:
    """True only for MySQL duplicate-key error 1062 (never swallow others)."""
    args = getattr(err, "args", ())
    if args and args[0] == MYSQL_ER_DUP_ENTRY:
        return True
    code = getattr(err, "args", (None,))[0] if getattr(err, "args", None) else None
    if code == MYSQL_ER_DUP_ENTRY:
        return True
    # PyMySQL: err.args[0] is errno; also support .errno
    errno = getattr(err, "errno", None)
    if errno == MYSQL_ER_DUP_ENTRY:
        return True
    # Some fakes raise Exception("1062 ...") or code attr
    if getattr(err, "code", None) in (MYSQL_ER_DUP_ENTRY, "ER_DUP_ENTRY", 1062):
        return True
    return False


def _require_positive_int(value: Any, field: str) -> int:
    """Strict positive int: reject bool, str, float (incl. 1.0), None, etc."""
    if type(value) is not int:  # noqa: E721 — bool is subclass of int
        raise ConflictError(f"{field} must be a positive integer")
    if value <= 0:
        raise ConflictError(f"{field} must be a positive integer")
    return value


def _require_request_hash(value: Any) -> str:
    if not isinstance(value, str) or len(value) != REQUEST_HASH_RE_LEN:
        raise ConflictError("request_hash must be 64 hex chars")
    # lowercase hex only
    if any(c not in "0123456789abcdef" for c in value):
        raise ConflictError("request_hash must be 64 lowercase hex chars")
    return value


def _strict_json_dumps(value: Any) -> str:
    """Canonical JSON for equality — never default=str (collapses types)."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _result_equal(a: Any, b: Any) -> bool:
    """Compare result payloads for finalize idempotency (strict JSON)."""
    if a is None and b is None:
        return True
    if a is None or b is None:
        return False
    try:
        return _strict_json_dumps(a) == _strict_json_dumps(b)
    except (TypeError, ValueError):
        return False


def _nullable_scalar_equal(a: Any, b: Any) -> bool:
    """Strict equality for exit_code / error_code (None vs value is conflict)."""
    return a == b


class ToolExecutionClaimValidator:
    """Authoritative claim + finalize for Sandbox executions.

    Construct with a MysqlDatabase (or compatible) that exposes
    ``transaction()`` / ``connection()``.

    On first claim/finalize (unless ``schema_capable=True``), runs a readonly
    INFORMATION_SCHEMA probe for claim columns/indexes. Missing schema fails
    closed with :class:`SchemaGapError`. No DDL is ever issued.
    """

    def __init__(
        self,
        db: Any,
        *,
        schema_capable: bool = False,
    ) -> None:
        self.db = require_db(db, "ToolExecutionClaimValidator")
        # When True, skip live probe (hermetic fakes / pre-validated install).
        self._schema_capable = bool(schema_capable)

    # ── public API ──────────────────────────────────────────────────────

    def probe_claim_schema_capability(self, conn: Any) -> None:
        """Readonly schema/index capability probe for claim path.

        Uses INFORMATION_SCHEMA only (no DDL). Missing columns or unique indexes
        raise :class:`SchemaGapError` (fail closed).
        """
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
                row = conn.fetchone()
                if row is None:
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
            row = conn.fetchone()
            if row is None:
                missing.append(f"index:{table}.{index_name}")

        if missing:
            raise SchemaGapError(
                "claim schema capability missing (fail closed): "
                + ", ".join(missing),
                table="sandbox_executions",
            )
        self._schema_capable = True

    def ensure_claim_schema_capability(self, conn: Any) -> None:
        """Run probe once per validator instance; subsequent calls are no-ops."""
        if self._schema_capable:
            return
        self.probe_claim_schema_capability(conn)

    def claim(self, input: dict[str, Any]) -> dict[str, Any]:
        """Validate bindings and atomically claim (insert RUNNING) or replay.

        Returns ``{"created": bool, "execution": ExecutionRecord,
        "workspace_id": str}``. ``workspace_id`` is the lock-validated formal
        ULID from agent_sessions / sandbox_sessions (never from HTTP/body).
        Only ``created=True`` may launch work.
        """
        scope = require_owner_scope(input, resource="sandbox_executions")
        claim = self._normalize_claim_input(input, scope)

        with self.db.transaction() as conn:
            self.ensure_claim_schema_capability(conn)
            workspace_id = self._lock_and_validate_parents(conn, claim, scope)
            claim["workspace_id"] = workspace_id
            tool_row = self._lock_and_validate_tool_execution(conn, claim, scope)
            # Ensure tool_execution_id from locked row is authoritative.
            claim["tool_execution_id"] = str(tool_row["tool_execution_id"])

            existing = self._lock_sandbox_execution_by_run_tool_call(
                conn, claim["run_id"], claim["tool_call_id"], for_update=True
            )
            if existing is not None:
                return self._replay_or_conflict(existing, claim, scope)

            try:
                created = self._insert_running(conn, claim, scope)
                return {
                    "created": True,
                    "execution": created,
                    "workspace_id": claim["workspace_id"],
                }
            except Exception as err:
                if not _is_mysql_dup(err):
                    raise
                # Race: another claim won. Reload by run+tool_call_id.
                again = self._lock_sandbox_execution_by_run_tool_call(
                    conn, claim["run_id"], claim["tool_call_id"], for_update=True
                )
                if again is None:
                    # Duplicate may have hit uk_tool_execution_id without a
                    # matching run+tool_call row — data conflict.
                    te_row = self._find_sandbox_by_tool_execution_id(
                        conn, claim["tool_execution_id"]
                    )
                    if te_row is not None:
                        raise ConflictError(
                            "claim data conflict: unique tool_execution_id "
                            "exists without matching run_id+tool_call_id row",
                            resource="sandbox_executions",
                            id=claim["tool_execution_id"],
                        ) from err
                    raise ConflictError(
                        "claim duplicate without reloadable row "
                        "(run_id+tool_call_id)",
                        resource="sandbox_executions",
                        id=f"{claim['run_id']}:{claim['tool_call_id']}",
                    ) from err
                return self._replay_or_conflict(again, claim, scope)

    def finalize(self, input: dict[str, Any]) -> dict[str, Any]:
        """CAS finalize RUNNING → terminal under owner + origin fence.

        Returns ``{"changed": bool, "execution": ExecutionRecord}``.
        Identical terminal status+result on rowcount=0 is idempotent.
        """
        scope = require_owner_scope(input, resource="sandbox_executions")
        execution_id = str(input["execution_id"]).strip()
        to_status = str(input["status"]).strip()
        if to_status not in SANDBOX_EXECUTION_TERMINAL_STATUSES:
            raise ConflictError(
                f"finalize requires terminal status, got {to_status}",
                resource="sandbox_executions",
                id=execution_id,
            )
        origin_fence = _require_positive_int(
            input.get("execution_fence_token"), "execution_fence_token"
        )
        result_json = input.get("result_json")
        exit_code = input.get("exit_code")
        error_code = input.get("error_code")

        with self.db.transaction() as conn:
            self.ensure_claim_schema_capability(conn)
            # Reload under owner for update (lock).
            row = self._lock_sandbox_execution_by_id(conn, execution_id, scope)
            if row is None:
                raise NotFoundError(
                    "Execution not found",
                    resource="sandbox_executions",
                    id=execution_id,
                )

            # Fence mismatch under same owner → Conflict (not NotFound).
            row_fence = row.get("execution_fence_token")
            if row_fence is None or int(row_fence) != origin_fence:
                raise ConflictError(
                    "finalize fence mismatch",
                    resource="sandbox_executions",
                    id=execution_id,
                )

            if row["status"] == SANDBOX_EXECUTION_STATUS_RUNNING:
                if not can_transition_sandbox_execution(
                    SANDBOX_EXECUTION_STATUS_RUNNING, to_status
                ):
                    raise ConflictError(
                        f"illegal finalize transition RUNNING → {to_status}",
                        resource="sandbox_executions",
                        id=execution_id,
                    )
                completed_at = to_mysql_datetime(input.get("completed_at"))
                conn.execute(
                    """
                    UPDATE sandbox_executions
                    SET status = %s,
                        result_json = %s,
                        exit_code = %s,
                        error_code = %s,
                        completed_at = %s
                    WHERE execution_id = %s
                      AND org_id = %s
                      AND user_id = %s
                      AND status = %s
                      AND execution_fence_token = %s
                    """,
                    (
                        to_status,
                        dumps_json(result_json) if result_json is not None else None,
                        exit_code,
                        error_code,
                        completed_at,
                        execution_id,
                        scope.org_id,
                        scope.user_id,
                        SANDBOX_EXECUTION_STATUS_RUNNING,
                        origin_fence,
                    ),
                )
                if getattr(conn, "rowcount", 0) == 1:
                    updated = self._get_execution_by_id(conn, execution_id, scope)
                    assert updated is not None
                    return {"changed": True, "execution": updated}
                # Lost race — fall through to reload idempotency check.
                row = self._lock_sandbox_execution_by_id(conn, execution_id, scope)
                if row is None:
                    raise NotFoundError(
                        "Execution not found after finalize race",
                        resource="sandbox_executions",
                        id=execution_id,
                    )

            # rowcount=0 or already terminal: idempotent if identical.
            return self._finalize_reload_idempotent(
                row,
                to_status,
                result_json,
                exit_code,
                error_code,
                scope,
                execution_id,
                origin_fence,
            )

    def mark_unknown_for_crash_recovery(self, input: dict[str, Any]) -> dict[str, Any]:
        """Crash recovery: leftover RUNNING → UNKNOWN (no auto-retry).

        Sticky UNKNOWN. Does not relaunch. Same CAS owner+fence+RUNNING.
        """
        payload = dict(input)
        payload["status"] = SANDBOX_EXECUTION_STATUS_UNKNOWN
        if "result_json" not in payload:
            payload["result_json"] = {
                "unknown": True,
                "reason": "CRASH_RECOVERY",
            }
        if "error_code" not in payload:
            payload["error_code"] = "CRASH_RECOVERY_UNKNOWN"
        return self.finalize(payload)

    # ── claim helpers ───────────────────────────────────────────────────

    def _normalize_claim_input(
        self, input: dict[str, Any], scope: OwnerScope
    ) -> dict[str, Any]:
        required_str = (
            "execution_id",
            "sandbox_session_id",
            "run_id",
            "agent_session_id",
            "conversation_id",
            "tool_execution_id",
            "tool_call_id",
            "tool_name",
            "kind",
            "request_hash",
        )
        out: dict[str, Any] = {
            "org_id": scope.org_id,
            "user_id": scope.user_id,
        }
        for key in required_str:
            raw = input.get(key)
            if raw is None or str(raw).strip() == "":
                raise ConflictError(f"claim requires {key}")
            out[key] = str(raw).strip()
        out["request_hash"] = _require_request_hash(out["request_hash"])
        out["request_hash_version"] = _require_positive_int(
            input.get("request_hash_version"), "request_hash_version"
        )
        out["execution_fence_token"] = _require_positive_int(
            input.get("execution_fence_token"), "execution_fence_token"
        )
        # Current internal contract: kind is the tool identity name.
        if out["kind"] != out["tool_name"]:
            raise ConflictError(
                f"claim requires kind == tool_name (got kind={out['kind']!r}, "
                f"tool_name={out['tool_name']!r})",
                resource="sandbox_executions",
            )
        out["trace_id"] = (
            str(input["trace_id"]).strip()
            if input.get("trace_id") is not None
            else None
        )
        return out

    def _lock_and_validate_parents(
        self,
        conn: Any,
        claim: dict[str, Any],
        scope: OwnerScope,
    ) -> str:
        """Lock parents and return the validated formal workspace_id ULID.

        ``agent_sessions.workspace_id`` and ``sandbox_sessions.workspace_id``
        must both be formal ULIDs and equal. Missing / invalid / mismatch are
        always ConflictError (never owner-masked NotFound) so existence of
        another tenant's workspace cannot leak.
        """
        # 1) agent_sessions FOR SHARE
        conn.execute(
            """
            SELECT * FROM agent_sessions
            WHERE agent_session_id = %s
            FOR SHARE
            """,
            (claim["agent_session_id"],),
        )
        agent = conn.fetchone()
        if agent is None or str(agent.get("org_id")) != scope.org_id or str(
            agent.get("user_id")
        ) != scope.user_id:
            raise NotFoundError(
                "Agent session not found",
                resource="agent_sessions",
                id=claim["agent_session_id"],
            )
        if str(agent.get("status")) != AGENT_SESSION_ACTIVE:
            raise ConflictError(
                f"agent session must be ACTIVE (got {agent.get('status')})",
                resource="agent_sessions",
                id=claim["agent_session_id"],
            )
        if str(agent.get("conversation_id")) != claim["conversation_id"]:
            raise ConflictError(
                "agent session conversation_id mismatch",
                resource="agent_sessions",
                id=claim["agent_session_id"],
            )
        if str(agent.get("sandbox_session_id")) != claim["sandbox_session_id"]:
            raise ConflictError(
                "agent session sandbox_session_id binding mismatch",
                resource="agent_sessions",
                id=claim["agent_session_id"],
            )
        session_fence = agent.get("execution_fence_token")
        if session_fence is None or int(session_fence) != claim["execution_fence_token"]:
            raise ConflictError(
                "agent session execution_fence_token mismatch",
                resource="agent_sessions",
                id=claim["agent_session_id"],
            )
        agent_workspace_id = self._require_formal_workspace_id(
            agent.get("workspace_id"),
            field="agent_sessions.workspace_id",
            resource="agent_sessions",
            resource_id=claim["agent_session_id"],
        )

        # 2) runs FOR SHARE
        conn.execute(
            """
            SELECT * FROM runs
            WHERE run_id = %s
            FOR SHARE
            """,
            (claim["run_id"],),
        )
        run = conn.fetchone()
        if run is None or str(run.get("org_id")) != scope.org_id or str(
            run.get("user_id")
        ) != scope.user_id:
            raise NotFoundError(
                "Run not found",
                resource="runs",
                id=claim["run_id"],
            )
        if str(run.get("status")) != RUN_STATUS_RUNNING:
            raise ConflictError(
                f"run must be RUNNING (got {run.get('status')})",
                resource="runs",
                id=claim["run_id"],
            )
        if str(run.get("conversation_id")) != claim["conversation_id"]:
            raise ConflictError(
                "run conversation_id mismatch",
                resource="runs",
                id=claim["run_id"],
            )
        if str(run.get("agent_session_id")) != claim["agent_session_id"]:
            raise ConflictError(
                "run agent_session_id mismatch",
                resource="runs",
                id=claim["run_id"],
            )

        # 3) sandbox_sessions FOR SHARE
        conn.execute(
            """
            SELECT * FROM sandbox_sessions
            WHERE sandbox_session_id = %s
            FOR SHARE
            """,
            (claim["sandbox_session_id"],),
        )
        sbx = conn.fetchone()
        if sbx is None or str(sbx.get("org_id")) != scope.org_id or str(
            sbx.get("user_id")
        ) != scope.user_id:
            raise NotFoundError(
                "Sandbox session not found",
                resource="sandbox_sessions",
                id=claim["sandbox_session_id"],
            )
        if str(sbx.get("status")) != SANDBOX_SESSION_RUNNING:
            raise ConflictError(
                f"sandbox session must be RUNNING (got {sbx.get('status')})",
                resource="sandbox_sessions",
                id=claim["sandbox_session_id"],
            )
        # Bidirectional binding
        if str(sbx.get("agent_session_id")) != claim["agent_session_id"]:
            raise ConflictError(
                "sandbox session agent_session_id binding mismatch",
                resource="sandbox_sessions",
                id=claim["sandbox_session_id"],
            )
        sbx_workspace_id = self._require_formal_workspace_id(
            sbx.get("workspace_id"),
            field="sandbox_sessions.workspace_id",
            resource="sandbox_sessions",
            resource_id=claim["sandbox_session_id"],
        )
        if agent_workspace_id != sbx_workspace_id:
            raise ConflictError(
                "workspace_id mismatch between agent_sessions and "
                "sandbox_sessions",
                resource="sandbox_sessions",
                id=claim["sandbox_session_id"],
            )
        return agent_workspace_id

    @staticmethod
    def _require_formal_workspace_id(
        value: Any,
        *,
        field: str,
        resource: str,
        resource_id: str,
    ) -> str:
        """Strict formal ULID for parent workspace_id (Conflict on any defect)."""
        if value is None or (isinstance(value, str) and value.strip() == ""):
            raise ConflictError(
                f"{field} is required (formal ULID)",
                resource=resource,
                id=resource_id,
            )
        if not isinstance(value, str):
            raise ConflictError(
                f"{field} must be a formal ULID string",
                resource=resource,
                id=resource_id,
            )
        try:
            return validate_formal_id(value, field)
        except ValueError as exc:
            raise ConflictError(
                f"{field} must be a formal ULID",
                resource=resource,
                id=resource_id,
            ) from exc

    def _lock_and_validate_tool_execution(
        self,
        conn: Any,
        claim: dict[str, Any],
        scope: OwnerScope,
    ) -> dict[str, Any]:
        # 4) tool_executions FOR UPDATE — direct row lock only.
        # Run was already owner-validated under FOR SHARE; joining runs here
        # with FOR UPDATE would upgrade the Run to exclusive and serialize
        # concurrent tool claims on the same run.
        conn.execute(
            """
            SELECT *
            FROM tool_executions
            WHERE run_id = %s
              AND tool_call_id = %s
            FOR UPDATE
            """,
            (
                claim["run_id"],
                claim["tool_call_id"],
            ),
        )
        te = conn.fetchone()
        if te is None:
            raise NotFoundError(
                "Tool execution not found",
                resource="tool_executions",
                id=f"{claim['run_id']}:{claim['tool_call_id']}",
            )
        # ToolExecution has no org/user columns — ownership is via the already
        # validated Run (same run_id under owner scope).

        # Exact identity bindings
        if str(te.get("tool_execution_id")) != claim["tool_execution_id"]:
            raise ConflictError(
                "tool_execution_id mismatch for run+tool_call_id",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )
        if str(te.get("agent_session_id")) != claim["agent_session_id"]:
            raise ConflictError(
                "tool execution agent_session_id mismatch",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )
        if str(te.get("tool_source")) != TOOL_SOURCE_SANDBOX:
            raise ConflictError(
                f"tool_source must be sandbox (got {te.get('tool_source')})",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )
        if str(te.get("tool_name")) != claim["tool_name"]:
            raise ConflictError(
                "tool_name mismatch",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )
        if str(te.get("status")) != SANDBOX_EXECUTION_STATUS_RUNNING:
            # Agent ToolExecution status uses RUNNING same token.
            raise ConflictError(
                f"tool execution must be RUNNING (got {te.get('status')})",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )

        # Legacy NULL identity fields fail closed.
        te_hash = te.get("request_hash")
        te_ver = te.get("request_hash_version")
        te_fence = te.get("execution_fence_token")
        if te_hash is None or te_ver is None or te_fence is None:
            raise ConflictError(
                "legacy tool_execution with NULL request identity fields "
                "is not claimable (fail closed)",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )
        if str(te_hash) != claim["request_hash"]:
            raise ConflictError(
                "request_hash mismatch",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )
        if int(te_ver) != claim["request_hash_version"]:
            raise ConflictError(
                "request_hash_version mismatch",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )
        if int(te_fence) != claim["execution_fence_token"]:
            raise ConflictError(
                "execution_fence_token mismatch on tool_execution",
                resource="tool_executions",
                id=str(te.get("tool_execution_id")),
            )
        return te

    def _lock_sandbox_execution_by_run_tool_call(
        self,
        conn: Any,
        run_id: str,
        tool_call_id: str,
        *,
        for_update: bool,
    ) -> dict[str, Any] | None:
        lock = " FOR UPDATE" if for_update else ""
        conn.execute(
            f"""
            SELECT * FROM sandbox_executions
            WHERE run_id = %s AND tool_call_id = %s
            {lock}
            """,
            (run_id, tool_call_id),
        )
        return conn.fetchone()

    def _lock_sandbox_execution_by_id(
        self,
        conn: Any,
        execution_id: str,
        scope: OwnerScope,
    ) -> dict[str, Any] | None:
        conn.execute(
            """
            SELECT * FROM sandbox_executions
            WHERE execution_id = %s AND org_id = %s AND user_id = %s
            FOR UPDATE
            """,
            (execution_id, scope.org_id, scope.user_id),
        )
        return conn.fetchone()

    def _find_sandbox_by_tool_execution_id(
        self,
        conn: Any,
        tool_execution_id: str,
    ) -> dict[str, Any] | None:
        conn.execute(
            """
            SELECT * FROM sandbox_executions
            WHERE tool_execution_id = %s
            """,
            (tool_execution_id,),
        )
        return conn.fetchone()

    def _get_execution_by_id(
        self,
        conn: Any,
        execution_id: str,
        scope: OwnerScope,
    ) -> ExecutionRecord | None:
        conn.execute(
            """
            SELECT * FROM sandbox_executions
            WHERE execution_id = %s AND org_id = %s AND user_id = %s
            """,
            (execution_id, scope.org_id, scope.user_id),
        )
        row = conn.fetchone()
        return map_execution(row) if row else None

    def _identity_equal(self, row: dict[str, Any], claim: dict[str, Any]) -> bool:
        """Complete immutable identity + kind + hash/version equality for replay."""
        checks = (
            ("tool_execution_id", claim["tool_execution_id"]),
            ("tool_call_id", claim["tool_call_id"]),
            ("run_id", claim["run_id"]),
            ("agent_session_id", claim["agent_session_id"]),
            ("sandbox_session_id", claim["sandbox_session_id"]),
            ("org_id", claim["org_id"]),
            ("user_id", claim["user_id"]),
            ("kind", claim["kind"]),
            ("request_hash", claim["request_hash"]),
        )
        for col, want in checks:
            if row.get(col) is None or str(row.get(col)) != str(want):
                return False
        if row.get("request_hash_version") is None:
            return False
        if int(row["request_hash_version"]) != claim["request_hash_version"]:
            return False
        if row.get("execution_fence_token") is None:
            return False
        if int(row["execution_fence_token"]) != claim["execution_fence_token"]:
            return False
        return True

    def _replay_or_conflict(
        self,
        row: dict[str, Any],
        claim: dict[str, Any],
        scope: OwnerScope,
    ) -> dict[str, Any]:
        # Foreign-owner row under same run+tool_call (shouldn't happen with uniques)
        if str(row.get("org_id")) != scope.org_id or str(row.get("user_id")) != scope.user_id:
            raise NotFoundError(
                "Execution not found",
                resource="sandbox_executions",
                id=str(row.get("execution_id")),
            )
        # Legacy NULL identity on sandbox row fail closed
        if (
            row.get("tool_execution_id") is None
            or row.get("tool_call_id") is None
            or row.get("request_hash") is None
            or row.get("request_hash_version") is None
            or row.get("execution_fence_token") is None
        ):
            raise ConflictError(
                "legacy sandbox_execution with NULL claim identity is not "
                "replayable (fail closed)",
                resource="sandbox_executions",
                id=str(row.get("execution_id")),
            )
        if not self._identity_equal(row, claim):
            raise IdempotencyKeyReuseError(
                "idempotency-key-reuse conflict: existing sandbox_execution "
                "has different identity/hash/version/fence/kind",
                resource="sandbox_executions",
                id=str(row.get("execution_id")),
            )
        return {
            "created": False,
            "execution": map_execution(row),
            "workspace_id": claim["workspace_id"],
        }

    def _insert_running(
        self,
        conn: Any,
        claim: dict[str, Any],
        scope: OwnerScope,
    ) -> ExecutionRecord:
        now = to_mysql_datetime()
        conn.execute(
            """
            INSERT INTO sandbox_executions (
                execution_id, org_id, user_id, sandbox_session_id, run_id,
                agent_session_id, kind, status, exit_code, error_code, trace_id,
                result_json, started_at, completed_at, created_at,
                tool_execution_id, tool_call_id, request_hash,
                request_hash_version, execution_fence_token
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s
            )
            """,
            (
                claim["execution_id"],
                scope.org_id,
                scope.user_id,
                claim["sandbox_session_id"],
                claim["run_id"],
                claim["agent_session_id"],
                claim["kind"],
                SANDBOX_EXECUTION_STATUS_RUNNING,
                None,
                None,
                claim.get("trace_id"),
                None,
                now,
                None,
                now,
                claim["tool_execution_id"],
                claim["tool_call_id"],
                claim["request_hash"],
                claim["request_hash_version"],
                claim["execution_fence_token"],
            ),
        )
        row = self._get_execution_by_id(conn, claim["execution_id"], scope)
        if row is None:
            raise NotFoundError(
                "Execution not found after claim insert",
                resource="sandbox_executions",
                id=claim["execution_id"],
            )
        return row

    def _finalize_reload_idempotent(
        self,
        row: dict[str, Any],
        to_status: str,
        result_json: Any,
        exit_code: Any,
        error_code: Any,
        scope: OwnerScope,
        execution_id: str,
        origin_fence: int,
    ) -> dict[str, Any]:
        status = str(row.get("status"))
        mapped = map_execution(row)
        row_fence = row.get("execution_fence_token")
        if row_fence is None or int(row_fence) != origin_fence:
            raise ConflictError(
                "finalize fence mismatch on terminal replay",
                resource="sandbox_executions",
                id=execution_id,
            )

        def _terminal_fields_match() -> bool:
            if status != to_status:
                return False
            if not _result_equal(mapped.result_json, result_json):
                return False
            if not _nullable_scalar_equal(mapped.exit_code, exit_code):
                return False
            if not _nullable_scalar_equal(mapped.error_code, error_code):
                return False
            return True

        if status == SANDBOX_EXECUTION_STATUS_UNKNOWN:
            # UNKNOWN is sticky — only identical full terminal fields is idempotent.
            if to_status != SANDBOX_EXECUTION_STATUS_UNKNOWN:
                raise ConflictError(
                    "UNKNOWN is sticky; cannot finalize to a different status",
                    resource="sandbox_executions",
                    id=execution_id,
                )
            if not _terminal_fields_match():
                raise ConflictError(
                    "finalize UNKNOWN terminal field conflict on replay "
                    "(status/result/exit_code/error_code)",
                    resource="sandbox_executions",
                    id=execution_id,
                )
            return {"changed": False, "execution": mapped}

        if is_terminal_sandbox_execution_status(status):
            if not _terminal_fields_match():
                raise ConflictError(
                    f"finalize terminal conflict: have status={status} "
                    f"exit_code={mapped.exit_code!r} error_code={mapped.error_code!r}; "
                    f"request status={to_status} exit_code={exit_code!r} "
                    f"error_code={error_code!r} (or result mismatch)",
                    resource="sandbox_executions",
                    id=execution_id,
                )
            return {"changed": False, "execution": mapped}

        raise ConflictError(
            f"cannot finalize from status {status}",
            resource="sandbox_executions",
            id=execution_id,
        )
