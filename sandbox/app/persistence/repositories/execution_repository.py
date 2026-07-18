"""Sandbox Execution repository — table ``sandbox_executions`` (PR-02).

Not Agent ``tool_executions`` / ``runs``. Owner scope via SQL predicates.
"""

from __future__ import annotations

from typing import Any

from sandbox.app.domain.types import ExecutionRecord, OwnerScope
from sandbox.app.persistence.errors import ConflictError, NotFoundError
from sandbox.app.persistence.mappers import dumps_json, map_execution, to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope
from sandbox.app.persistence.repositories._base import SupportsExecute, require_db
from sandbox.app.persistence.schema_gap import is_table_present

TABLE = "sandbox_executions"
assert is_table_present(TABLE)


class ExecutionRepository:
    """CRUD for Sandbox executions with mandatory owner scope."""

    def __init__(self, db: Any) -> None:
        self.db = require_db(db, "ExecutionRepository")

    def create(
        self,
        conn: SupportsExecute,
        input: dict[str, Any],
    ) -> ExecutionRecord:
        scope = require_owner_scope(input, resource=TABLE)
        now = to_mysql_datetime(input.get("created_at"))
        conn.execute(
            f"""
            INSERT INTO {TABLE} (
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
                input["execution_id"],
                scope.org_id,
                scope.user_id,
                input["sandbox_session_id"],
                input["run_id"],
                input["agent_session_id"],
                input["kind"],
                input["status"],
                input.get("exit_code"),
                input.get("error_code"),
                input.get("trace_id"),
                dumps_json(input.get("result_json")),
                (
                    to_mysql_datetime(input["started_at"])
                    if input.get("started_at") is not None
                    else None
                ),
                (
                    to_mysql_datetime(input["completed_at"])
                    if input.get("completed_at") is not None
                    else None
                ),
                now,
                input.get("tool_execution_id"),
                input.get("tool_call_id"),
                input.get("request_hash"),
                input.get("request_hash_version"),
                input.get("execution_fence_token"),
            ),
        )
        row = self.get_by_id(conn, input["execution_id"], scope)
        if row is None:
            raise NotFoundError(
                "Execution not found after insert",
                resource=TABLE,
                id=input["execution_id"],
            )
        return row

    def get_by_id(
        self,
        conn: SupportsExecute,
        execution_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> ExecutionRecord | None:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE execution_id = %s AND org_id = %s AND user_id = %s
            """,
            (execution_id, s.org_id, s.user_id),
        )
        row = conn.fetchone()
        return map_execution(row) if row else None

    def require_by_id(
        self,
        conn: SupportsExecute,
        execution_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> ExecutionRecord:
        row = self.get_by_id(conn, execution_id, scope)
        if row is None:
            raise NotFoundError(
                "Execution not found",
                resource=TABLE,
                id=execution_id,
            )
        return row

    def update_status(
        self,
        conn: SupportsExecute,
        execution_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        status: str,
        exit_code: int | None = None,
        error_code: str | None = None,
        result_json: dict[str, Any] | None = None,
        started_at: str | None = None,
        completed_at: str | None = None,
    ) -> ExecutionRecord:
        s = require_owner_scope(scope, resource=TABLE)
        # PR-07B: refuse blind updates on claimed rows (any claim identity set).
        existing = self.get_by_id(conn, execution_id, s)
        if existing is None:
            raise NotFoundError(
                "Execution not found",
                resource=TABLE,
                id=execution_id,
            )
        if (
            existing.tool_execution_id is not None
            or existing.tool_call_id is not None
            or existing.request_hash is not None
            or existing.request_hash_version is not None
            or existing.execution_fence_token is not None
        ):
            raise ConflictError(
                "sandbox execution has PR-07B claim identity fields; "
                "refuse blind update_status — use ToolExecutionClaimValidator.finalize",
                resource=TABLE,
                id=execution_id,
            )
        conn.execute(
            f"""
            UPDATE {TABLE}
            SET status = %s,
                exit_code = COALESCE(%s, exit_code),
                error_code = COALESCE(%s, error_code),
                result_json = COALESCE(%s, result_json),
                started_at = COALESCE(%s, started_at),
                completed_at = COALESCE(%s, completed_at)
            WHERE execution_id = %s AND org_id = %s AND user_id = %s
            """,
            (
                status,
                exit_code,
                error_code,
                dumps_json(result_json) if result_json is not None else None,
                to_mysql_datetime(started_at) if started_at is not None else None,
                to_mysql_datetime(completed_at) if completed_at is not None else None,
                execution_id,
                s.org_id,
                s.user_id,
            ),
        )
        if getattr(conn, "rowcount", 1) == 0:
            raise NotFoundError(
                "Execution not found",
                resource=TABLE,
                id=execution_id,
            )
        return self.require_by_id(conn, execution_id, s)

    def list_by_session(
        self,
        conn: SupportsExecute,
        sandbox_session_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        limit: int = 100,
    ) -> list[ExecutionRecord]:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE sandbox_session_id = %s AND org_id = %s AND user_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (sandbox_session_id, s.org_id, s.user_id, int(limit)),
        )
        return [map_execution(r) for r in conn.fetchall()]
