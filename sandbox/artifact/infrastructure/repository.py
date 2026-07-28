"""Artifact repository — aligned with plan §8.15 / Agent migration ``artifacts``.

Owner scope (org_id + user_id) is mandatory on every read/write.
UNIQUE (run_id, relative_path_hash, sha256) where relative_path_hash is a
STORED generated SHA-256 of the **full** relative_path (not a prefix). Exact
path equality is still required on read; path-hash collisions fail closed.
"""

from __future__ import annotations

import hashlib
from typing import Any

from sandbox.app.domain.types import ArtifactRecord, OwnerScope
from sandbox.app.persistence.errors import ConflictError, NotFoundError
from sandbox.app.persistence.mappers import map_artifact, to_mysql_datetime
from sandbox.app.persistence.ownership import require_owner_scope
from sandbox.app.persistence.repositories._base import SupportsExecute, require_db
from sandbox.app.persistence.schema_gap import is_table_present

TABLE = "artifacts"
assert is_table_present(TABLE)


def relative_path_sha256_hex(relative_path: str) -> str:
    """Match MySQL ``LOWER(SHA2(relative_path, 256))`` for utf8 path bytes."""
    return hashlib.sha256(relative_path.encode("utf-8")).hexdigest().lower()


class ArtifactRepository:
    """CRUD for artifacts with mandatory owner scope."""

    def __init__(self, db: Any) -> None:
        self.db = require_db(db, "ArtifactRepository")

    def create(
        self,
        conn: SupportsExecute,
        input: dict[str, Any],
    ) -> ArtifactRecord:
        scope = require_owner_scope(input, resource=TABLE)
        now = to_mysql_datetime(input.get("created_at"))
        conn.execute(
            f"""
            INSERT INTO {TABLE} (
                artifact_id, org_id, user_id, conversation_id, agent_session_id,
                run_id, relative_path, display_name, mime_type, size_bytes,
                sha256, status, created_at
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            """,
            (
                input["artifact_id"],
                scope.org_id,
                scope.user_id,
                input["conversation_id"],
                input["agent_session_id"],
                input["run_id"],
                input["relative_path"],
                input["display_name"],
                input.get("mime_type"),
                int(input["size_bytes"]),
                input["sha256"],
                input["status"],
                now,
            ),
        )
        row = self.get_by_id(conn, input["artifact_id"], scope)
        if row is None:
            raise NotFoundError(
                "Artifact not found after insert",
                resource=TABLE,
                id=input["artifact_id"],
            )
        return row

    def get_by_id(
        self,
        conn: SupportsExecute,
        artifact_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> ArtifactRecord | None:
        s = require_owner_scope(scope, resource=TABLE)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE artifact_id = %s AND org_id = %s AND user_id = %s
            """,
            (artifact_id, s.org_id, s.user_id),
        )
        row = conn.fetchone()
        return map_artifact(row) if row else None

    def require_by_id(
        self,
        conn: SupportsExecute,
        artifact_id: str,
        scope: OwnerScope | dict[str, str],
    ) -> ArtifactRecord:
        row = self.get_by_id(conn, artifact_id, scope)
        if row is None:
            raise NotFoundError(
                "Artifact not found",
                resource=TABLE,
                id=artifact_id,
            )
        return row

    def list_for_owner(
        self,
        conn: SupportsExecute,
        scope: OwnerScope | dict[str, str],
        *,
        run_id: str | None = None,
        limit: int = 50,
    ) -> list[ArtifactRecord]:
        s = require_owner_scope(scope, resource=TABLE)
        if run_id is not None:
            conn.execute(
                f"""
                SELECT * FROM {TABLE}
                WHERE org_id = %s AND user_id = %s AND run_id = %s
                ORDER BY created_at DESC
                LIMIT %s
                """,
                (s.org_id, s.user_id, run_id, int(limit)),
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
        return [map_artifact(r) for r in conn.fetchall()]

    def get_by_run_path_hash(
        self,
        conn: SupportsExecute,
        scope: OwnerScope | dict[str, str],
        *,
        run_id: str,
        relative_path: str,
        sha256: str,
    ) -> ArtifactRecord | None:
        """Lookup plan §8.15 identity under owner (exact full path).

        Index uses relative_path_hash; query still requires relative_path =
        exact value so distinct full paths never silently alias. If a row
        matches the hash unique but path bytes differ (theoretical SHA-256
        collision), raise ConflictError fail-closed.
        """
        s = require_owner_scope(scope, resource=TABLE)
        path = str(relative_path)
        digest = str(sha256).lower()
        path_hash = relative_path_sha256_hex(path)
        conn.execute(
            f"""
            SELECT * FROM {TABLE}
            WHERE run_id = %s
              AND relative_path_hash = %s
              AND sha256 = %s
              AND org_id = %s AND user_id = %s
            """,
            (run_id, path_hash, digest, s.org_id, s.user_id),
        )
        row = conn.fetchone()
        if row is None:
            return None
        if str(row.get("relative_path") or "") != path:
            raise ConflictError(
                "Artifact path hash collision: unique key matches a different "
                "relative_path (fail closed)",
                resource=TABLE,
                id=str(row.get("artifact_id") or ""),
            )
        return map_artifact(row)
