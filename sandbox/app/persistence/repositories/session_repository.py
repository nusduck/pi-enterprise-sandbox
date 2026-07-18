"""Sandbox Session repository — table ``sandbox_sessions`` (PR-02 migration).

``agent_session_id`` is a logical indexed reference (no FK to agent_sessions).
Owner scope is enforced via SQL predicates on every read/write path.
"""

from __future__ import annotations

from typing import Any

from sandbox.app.domain.types import OwnerScope, SandboxSessionRecord
from sandbox.app.persistence.errors import NotFoundError
from sandbox.app.persistence.mappers import map_sandbox_session, to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope
from sandbox.app.persistence.repositories._base import SupportsExecute, require_db
from sandbox.app.persistence.schema_gap import is_table_present

TABLE = "sandbox_sessions"
assert is_table_present(TABLE)


class SessionRepository:
    """CRUD for Sandbox Sessions with mandatory owner scope."""

    def __init__(self, db: Any) -> None:
        self.db = require_db(db, "SessionRepository")

    def create(
        self,
        conn: SupportsExecute,
        input: dict[str, Any],
    ) -> SandboxSessionRecord:
        scope = require_owner_scope(input, resource=TABLE)
        now = to_mysql_datetime(input.get("created_at"))
        updated = to_mysql_datetime(input.get("updated_at") or input.get("created_at"))
        closed = (
            to_mysql_datetime(input["closed_at"])
            if input.get("closed_at") is not None
            else None
        )
        conn.execute(
            f"""
            INSERT INTO {TABLE} (
                sandbox_session_id, org_id, user_id, agent_session_id,
                workspace_id, status, created_at, updated_at, closed_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                input["sandbox_session_id"],
                scope.org_id,
                scope.user_id,
                input["agent_session_id"],
                input["workspace_id"],
                input["status"],
                now,
                updated,
                closed,
            ),
        )
        row = self.get_by_id(conn, input["sandbox_session_id"], scope)
        if row is None:
            raise NotFoundError(
                "Sandbox session not found after insert",
                resource=TABLE,
                id=input["sandbox_session_id"],
            )
        return row

    def get_by_id(
        self,
        conn: SupportsExecute,
        sandbox_session_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> SandboxSessionRecord | None:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE sandbox_session_id = %s AND org_id = %s AND user_id = %s
            """,
            (sandbox_session_id, s.org_id, s.user_id),
        )
        row = conn.fetchone()
        return map_sandbox_session(row) if row else None

    def require_by_id(
        self,
        conn: SupportsExecute,
        sandbox_session_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> SandboxSessionRecord:
        row = self.get_by_id(conn, sandbox_session_id, scope)
        if row is None:
            raise NotFoundError(
                "Sandbox session not found",
                resource=TABLE,
                id=sandbox_session_id,
            )
        return row

    def update_status(
        self,
        conn: SupportsExecute,
        sandbox_session_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        status: str,
        closed_at: str | None = None,
    ) -> SandboxSessionRecord:
        s = require_owner_scope(scope, resource=TABLE)
        now = to_mysql_datetime()
        closed = to_mysql_datetime(closed_at) if closed_at is not None else None
        conn.execute(
            f"""
            UPDATE {TABLE}
            SET status = %s, updated_at = %s, closed_at = COALESCE(%s, closed_at)
            WHERE sandbox_session_id = %s AND org_id = %s AND user_id = %s
            """,
            (status, now, closed, sandbox_session_id, s.org_id, s.user_id),
        )
        if getattr(conn, "rowcount", 1) == 0:
            raise NotFoundError(
                "Sandbox session not found",
                resource=TABLE,
                id=sandbox_session_id,
            )
        return self.require_by_id(conn, sandbox_session_id, s)

    def list_for_owner(
        self,
        conn: SupportsExecute,
        scope: OwnerScope | dict[str, str],
        *,
        status: str | None = None,
        limit: int = 50,
    ) -> list[SandboxSessionRecord]:
        s = require_owner_scope(scope, resource=TABLE)
        if status is not None:
            conn.execute(
                f"""
                SELECT * FROM {TABLE}
                WHERE org_id = %s AND user_id = %s AND status = %s
                ORDER BY updated_at DESC
                LIMIT %s
                """,
                (s.org_id, s.user_id, status, int(limit)),
            )
        else:
            conn.execute(
                f"""
                SELECT * FROM {TABLE}
                WHERE org_id = %s AND user_id = %s
                ORDER BY updated_at DESC
                LIMIT %s
                """,
                (s.org_id, s.user_id, int(limit)),
            )
        return [map_sandbox_session(r) for r in conn.fetchall()]
