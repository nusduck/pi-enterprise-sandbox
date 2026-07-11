"""SQLite repositories for persisted sandbox entities."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from sandbox.database import Database, database
from sandbox.models import ArtifactResponse, ConversationResponse, ExecutionStatus, SessionResponse, SessionStatus


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _json_loads(value: str | None) -> Any:
    if not value:
        return {}
    return json.loads(value)


class SessionRepository:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def upsert(self, entry: dict[str, Any]) -> None:
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO sessions (
                    session_id, agent_session_id, enterprise_session_id, user_id,
                    caller_id, status, workspace_path, metadata,
                    created_at, updated_at, ttl_until
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    agent_session_id=excluded.agent_session_id,
                    enterprise_session_id=excluded.enterprise_session_id,
                    user_id=excluded.user_id,
                    caller_id=excluded.caller_id,
                    status=excluded.status,
                    workspace_path=excluded.workspace_path,
                    metadata=excluded.metadata,
                    updated_at=excluded.updated_at,
                    ttl_until=excluded.ttl_until
                """,
                (
                    entry["session_id"],
                    entry.get("agent_session_id"),
                    entry.get("enterprise_session_id"),
                    entry.get("user_id"),
                    entry.get("caller_id", "unknown"),
                    str(entry.get("status", SessionStatus.RUNNING).value if hasattr(entry.get("status"), "value") else entry.get("status", "RUNNING")),
                    entry.get("workspace_path"),
                    _json_dumps(entry.get("metadata", {})),
                    entry.get("created_at"),
                    entry.get("updated_at"),
                    entry.get("ttl_until").isoformat() if hasattr(entry.get("ttl_until"), "isoformat") else entry.get("ttl_until"),
                ),
            )
            conn.commit()

    def get(self, session_id: str) -> SessionResponse | None:
        return self._get_by("session_id", session_id)

    def get_by_agent_session_id(self, agent_session_id: str) -> SessionResponse | None:
        return self._get_by("agent_session_id", agent_session_id)

    def get_by_enterprise_session_id(self, enterprise_session_id: str) -> SessionResponse | None:
        return self._get_by("enterprise_session_id", enterprise_session_id)

    def _get_by(self, field: str, value: str) -> SessionResponse | None:
        if field not in {"session_id", "agent_session_id", "enterprise_session_id"}:
            raise ValueError(f"Unsupported session lookup field: {field}")
        with self.db.connect() as conn:
            row = conn.execute(f"SELECT * FROM sessions WHERE {field} = ?", (value,)).fetchone()
        return self._row_to_model(row) if row else None

    def delete(self, session_id: str) -> bool:
        with self.db.connect() as conn:
            cur = conn.execute("DELETE FROM sessions WHERE session_id = ?", (session_id,))
            conn.commit()
            return cur.rowcount > 0

    def update_status(self, session_id: str, status: SessionStatus) -> SessionResponse | None:
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE session_id = ?",
                (status.value, now, session_id),
            )
            conn.commit()
        return self.get(session_id)

    def list_active(self) -> list[SessionResponse]:
        with self.db.connect() as conn:
            rows = conn.execute("SELECT * FROM sessions WHERE status = ?", (SessionStatus.RUNNING.value,)).fetchall()
        return [self._row_to_model(row) for row in rows]

    def cleanup_expired(self, now_iso: str) -> int:
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            cur = conn.execute(
                "UPDATE sessions SET status = ?, updated_at = ? WHERE status = ? AND ttl_until < ?",
                (SessionStatus.EXPIRED.value, now, SessionStatus.RUNNING.value, now_iso),
            )
            conn.commit()
            return cur.rowcount

    @staticmethod
    def _row_to_model(row) -> SessionResponse:
        return SessionResponse(
            session_id=row["session_id"],
            agent_session_id=row["agent_session_id"],
            enterprise_session_id=row["enterprise_session_id"],
            user_id=row["user_id"],
            caller_id=row["caller_id"],
            status=row["status"],
            workspace_path=row["workspace_path"] or "",
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            metadata=_json_loads(row["metadata"]),
        )


