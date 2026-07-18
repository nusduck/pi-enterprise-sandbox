"""Process execution repository — aligned with plan §8.13 / Agent migration.

Table ``process_executions`` columns include org_id/user_id tenant ownership.
Owner scope is enforced via SQL predicates on every read/write path.
"""

from __future__ import annotations

from typing import Any

from sandbox.app.domain.types import OwnerScope, ProcessRecord
from sandbox.app.persistence.errors import NotFoundError
from sandbox.app.persistence.mappers import dumps_json, map_process, to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope
from sandbox.app.persistence.repositories._base import SupportsExecute, require_db
from sandbox.app.persistence.schema_gap import is_table_present

TABLE = "process_executions"
assert is_table_present(TABLE)


class ProcessRepository:
    """CRUD for process_executions with mandatory owner scope (SQL predicates)."""

    def __init__(self, db: Any) -> None:
        self.db = require_db(db, "ProcessRepository")

    def create(
        self,
        conn: SupportsExecute,
        input: dict[str, Any],
    ) -> ProcessRecord:
        scope = require_owner_scope(input, resource=TABLE)
        now = to_mysql_datetime(input.get("created_at"))
        conn.execute(
            f"""
            INSERT INTO {TABLE} (
                process_id, org_id, user_id, sandbox_session_id, run_id,
                execution_id, command_json, status, pid, exit_code,
                stdout_path, stderr_path, started_at, ended_at, created_at
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (
                input["process_id"],
                scope.org_id,
                scope.user_id,
                input["sandbox_session_id"],
                input["run_id"],
                input["execution_id"],
                dumps_json(input.get("command_json") or {}),
                input["status"],
                input.get("pid"),
                input.get("exit_code"),
                input.get("stdout_path"),
                input.get("stderr_path"),
                (
                    to_mysql_datetime(input["started_at"])
                    if input.get("started_at") is not None
                    else None
                ),
                (
                    to_mysql_datetime(input["ended_at"])
                    if input.get("ended_at") is not None
                    else None
                ),
                now,
            ),
        )
        row = self.get_by_id(conn, input["process_id"], scope)
        if row is None:
            raise NotFoundError(
                "Process not found after insert",
                resource=TABLE,
                id=input["process_id"],
            )
        return row

    def get_by_id(
        self,
        conn: SupportsExecute,
        process_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        sandbox_session_id: str | None = None,
    ) -> ProcessRecord | None:
        s = require_owner_scope(scope, resource=TABLE)
        if sandbox_session_id is not None:
            conn.execute(
                f"""
                SELECT * FROM {TABLE}
                WHERE process_id = %s AND org_id = %s AND user_id = %s
                  AND sandbox_session_id = %s
                """,
                (process_id, s.org_id, s.user_id, sandbox_session_id),
            )
        else:
            conn.execute(
                f"""
                SELECT * FROM {TABLE}
                WHERE process_id = %s AND org_id = %s AND user_id = %s
                """,
                (process_id, s.org_id, s.user_id),
            )
        row = conn.fetchone()
        return map_process(row) if row else None

    def require_by_id(
        self,
        conn: SupportsExecute,
        process_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        sandbox_session_id: str | None = None,
    ) -> ProcessRecord:
        row = self.get_by_id(
            conn,
            process_id,
            scope,
            sandbox_session_id=sandbox_session_id,
        )
        if row is None:
            raise NotFoundError(
                "Process not found",
                resource=TABLE,
                id=process_id,
            )
        return row

    def update_status(
        self,
        conn: SupportsExecute,
        process_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        status: str,
        sandbox_session_id: str | None = None,
        pid: int | None = None,
        exit_code: int | None = None,
        stdout_path: str | None = None,
        stderr_path: str | None = None,
        started_at: str | None = None,
        ended_at: str | None = None,
    ) -> ProcessRecord:
        s = require_owner_scope(scope, resource=TABLE)
        if sandbox_session_id is not None:
            conn.execute(
                f"""
                UPDATE {TABLE}
                SET status = %s,
                    pid = COALESCE(%s, pid),
                    exit_code = COALESCE(%s, exit_code),
                    stdout_path = COALESCE(%s, stdout_path),
                    stderr_path = COALESCE(%s, stderr_path),
                    started_at = COALESCE(%s, started_at),
                    ended_at = COALESCE(%s, ended_at)
                WHERE process_id = %s AND org_id = %s AND user_id = %s
                  AND sandbox_session_id = %s
                """,
                (
                    status,
                    pid,
                    exit_code,
                    stdout_path,
                    stderr_path,
                    to_mysql_datetime(started_at) if started_at is not None else None,
                    to_mysql_datetime(ended_at) if ended_at is not None else None,
                    process_id,
                    s.org_id,
                    s.user_id,
                    sandbox_session_id,
                ),
            )
        else:
            conn.execute(
                f"""
                UPDATE {TABLE}
                SET status = %s,
                    pid = COALESCE(%s, pid),
                    exit_code = COALESCE(%s, exit_code),
                    stdout_path = COALESCE(%s, stdout_path),
                    stderr_path = COALESCE(%s, stderr_path),
                    started_at = COALESCE(%s, started_at),
                    ended_at = COALESCE(%s, ended_at)
                WHERE process_id = %s AND org_id = %s AND user_id = %s
                """,
                (
                    status,
                    pid,
                    exit_code,
                    stdout_path,
                    stderr_path,
                    to_mysql_datetime(started_at) if started_at is not None else None,
                    to_mysql_datetime(ended_at) if ended_at is not None else None,
                    process_id,
                    s.org_id,
                    s.user_id,
                ),
            )
        if getattr(conn, "rowcount", 1) == 0:
            raise NotFoundError(
                "Process not found",
                resource=TABLE,
                id=process_id,
            )
        return self.require_by_id(
            conn, process_id, s, sandbox_session_id=sandbox_session_id
        )

    def list_by_sandbox_session(
        self,
        conn: SupportsExecute,
        sandbox_session_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        limit: int = 100,
    ) -> list[ProcessRecord]:
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
        return [map_process(r) for r in conn.fetchall()]

    def list_by_run(
        self,
        conn: SupportsExecute,
        run_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        limit: int = 100,
    ) -> list[ProcessRecord]:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE run_id = %s AND org_id = %s AND user_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (run_id, s.org_id, s.user_id, int(limit)),
        )
        return [map_process(r) for r in conn.fetchall()]
