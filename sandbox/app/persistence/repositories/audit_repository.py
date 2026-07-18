"""Sandbox audit event repository — table ``sandbox_audit_events`` (PR-02).

Not domain_outbox. Owner scope via SQL predicates.
"""

from __future__ import annotations

from typing import Any

from sandbox.app.domain.types import AuditRecord, OwnerScope
from sandbox.app.persistence.errors import NotFoundError
from sandbox.app.persistence.mappers import dumps_json, map_audit, to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope
from sandbox.app.persistence.repositories._base import SupportsExecute, require_db
from sandbox.app.persistence.schema_gap import is_table_present

TABLE = "sandbox_audit_events"
assert is_table_present(TABLE)


class AuditRepository:
    """Append-oriented audit writes with mandatory owner scope on reads."""

    def __init__(self, db: Any) -> None:
        self.db = require_db(db, "AuditRepository")

    def insert(
        self,
        conn: SupportsExecute,
        input: dict[str, Any],
    ) -> AuditRecord:
        scope = require_owner_scope(input, resource=TABLE)
        now = to_mysql_datetime(input.get("created_at"))
        conn.execute(
            f"""
            INSERT INTO {TABLE} (
                audit_id, org_id, user_id, event_type, sandbox_session_id,
                execution_id, process_id, trace_id, payload_json, created_at
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (
                input["audit_id"],
                scope.org_id,
                scope.user_id,
                input["event_type"],
                input.get("sandbox_session_id"),
                input.get("execution_id"),
                input.get("process_id"),
                input.get("trace_id"),
                dumps_json(input.get("payload_json")),
                now,
            ),
        )
        row = self.get_by_id(conn, input["audit_id"], scope)
        if row is None:
            raise NotFoundError(
                "Audit event not found after insert",
                resource=TABLE,
                id=input["audit_id"],
            )
        return row

    def get_by_id(
        self,
        conn: SupportsExecute,
        audit_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> AuditRecord | None:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE audit_id = %s AND org_id = %s AND user_id = %s
            """,
            (audit_id, s.org_id, s.user_id),
        )
        row = conn.fetchone()
        return map_audit(row) if row else None

    def list_by_trace_id(
        self,
        conn: SupportsExecute,
        trace_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        limit: int = 200,
    ) -> list[AuditRecord]:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE trace_id = %s AND org_id = %s AND user_id = %s
            ORDER BY created_at ASC
            LIMIT %s
            """,
            (trace_id, s.org_id, s.user_id, int(limit)),
        )
        return [map_audit(r) for r in conn.fetchall()]

    def list_by_session(
        self,
        conn: SupportsExecute,
        sandbox_session_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        limit: int = 200,
    ) -> list[AuditRecord]:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE sandbox_session_id = %s AND org_id = %s AND user_id = %s
            ORDER BY created_at ASC
            LIMIT %s
            """,
            (sandbox_session_id, s.org_id, s.user_id, int(limit)),
        )
        return [map_audit(r) for r in conn.fetchall()]