class ExecutionRepository:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def upsert(self, entry: dict[str, Any]) -> None:
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO executions (
                    execution_id, session_id, status, run_type, exit_code,
                    duration_ms, truncated, stdout_preview, stderr_preview,
                    trace_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(execution_id) DO UPDATE SET
                    status=excluded.status,
                    run_type=excluded.run_type,
                    exit_code=excluded.exit_code,
                    duration_ms=excluded.duration_ms,
                    truncated=excluded.truncated,
                    stdout_preview=excluded.stdout_preview,
                    stderr_preview=excluded.stderr_preview,
                    trace_id=excluded.trace_id
                """,
                (
                    entry["execution_id"],
                    entry["session_id"],
                    str(entry.get("status", ExecutionStatus.PENDING).value if hasattr(entry.get("status"), "value") else entry.get("status", "PENDING")),
                    entry.get("run_type"),
                    entry.get("exit_code"),
                    entry.get("duration_ms", 0.0),
                    1 if entry.get("truncated") else 0,
                    entry.get("stdout_preview", ""),
                    entry.get("stderr_preview", ""),
                    entry.get("trace_id"),
                    entry.get("created_at"),
                ),
            )
            conn.commit()

    def get(self, execution_id: str) -> dict | None:
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM executions WHERE execution_id = ?", (execution_id,)).fetchone()
        if not row:
            return None
        return {
            "execution_id": row["execution_id"],
            "session_id": row["session_id"],
            "status": row["status"],
            "run_type": row["run_type"],
            "exit_code": row["exit_code"],
            "duration_ms": row["duration_ms"] or 0.0,
            "truncated": bool(row["truncated"]),
            "stdout_preview": row["stdout_preview"] or "",
            "stderr_preview": row["stderr_preview"] or "",
            "trace_id": row["trace_id"],
            "created_at": row["created_at"],
        }

    def total_count(self) -> int:
        with self.db.connect() as conn:
            return int(conn.execute("SELECT COUNT(*) FROM executions").fetchone()[0])

    def list_by_trace_id(self, trace_id: str) -> list[dict]:
        with self.db.connect() as conn:
            rows = conn.execute("SELECT * FROM executions WHERE trace_id = ? ORDER BY created_at", (trace_id,)).fetchall()
        return [self.get(row["execution_id"]) for row in rows if self.get(row["execution_id"])]


class ArtifactRepository:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def upsert(self, session_id: str, entry: dict[str, Any]) -> None:
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO artifacts (
                    artifact_id, session_id, name, path, mime_type,
                    size, source_execution_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(artifact_id) DO UPDATE SET
                    session_id=excluded.session_id,
                    name=excluded.name,
                    path=excluded.path,
                    mime_type=excluded.mime_type,
                    size=excluded.size,
                    source_execution_id=excluded.source_execution_id
                """,
                (
                    entry["artifact_id"], session_id, entry["name"], entry["path"],
                    entry.get("mime_type"), entry.get("size", 0),
                    entry.get("source_execution_id"), entry.get("created_at"),
                ),
            )
            conn.commit()

    def list_by_session(self, session_id: str) -> list[ArtifactResponse]:
        with self.db.connect() as conn:
            rows = conn.execute("SELECT * FROM artifacts WHERE session_id = ? ORDER BY created_at", (session_id,)).fetchall()
        return [self._row_to_model(row) for row in rows]

    def get(self, artifact_id: str) -> ArtifactResponse | None:
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM artifacts WHERE artifact_id = ?", (artifact_id,)).fetchone()
        return self._row_to_model(row) if row else None

    def get_for_session(self, session_id: str, artifact_id: str) -> ArtifactResponse | None:
        """Return artifact only when it belongs to *session_id*."""
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM artifacts WHERE artifact_id = ? AND session_id = ?",
                (artifact_id, session_id),
            ).fetchone()
        return self._row_to_model(row) if row else None

    def delete_by_session(self, session_id: str) -> int:
        with self.db.connect() as conn:
            cur = conn.execute("DELETE FROM artifacts WHERE session_id = ?", (session_id,))
            conn.commit()
            return cur.rowcount

    @staticmethod
    def _row_to_model(row) -> ArtifactResponse:
        return ArtifactResponse(
            artifact_id=row["artifact_id"],
            name=row["name"],
            path=row["path"],
            mime_type=row["mime_type"] or "application/octet-stream",
            source_execution_id=row["source_execution_id"],
            size=row["size"] or 0,
            created_at=row["created_at"],
        )


