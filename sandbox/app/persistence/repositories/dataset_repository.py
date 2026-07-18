"""Dataset repository — aligned with plan §8.14 / Agent migration ``datasets``.

Owner scope (org_id + user_id) is mandatory on every read/write.
"""

from __future__ import annotations

from typing import Any

from sandbox.app.domain.types import DatasetRecord, OwnerScope
from sandbox.app.persistence.errors import NotFoundError
from sandbox.app.persistence.mappers import map_dataset, to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope
from sandbox.app.persistence.repositories._base import SupportsExecute, require_db
from sandbox.app.persistence.schema_gap import is_table_present

TABLE = "datasets"
assert is_table_present(TABLE)


class DatasetRepository:
    """CRUD for datasets with mandatory owner scope."""

    def __init__(self, db: Any) -> None:
        self.db = require_db(db, "DatasetRepository")

    def create(
        self,
        conn: SupportsExecute,
        input: dict[str, Any],
    ) -> DatasetRecord:
        scope = require_owner_scope(input, resource=TABLE)
        now = to_mysql_datetime(input.get("created_at"))
        conn.execute(
            f"""
            INSERT INTO {TABLE} (
                dataset_id, org_id, user_id, conversation_id, agent_session_id,
                original_filename, stored_relative_path, mime_type, size_bytes,
                sha256, status, created_at, completed_at
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (
                input["dataset_id"],
                scope.org_id,
                scope.user_id,
                input["conversation_id"],
                input["agent_session_id"],
                input["original_filename"],
                input["stored_relative_path"],
                input.get("mime_type"),
                input.get("size_bytes"),
                input.get("sha256"),
                input["status"],
                now,
                (
                    to_mysql_datetime(input["completed_at"])
                    if input.get("completed_at") is not None
                    else None
                ),
            ),
        )
        row = self.get_by_id(conn, input["dataset_id"], scope)
        if row is None:
            raise NotFoundError(
                "Dataset not found after insert",
                resource=TABLE,
                id=input["dataset_id"],
            )
        return row

    def get_by_id(
        self,
        conn: SupportsExecute,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> DatasetRecord | None:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE dataset_id = %s AND org_id = %s AND user_id = %s
            """,
            (dataset_id, s.org_id, s.user_id),
        )
        row = conn.fetchone()
        return map_dataset(row) if row else None

    def require_by_id(
        self,
        conn: SupportsExecute,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> DatasetRecord:
        row = self.get_by_id(conn, dataset_id, scope)
        if row is None:
            raise NotFoundError(
                "Dataset not found",
                resource=TABLE,
                id=dataset_id,
            )
        return row

    def update_status(
        self,
        conn: SupportsExecute,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        status: str,
        size_bytes: int | None = None,
        sha256: str | None = None,
        completed_at: str | None = None,
    ) -> DatasetRecord:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            UPDATE {TABLE}
            SET status = %s,
                size_bytes = COALESCE(%s, size_bytes),
                sha256 = COALESCE(%s, sha256),
                completed_at = COALESCE(%s, completed_at)
            WHERE dataset_id = %s AND org_id = %s AND user_id = %s
            """,
            (
                status,
                size_bytes,
                sha256,
                to_mysql_datetime(completed_at) if completed_at is not None else None,
                dataset_id,
                s.org_id,
                s.user_id,
            ),
        )
        if getattr(conn, "rowcount", 1) == 0:
            raise NotFoundError(
                "Dataset not found",
                resource=TABLE,
                id=dataset_id,
            )
        return self.require_by_id(conn, dataset_id, s)

    def list_for_owner(
        self,
        conn: SupportsExecute,
        scope: OwnerScope | dict[str, str],
        *,
        agent_session_id: str | None = None,
        limit: int = 50,
    ) -> list[DatasetRecord]:
        s = require_owner_scope(scope, resource=TABLE)
        if agent_session_id is not None:
            conn.execute(
                f"""
                SELECT * FROM {TABLE}
                WHERE org_id = %s AND user_id = %s AND agent_session_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (s.org_id, s.user_id, agent_session_id, int(limit)),
            )
        else:
            conn.execute(
                f"""
                SELECT * FROM {TABLE}
                WHERE org_id = %s AND user_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (s.org_id, s.user_id, int(limit)),
            )
        return [map_dataset(r) for r in conn.fetchall()]

    def delete(
        self,
        conn: SupportsExecute,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> bool:
        """Delete a dataset row under owner scope. Returns True when a row was removed.

        Used for fail/cancel cleanup of incomplete UPLOADING records so they
        never linger as READY.
        """
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            DELETE FROM {TABLE}
            WHERE dataset_id = %s AND org_id = %s AND user_id = %s
              AND status <> 'ready'
            """,
            (dataset_id, s.org_id, s.user_id),
        )
        return int(getattr(conn, "rowcount", 0) or 0) > 0
