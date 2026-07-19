"""MySQL repository for browser auth credentials (register/login)."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sandbox.app.persistence.repositories._base import require_db
from sandbox.security.ownership import BOOTSTRAP_ORG_ID


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _row(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if not row:
        return None
    return {
        "id": row["external_user_id"],
        "username": row["username"],
        "password_hash": row["password_hash"],
        "email": row.get("email"),
        "display_name": row.get("display_name"),
        "role": row.get("role") or "user",
        "organization_id": row.get("external_org_id") or BOOTSTRAP_ORG_ID,
        "is_active": bool(row.get("is_active", True)),
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
        "last_login_at": row.get("last_login_at"),
    }


class AuthCredentialRepository:
    """CRUD for auth_credentials (Agent-owned schema, Sandbox reads/writes rows)."""

    def __init__(self, db: Any) -> None:
        self.db = require_db(db, "AuthCredentialRepository")

    def create(
        self,
        *,
        username: str,
        password_hash: str,
        external_user_id: str,
        external_org_id: str | None = None,
        email: str | None = None,
        display_name: str | None = None,
        role: str = "user",
    ) -> dict[str, Any]:
        now = _utcnow()
        org_id = (external_org_id or BOOTSTRAP_ORG_ID).strip() or BOOTSTRAP_ORG_ID
        with self.db.connection() as conn:
            conn.execute(
                """
                INSERT INTO auth_credentials (
                  username, password_hash, external_user_id, external_org_id,
                  display_name, email, role, is_active,
                  created_at, updated_at, last_login_at
                ) VALUES (
                  %s, %s, %s, %s, %s, %s, %s, 1, %s, %s, NULL
                )
                """,
                (
                    username,
                    password_hash,
                    external_user_id,
                    org_id,
                    display_name or username,
                    email,
                    role or "user",
                    now,
                    now,
                ),
            )
            conn.commit()
        entry = self.get_by_username(username)
        if not entry:
            raise RuntimeError("auth credential insert did not persist")
        return entry

    def get_by_username(self, username: str) -> dict[str, Any] | None:
        with self.db.connection() as conn:
            conn.execute(
                "SELECT * FROM auth_credentials WHERE username = %s LIMIT 1",
                (username,),
            )
            row = conn.fetchone()
        return _row(row)

    def get_by_external_user_id(self, external_user_id: str) -> dict[str, Any] | None:
        with self.db.connection() as conn:
            conn.execute(
                "SELECT * FROM auth_credentials WHERE external_user_id = %s LIMIT 1",
                (external_user_id,),
            )
            row = conn.fetchone()
        return _row(row)

    def touch_login(self, external_user_id: str) -> None:
        now = _utcnow()
        with self.db.connection() as conn:
            conn.execute(
                """
                UPDATE auth_credentials
                SET last_login_at = %s, updated_at = %s
                WHERE external_user_id = %s
                """,
                (now, now, external_user_id),
            )
            conn.commit()