class ConversationRepository:
    """CRUD for persisted conversations."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def upsert(self, entry: dict[str, Any]) -> ConversationResponse:
        now = entry.get("updated_at") or entry.get("created_at") or datetime.now(timezone.utc).isoformat()
        # Preserve ownership on update when not explicitly provided
        existing = self.get(entry["id"]) if entry.get("id") else None
        owner = entry.get("owner_user_id")
        org = entry.get("organization_id")
        if existing is not None:
            if owner is None:
                owner = existing.owner_user_id
            if org is None:
                org = existing.organization_id
        with self.db.connect() as conn:
            conn.execute(
                """\
                INSERT INTO conversations (
                    id, title, sandbox_session_id, workspace_path, messages,
                    owner_user_id, organization_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    sandbox_session_id=excluded.sandbox_session_id,
                    workspace_path=excluded.workspace_path,
                    messages=excluded.messages,
                    owner_user_id=COALESCE(excluded.owner_user_id, conversations.owner_user_id),
                    organization_id=COALESCE(excluded.organization_id, conversations.organization_id),
                    updated_at=excluded.updated_at
                """,
                (
                    entry["id"],
                    entry.get("title", "New conversation"),
                    entry.get("sandbox_session_id"),
                    entry.get("workspace_path"),
                    _json_dumps(entry.get("messages", [])),
                    owner,
                    org,
                    entry.get("created_at", now),
                    now,
                ),
            )
            conn.commit()
        return self.get(entry["id"])

    def get(self, conversation_id: str) -> ConversationResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM conversations WHERE id = ?", (conversation_id,)
            ).fetchone()
        return self._row_to_model(row) if row else None

    def list_all(self) -> list[ConversationResponse]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM conversations ORDER BY updated_at DESC"
            ).fetchall()
        return [self._row_to_model(row) for row in rows]

    def list_for_user(
        self,
        *,
        user_id: str,
        organization_id: str,
        is_admin: bool = False,
    ) -> list[ConversationResponse]:
        """List conversations visible to a user (owner) or admin (same org)."""
        with self.db.connect() as conn:
            if is_admin:
                rows = conn.execute(
                    """
                    SELECT * FROM conversations
                    WHERE organization_id = ?
                    ORDER BY updated_at DESC
                    """,
                    (organization_id,),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM conversations
                    WHERE owner_user_id = ? AND organization_id = ?
                    ORDER BY updated_at DESC
                    """,
                    (user_id, organization_id),
                ).fetchall()
        return [self._row_to_model(row) for row in rows]

    def get_for_owner(
        self,
        conversation_id: str,
        *,
        user_id: str,
        organization_id: str,
        is_admin: bool = False,
    ) -> ConversationResponse | None:
        """Return conversation only if actor may access it; else None.

        Rows missing owner/org are treated as inaccessible (no existence leak)
        so pre-migration orphans cannot be read by arbitrary users.
        """
        conv = self.get(conversation_id)
        if not conv:
            return None
        if not conv.organization_id or not conv.owner_user_id:
            return None
        if conv.organization_id != organization_id:
            return None
        if is_admin:
            return conv
        if conv.owner_user_id != user_id:
            return None
        return conv

    def update_messages(
        self, conversation_id: str, messages: list[dict[str, Any]]
    ) -> ConversationResponse | None:
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE conversations SET messages = ?, updated_at = ? WHERE id = ?",
                (_json_dumps(messages), now, conversation_id),
            )
            conn.commit()
        return self.get(conversation_id)

    def update_title(self, conversation_id: str, title: str) -> ConversationResponse | None:
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?",
                (title, now, conversation_id),
            )
            conn.commit()
        return self.get(conversation_id)

    def delete(self, conversation_id: str) -> bool:
        with self.db.connect() as conn:
            cur = conn.execute(
                "DELETE FROM conversations WHERE id = ?", (conversation_id,)
            )
            conn.commit()
            return cur.rowcount > 0

    def delete_by_session(self, sandbox_session_id: str) -> int:
        with self.db.connect() as conn:
            cur = conn.execute(
                "DELETE FROM conversations WHERE sandbox_session_id = ?",
                (sandbox_session_id,),
            )
            conn.commit()
            return cur.rowcount

    def get_by_workspace_path(self, workspace_path: str) -> ConversationResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM conversations WHERE workspace_path = ?", (workspace_path,)
            ).fetchone()
        return self._row_to_model(row) if row else None

    @staticmethod
    def _row_to_model(row) -> ConversationResponse:
        # sqlite3.Row has no .get; use try/keys for optional ownership columns
        def _col(name: str, default=None):
            try:
                val = row[name]
            except (KeyError, IndexError, TypeError):
                return default
            return default if val is None else val

        return ConversationResponse(
            id=row["id"],
            title=row["title"],
            sandbox_session_id=row["sandbox_session_id"],
            workspace_path=row["workspace_path"],
            messages=_json_loads(row["messages"]),
            owner_user_id=_col("owner_user_id"),
            organization_id=_col("organization_id"),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class AuditRepository:
    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def insert(
        self,
        event_type: str,
        payload: dict[str, Any],
        session_id: str | None = None,
        execution_id: str | None = None,
        trace_id: str | None = None,
        created_at: str | None = None,
    ) -> None:
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO audit_logs (event_type, session_id, execution_id, trace_id, payload, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    event_type,
                    session_id,
                    execution_id,
                    trace_id,
                    _json_dumps(payload),
                    created_at or datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()


    def list_by_trace_id(self, trace_id: str) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM audit_logs WHERE trace_id = ? ORDER BY id",
                (trace_id,),
            ).fetchall()
        return [
            {
                "id": row["id"],
                "event_type": row["event_type"],
                "session_id": row["session_id"],
                "execution_id": row["execution_id"],
                "trace_id": row["trace_id"],
                "payload": _json_loads(row["payload"]),
                "created_at": row["created_at"],
            }
            for row in rows
        ]


class ApprovalRepository:
    """CRUD for persisted high-risk approval requests."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def upsert(self, entry: dict[str, Any]) -> None:
        risk = entry.get("risk_level")
        risk_value = risk.value if hasattr(risk, "value") else str(risk or "")
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO approvals (
                    approval_id, session_id, tool_name, risk_level, reason,
                    payload, status, created_at, expires_at, decided_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(approval_id) DO UPDATE SET
                    session_id=excluded.session_id,
                    tool_name=excluded.tool_name,
                    risk_level=excluded.risk_level,
                    reason=excluded.reason,
                    payload=excluded.payload,
                    status=excluded.status,
                    created_at=excluded.created_at,
                    expires_at=excluded.expires_at,
                    decided_at=excluded.decided_at
                """,
                (
                    entry["approval_id"],
                    entry["session_id"],
                    entry["tool_name"],
                    risk_value,
                    entry.get("reason", ""),
                    _json_dumps(entry.get("payload", {})),
                    entry.get("status", "pending_approval"),
                    entry.get("created_at"),
                    entry.get("expires_at"),
                    entry.get("decided_at"),
                ),
            )
            conn.commit()

    def get(self, approval_id: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM approvals WHERE approval_id = ?",
                (approval_id,),
            ).fetchone()
        if not row:
            return None
        return self._row_to_dict(row)

    def list_by_session(self, session_id: str) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM approvals WHERE session_id = ? ORDER BY created_at",
                (session_id,),
            ).fetchall()
        return [self._row_to_dict(row) for row in rows]

    @staticmethod
    def _row_to_dict(row) -> dict[str, Any]:
        return {
            "approval_id": row["approval_id"],
            "session_id": row["session_id"],
            "tool_name": row["tool_name"],
            "risk_level": row["risk_level"],
            "reason": row["reason"] or "",
            "payload": _json_loads(row["payload"]),
            "status": row["status"],
            "created_at": row["created_at"],
            "expires_at": row["expires_at"],
            "decided_at": row["decided_at"],
        }


