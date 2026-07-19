"""Dataset repository — aligned with plan §8.14 / Agent migration ``datasets``.

Owner scope (org_id + user_id) is mandatory on every read/write.
"""

from __future__ import annotations

from typing import Any

from sandbox.app.domain.types import DatasetRecord, OwnerScope
from sandbox.app.persistence.errors import ConflictError, NotFoundError
from sandbox.app.persistence.mappers import dumps_json, map_dataset, to_mysql_datetime
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

    def reserve_idempotent_upload(
        self,
        conn: SupportsExecute,
        input: dict[str, Any],
    ) -> tuple[str, DatasetRecord]:
        """Reserve or recover one conversation-scoped Dataset upload.

        The idempotency row and a new UPLOADING Dataset row are written in the
        caller's transaction. ``ON DUPLICATE KEY`` never changes the existing
        resource binding; the locked row is then hash-checked under owner scope.
        """
        scope = require_owner_scope(input, resource="idempotency_records")
        key = _bounded(input.get("idempotency_key"), "idempotency_key", 255)
        operation = _bounded(input.get("operation"), "operation", 128)
        request_hash = _request_hash(input.get("request_hash"))
        candidate_id = _bounded(input.get("dataset_id"), "dataset_id", 26)
        created_at = to_mysql_datetime(input.get("created_at"))
        expires_at = to_mysql_datetime(input.get("expires_at"))

        conn.execute(
            """
            INSERT INTO idempotency_records (
                org_id, user_id, idempotency_key, operation, request_hash,
                response_status, response_json, resource_id, expires_at, created_at
            ) VALUES (%s, %s, %s, %s, %s, NULL, NULL, %s, %s, %s)
            ON DUPLICATE KEY UPDATE idempotency_key = idempotency_key
            """,
            (
                scope.org_id,
                scope.user_id,
                key,
                operation,
                request_hash,
                candidate_id,
                expires_at,
                created_at,
            ),
        )
        conn.execute(
            """
            SELECT request_hash, response_status, resource_id
            FROM idempotency_records
            WHERE org_id = %s AND user_id = %s
              AND idempotency_key = %s AND operation = %s
            FOR UPDATE
            """,
            (scope.org_id, scope.user_id, key, operation),
        )
        idem = conn.fetchone()
        if idem is None:
            raise NotFoundError(
                "Dataset idempotency reservation not readable",
                resource="idempotency_records",
                id=key,
            )
        if str(idem.get("request_hash") or "").lower() != request_hash:
            raise ConflictError(
                "Idempotency key reused with a different Dataset request",
                resource="idempotency_records",
                id=key,
            )
        resource_id = str(idem.get("resource_id") or "").strip()
        if not resource_id:
            raise ConflictError(
                "Dataset idempotency reservation has no resource binding",
                resource="idempotency_records",
                id=key,
            )

        row = self.get_by_id(conn, resource_id, scope)
        if row is None:
            if resource_id != candidate_id:
                raise ConflictError(
                    "Dataset idempotency resource is missing",
                    resource=TABLE,
                    id=resource_id,
                )
            row = self.create(conn, input)
            outcome = "begun"
        else:
            _require_same_dataset_binding(row, input)
            outcome = "resume"

        if idem.get("response_status") is not None:
            if row.status != "ready":
                raise ConflictError(
                    "Completed Dataset idempotency record is not READY",
                    resource=TABLE,
                    id=row.dataset_id,
                )
            outcome = "replay"
        return outcome, row

    def complete_idempotent_upload(
        self,
        conn: SupportsExecute,
        dataset_id: str,
        scope: OwnerScope | dict[str, str],
        *,
        idempotency_key: str,
        operation: str,
        request_hash: str,
        size_bytes: int,
        sha256: str,
        completed_at: str,
        response_json: dict[str, Any],
    ) -> DatasetRecord:
        """Commit READY and the replay response in one caller transaction."""
        s = require_owner_scope(scope, resource=TABLE)
        key = _bounded(idempotency_key, "idempotency_key", 255)
        op = _bounded(operation, "operation", 128)
        req_hash = _request_hash(request_hash)
        row = self.update_status(
            conn,
            dataset_id,
            s,
            status="ready",
            size_bytes=int(size_bytes),
            sha256=sha256,
            completed_at=completed_at,
        )
        conn.execute(
            """
            UPDATE idempotency_records
            SET response_status = 201, response_json = %s, resource_id = %s
            WHERE org_id = %s AND user_id = %s
              AND idempotency_key = %s AND operation = %s
              AND request_hash = %s AND resource_id = %s
              AND response_status IS NULL
            """,
            (
                dumps_json(response_json),
                dataset_id,
                s.org_id,
                s.user_id,
                key,
                op,
                req_hash,
                dataset_id,
            ),
        )
        if int(getattr(conn, "rowcount", 0) or 0) == 0:
            conn.execute(
                """
                SELECT request_hash, response_status, resource_id
                FROM idempotency_records
                WHERE org_id = %s AND user_id = %s
                  AND idempotency_key = %s AND operation = %s
                FOR UPDATE
                """,
                (s.org_id, s.user_id, key, op),
            )
            idem = conn.fetchone()
            if (
                idem is None
                or str(idem.get("request_hash") or "").lower() != req_hash
                or str(idem.get("resource_id") or "") != dataset_id
                or int(idem.get("response_status") or 0) != 201
            ):
                raise ConflictError(
                    "Dataset idempotency completion lost its reservation",
                    resource="idempotency_records",
                    id=key,
                )
        return row


def _bounded(value: Any, field: str, max_length: int) -> str:
    text = str(value or "").strip()
    if not text or len(text) > max_length:
        raise ValueError(f"{field} must be 1..{max_length} characters")
    return text


def _request_hash(value: Any) -> str:
    text = _bounded(value, "request_hash", 64).lower()
    if len(text) != 64 or any(c not in "0123456789abcdef" for c in text):
        raise ValueError("request_hash must be 64 lowercase hex characters")
    return text


def _require_same_dataset_binding(
    row: DatasetRecord,
    input: dict[str, Any],
) -> None:
    if (
        row.conversation_id != str(input.get("conversation_id") or "")
        or row.agent_session_id != str(input.get("agent_session_id") or "")
        or row.original_filename != str(input.get("original_filename") or "")
        or row.mime_type != input.get("mime_type")
    ):
        raise ConflictError(
            "Dataset idempotency resource binding mismatch",
            resource=TABLE,
            id=row.dataset_id,
        )