class UserRepository:
    """CRUD for optional multi-user auth foundation."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def create(
        self,
        *,
        user_id: str,
        username: str,
        password_hash: str,
        email: str | None = None,
        display_name: str | None = None,
        role: str = "user",
        organization_id: str | None = None,
    ) -> dict[str, Any]:
        from sandbox.security.ownership import BOOTSTRAP_ORG_ID

        now = datetime.now(timezone.utc).isoformat()
        org_id = organization_id or BOOTSTRAP_ORG_ID
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO users (
                    id, username, email, password_hash, display_name,
                    role, organization_id, is_active, created_at, updated_at, last_login_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
                """,
                (
                    user_id, username, email, password_hash,
                    display_name or username, role, org_id, now, now,
                ),
            )
            conn.commit()
        return self.get_by_id(user_id)  # type: ignore[return-value]

    def get_by_id(self, user_id: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self._row_to_dict(row) if row else None

    def get_by_username(self, username: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM users WHERE username = ?", (username,)
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def touch_login(self, user_id: str) -> None:
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                "UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?",
                (now, now, user_id),
            )
            conn.commit()

    @staticmethod
    def _row_to_dict(row) -> dict[str, Any]:
        from sandbox.security.ownership import BOOTSTRAP_ORG_ID

        try:
            org_id = row["organization_id"]
        except (KeyError, IndexError, TypeError):
            org_id = None
        return {
            "id": row["id"],
            "username": row["username"],
            "email": row["email"],
            "password_hash": row["password_hash"],
            "display_name": row["display_name"],
            "role": row["role"],
            "organization_id": org_id or BOOTSTRAP_ORG_ID,
            "is_active": bool(row["is_active"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "last_login_at": row["last_login_at"],
        }
