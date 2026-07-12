"""SQLite repositories for persisted sandbox entities."""

from __future__ import annotations

import json
import sqlite3
import time
import uuid
from datetime import datetime, timezone
from typing import Any

from sandbox.database import Database, PostgreSQLBackend, SQLiteBackend, database
from sandbox.models import (
    AgentEventResponse,
    AgentRunResponse,
    AgentRunStatus,
    AgentSessionEntryResponse,
    AgentSessionResponse,
    AgentSessionStatus,
    ArtifactResponse,
    ConversationResponse,
    ExecutionStatus,
    PROCESS_ACTIVE_STATUSES,
    ProcessStatus,
    SessionResponse,
    SessionStatus,
    TOOL_TERMINAL_STATUSES,
    ToolExecutionResponse,
    ToolExecutionStatus,
)

# Bounded retries when concurrent writers race on (run_id, sequence).
MAX_APPEND_SEQUENCE_RETRIES = 8


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
        # DB column ``workspace_path`` stores the opaque workspace_id (never a host path).
        meta = entry.get("metadata") or {}
        stored_workspace_id = (
            entry.get("workspace_id")
            or (meta.get("workspace_id") if isinstance(meta, dict) else None)
            or entry.get("workspace_path")
            or ""
        )
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
                    stored_workspace_id,
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
        raw_meta = _json_loads(row["metadata"])
        # Keep full metadata in-memory for service-layer physical resolution;
        # routers must call public_session_response before returning JSON.
        workspace_id = None
        if isinstance(raw_meta, dict):
            workspace_id = raw_meta.get("workspace_id")
        if not workspace_id:
            stored = row["workspace_path"] or ""
            # Ignore legacy absolute paths stored before R2 cutover.
            if stored and not str(stored).startswith("/"):
                workspace_id = stored
        return SessionResponse(
            session_id=row["session_id"],
            agent_session_id=row["agent_session_id"],
            enterprise_session_id=row["enterprise_session_id"],
            user_id=row["user_id"],
            caller_id=row["caller_id"],
            status=row["status"],
            workspace_id=workspace_id,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            metadata=raw_meta if isinstance(raw_meta, dict) else {},
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

    def count_older_than(self, older_than_iso: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS n FROM executions WHERE created_at < ?",
                (older_than_iso,),
            ).fetchone()
        return int(row["n"] if row is not None else 0)

    def delete_older_than(
        self,
        *,
        older_than_iso: str,
        exclude_legal_hold: bool = True,
        limit: int | None = None,
    ) -> int:
        """Hard-delete execution rows older than cutoff.

        When ``exclude_legal_hold`` is True, skip executions whose session is
        still referenced by a legal-hold conversation.
        """
        hold_clause = ""
        if exclude_legal_hold:
            hold_clause = """
              AND session_id NOT IN (
                SELECT sandbox_session_id FROM conversations
                WHERE COALESCE(legal_hold, 0) = 1
                  AND sandbox_session_id IS NOT NULL
                  AND sandbox_session_id != ''
              )
            """
        # Two-step for portable LIMIT delete across SQLite/PG
        with self.db.connect() as conn:
            if limit is not None:
                id_rows = conn.execute(
                    f"""
                    SELECT execution_id FROM executions
                    WHERE created_at < ?
                    {hold_clause}
                    ORDER BY created_at ASC
                    LIMIT ?
                    """,
                    (older_than_iso, limit),
                ).fetchall()
                ids = [r["execution_id"] for r in id_rows]
                if not ids:
                    return 0
                placeholders = ",".join("?" for _ in ids)
                cur = conn.execute(
                    f"DELETE FROM executions WHERE execution_id IN ({placeholders})",
                    tuple(ids),
                )
            else:
                cur = conn.execute(
                    f"""
                    DELETE FROM executions
                    WHERE created_at < ?
                    {hold_clause}
                    """,
                    (older_than_iso,),
                )
            conn.commit()
            return cur.rowcount


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
        interrupted = entry.get("interrupted")
        last_run_id = entry.get("last_run_id")
        legal_hold = entry.get("legal_hold")
        agent_session_id = entry.get("agent_session_id")
        if existing is not None:
            if owner is None:
                owner = existing.owner_user_id
            if org is None:
                org = existing.organization_id
            if interrupted is None:
                interrupted = existing.interrupted
            if last_run_id is None and "last_run_id" not in entry:
                last_run_id = existing.last_run_id
            if legal_hold is None:
                legal_hold = existing.legal_hold
            if agent_session_id is None and "agent_session_id" not in entry:
                agent_session_id = existing.agent_session_id
        if interrupted is None:
            interrupted = False
        if legal_hold is None:
            legal_hold = False
        with self.db.connect() as conn:
            conn.execute(
                """\
                INSERT INTO conversations (
                    id, title, sandbox_session_id, workspace_path, messages,
                    owner_user_id, organization_id, interrupted, last_run_id,
                    legal_hold, agent_session_id, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    title=excluded.title,
                    sandbox_session_id=excluded.sandbox_session_id,
                    workspace_path=excluded.workspace_path,
                    messages=excluded.messages,
                    owner_user_id=COALESCE(excluded.owner_user_id, conversations.owner_user_id),
                    organization_id=COALESCE(excluded.organization_id, conversations.organization_id),
                    interrupted=excluded.interrupted,
                    last_run_id=excluded.last_run_id,
                    legal_hold=excluded.legal_hold,
                    agent_session_id=COALESCE(excluded.agent_session_id, conversations.agent_session_id),
                    updated_at=excluded.updated_at
                """,
                (
                    entry["id"],
                    entry.get("title", "New conversation"),
                    entry.get("sandbox_session_id"),
                    # DB column stores opaque workspace_id (never host path).
                    entry.get("workspace_id") or entry.get("workspace_path"),
                    _json_dumps(entry.get("messages", [])),
                    owner,
                    org,
                    1 if interrupted else 0,
                    last_run_id,
                    1 if legal_hold else 0,
                    agent_session_id,
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

    def set_interrupted(
        self,
        conversation_id: str,
        *,
        interrupted: bool = True,
        last_run_id: str | None = None,
    ) -> ConversationResponse | None:
        """Mark conversation interrupted and optionally bind last_run_id."""
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            if last_run_id is not None:
                conn.execute(
                    """
                    UPDATE conversations
                    SET interrupted = ?, last_run_id = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (1 if interrupted else 0, last_run_id, now, conversation_id),
                )
            else:
                conn.execute(
                    """
                    UPDATE conversations
                    SET interrupted = ?, updated_at = ?
                    WHERE id = ?
                    """,
                    (1 if interrupted else 0, now, conversation_id),
                )
            conn.commit()
        return self.get(conversation_id)

    def set_last_run_id(
        self, conversation_id: str, last_run_id: str
    ) -> ConversationResponse | None:
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE conversations
                SET last_run_id = ?, interrupted = 0, updated_at = ?
                WHERE id = ?
                """,
                (last_run_id, now, conversation_id),
            )
            conn.commit()
        return self.get(conversation_id)

    def set_agent_session_id(
        self, conversation_id: str, agent_session_id: str
    ) -> ConversationResponse | None:
        """Bind a logical Pi SDK agent session to the conversation (1:1)."""
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE conversations
                SET agent_session_id = ?, updated_at = ?
                WHERE id = ?
                """,
                (agent_session_id, now, conversation_id),
            )
            conn.commit()
        return self.get(conversation_id)

    def list_expired_drafts(
        self,
        *,
        older_than_iso: str,
        exclude_legal_hold: bool = True,
        limit: int | None = None,
    ) -> list[ConversationResponse]:
        """Draft conversations: empty messages and no activity after cutoff."""
        hold_clause = "AND COALESCE(legal_hold, 0) = 0" if exclude_legal_hold else ""
        limit_clause = "LIMIT ?" if limit is not None else ""
        params: list[Any] = [older_than_iso]
        if limit is not None:
            params.append(limit)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM conversations
                WHERE updated_at < ?
                  AND (messages = '[]' OR messages IS NULL OR messages = '')
                  {hold_clause}
                ORDER BY updated_at ASC
                {limit_clause}
                """,
                tuple(params),
            ).fetchall()
        return [self._row_to_model(row) for row in rows]

    def list_inactive(
        self,
        *,
        older_than_iso: str,
        exclude_legal_hold: bool = True,
        limit: int | None = None,
    ) -> list[ConversationResponse]:
        """Inactive conversations (any messages) with no activity after cutoff.

        Used for the 90-day retention path. Legal-hold rows are skipped when
        ``exclude_legal_hold`` is True (default — shared delete boundary).
        """
        hold_clause = "AND COALESCE(legal_hold, 0) = 0" if exclude_legal_hold else ""
        limit_clause = "LIMIT ?" if limit is not None else ""
        params: list[Any] = [older_than_iso]
        if limit is not None:
            params.append(limit)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM conversations
                WHERE updated_at < ?
                  {hold_clause}
                ORDER BY updated_at ASC
                {limit_clause}
                """,
                tuple(params),
            ).fetchall()
        return [self._row_to_model(row) for row in rows]

    def delete(
        self,
        conversation_id: str,
        *,
        respect_legal_hold: bool = True,
    ) -> bool:
        """Delete a conversation row.

        When ``respect_legal_hold`` is True (default), legal-hold conversations
        are never deleted (shared cleanup boundary).
        """
        if respect_legal_hold:
            existing = self.get(conversation_id)
            if existing is not None and existing.legal_hold:
                return False
        with self.db.connect() as conn:
            if respect_legal_hold:
                cur = conn.execute(
                    """
                    DELETE FROM conversations
                    WHERE id = ? AND COALESCE(legal_hold, 0) = 0
                    """,
                    (conversation_id,),
                )
            else:
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
        """Lookup by stored workspace key (opaque workspace_id in DB column)."""
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM conversations WHERE workspace_path = ?", (workspace_path,)
            ).fetchone()
        return self._row_to_model(row) if row else None

    def get_by_workspace_id(self, workspace_id: str) -> ConversationResponse | None:
        return self.get_by_workspace_path(workspace_id)

    def _row_to_model(self, row) -> ConversationResponse:
        # sqlite3.Row has no .get; use try/keys for optional ownership columns
        def _col(name: str, default=None):
            try:
                val = row[name]
            except (KeyError, IndexError, TypeError):
                return default
            return default if val is None else val

        stored = row["workspace_path"]
        workspace_id = None
        if stored and not str(stored).startswith("/"):
            workspace_id = stored
        elif stored and str(stored).startswith("/"):
            # Legacy physical path → derive opaque id from basename when possible.
            from pathlib import Path

            workspace_id = Path(str(stored)).name or None

        return ConversationResponse(
            id=row["id"],
            title=row["title"],
            sandbox_session_id=row["sandbox_session_id"],
            agent_session_id=_col("agent_session_id"),
            workspace_id=workspace_id,
            messages=_json_loads(row["messages"]),
            owner_user_id=_col("owner_user_id"),
            organization_id=_col("organization_id"),
            interrupted=bool(_col("interrupted", 0)),
            last_run_id=_col("last_run_id"),
            legal_hold=bool(_col("legal_hold", 0)),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class AgentSessionRepository:
    """Persist logical Pi SDK sessions and append-only entries (ADR 0002 §7)."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def create(self, entry: dict[str, Any]) -> AgentSessionResponse:
        now = datetime.now(timezone.utc).isoformat()
        session_id = entry.get("id") or f"asess_{uuid.uuid4().hex}"
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO agent_sessions (
                    id, conversation_id, sdk_session_id, workspace_id,
                    sandbox_session_id, status, model_id, thinking_level,
                    system_prompt_version, tool_registry_version, sdk_version,
                    session_schema_version, header_payload,
                    created_at, updated_at, last_compacted_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    entry["conversation_id"],
                    entry.get("sdk_session_id"),
                    entry.get("workspace_id"),
                    entry.get("sandbox_session_id"),
                    entry.get("status", AgentSessionStatus.ACTIVE.value),
                    entry.get("model_id"),
                    entry.get("thinking_level"),
                    entry.get("system_prompt_version"),
                    entry.get("tool_registry_version"),
                    entry.get("sdk_version"),
                    int(entry.get("session_schema_version", 3)),
                    _json_dumps(entry.get("header_payload") or {}),
                    entry.get("created_at", now),
                    entry.get("updated_at", now),
                    entry.get("last_compacted_at"),
                ),
            )
            conn.commit()
        return self.get(session_id)  # type: ignore[return-value]

    def get(self, agent_session_id: str) -> AgentSessionResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM agent_sessions WHERE id = ?",
                (agent_session_id,),
            ).fetchone()
        if not row:
            return None
        return self._row_to_model(row, entry_count=self.count_entries(agent_session_id))

    def get_by_conversation(
        self, conversation_id: str
    ) -> AgentSessionResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM agent_sessions
                WHERE conversation_id = ?
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
        if not row:
            return None
        sid = row["id"]
        return self._row_to_model(row, entry_count=self.count_entries(sid))

    def update_meta(
        self,
        agent_session_id: str,
        *,
        header_payload: dict[str, Any] | None = None,
        sdk_session_id: str | None = None,
        model_id: str | None = None,
        thinking_level: str | None = None,
        sandbox_session_id: str | None = None,
        workspace_id: str | None = None,
        status: str | None = None,
        last_compacted_at: str | None = None,
        system_prompt_version: str | None = None,
        tool_registry_version: str | None = None,
        sdk_version: str | None = None,
        session_schema_version: int | None = None,
    ) -> AgentSessionResponse | None:
        current = self.get(agent_session_id)
        if current is None:
            return None
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE agent_sessions SET
                    header_payload = ?,
                    sdk_session_id = ?,
                    model_id = ?,
                    thinking_level = ?,
                    sandbox_session_id = ?,
                    workspace_id = ?,
                    status = ?,
                    last_compacted_at = ?,
                    system_prompt_version = ?,
                    tool_registry_version = ?,
                    sdk_version = ?,
                    session_schema_version = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                (
                    _json_dumps(
                        header_payload
                        if header_payload is not None
                        else current.header_payload
                    ),
                    sdk_session_id
                    if sdk_session_id is not None
                    else current.sdk_session_id,
                    model_id if model_id is not None else current.model_id,
                    thinking_level
                    if thinking_level is not None
                    else current.thinking_level,
                    sandbox_session_id
                    if sandbox_session_id is not None
                    else current.sandbox_session_id,
                    workspace_id if workspace_id is not None else current.workspace_id,
                    status if status is not None else current.status,
                    last_compacted_at
                    if last_compacted_at is not None
                    else current.last_compacted_at,
                    system_prompt_version
                    if system_prompt_version is not None
                    else current.system_prompt_version,
                    tool_registry_version
                    if tool_registry_version is not None
                    else current.tool_registry_version,
                    sdk_version if sdk_version is not None else current.sdk_version,
                    int(
                        session_schema_version
                        if session_schema_version is not None
                        else current.session_schema_version
                    ),
                    now,
                    agent_session_id,
                ),
            )
            conn.commit()
        return self.get(agent_session_id)

    def count_entries(self, agent_session_id: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) AS cnt FROM agent_session_entries "
                "WHERE agent_session_id = ?",
                (agent_session_id,),
            ).fetchone()
        if row is None:
            return 0
        try:
            return int(row["cnt"])
        except (KeyError, IndexError, TypeError):
            return int(row[0])

    def max_sequence(self, agent_session_id: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(sequence), 0) AS max_seq "
                "FROM agent_session_entries WHERE agent_session_id = ?",
                (agent_session_id,),
            ).fetchone()
        if row is None:
            return 0
        try:
            return int(row["max_seq"])
        except (KeyError, IndexError, TypeError):
            return int(row[0])

    def list_entries(
        self,
        agent_session_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[AgentSessionEntryResponse]:
        limit_clause = "LIMIT ?" if limit is not None else ""
        params: list[Any] = [agent_session_id, after_sequence]
        if limit is not None:
            params.append(limit)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM agent_session_entries
                WHERE agent_session_id = ? AND sequence > ?
                ORDER BY sequence ASC
                {limit_clause}
                """,
                tuple(params),
            ).fetchall()
        return [self._entry_row_to_model(r) for r in rows]

    def append_entries(
        self,
        agent_session_id: str,
        entries: list[dict[str, Any]],
    ) -> list[AgentSessionEntryResponse]:
        """Append entries with monotonic sequence. Idempotent on entry id."""
        if not entries:
            return []
        now = datetime.now(timezone.utc).isoformat()
        created: list[AgentSessionEntryResponse] = []
        with self.db.connect() as conn:
            backend = conn.backend
            if isinstance(backend, SQLiteBackend):
                conn.execute("BEGIN IMMEDIATE")
            elif isinstance(backend, PostgreSQLBackend):
                conn.execute(
                    "SELECT id FROM agent_sessions WHERE id = ? FOR UPDATE",
                    (agent_session_id,),
                )

            row = conn.execute(
                "SELECT COALESCE(MAX(sequence), 0) AS max_seq "
                "FROM agent_session_entries WHERE agent_session_id = ?",
                (agent_session_id,),
            ).fetchone()
            try:
                next_seq = int(row["max_seq"] if row is not None else 0) + 1
            except (KeyError, IndexError, TypeError):
                next_seq = int(row[0]) + 1 if row is not None else 1

            for item in entries:
                entry_id = item.get("id") or f"ase_{uuid.uuid4().hex}"
                existing = conn.execute(
                    "SELECT * FROM agent_session_entries WHERE id = ?",
                    (entry_id,),
                ).fetchone()
                if existing is not None:
                    created.append(self._entry_row_to_model(existing))
                    continue

                sequence = item.get("sequence")
                if sequence is None:
                    sequence = next_seq
                    next_seq += 1
                else:
                    sequence = int(sequence)
                    next_seq = max(next_seq, sequence + 1)

                parent_id = item.get("parent_entry_id")
                payload = item.get("entry_payload") or {}
                if parent_id is None and isinstance(payload, dict):
                    parent_id = payload.get("parentId")

                conn.execute(
                    """
                    INSERT INTO agent_session_entries (
                        id, agent_session_id, sequence, entry_type,
                        entry_payload, parent_entry_id, branch_id, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        entry_id,
                        agent_session_id,
                        sequence,
                        item.get("entry_type") or "custom",
                        _json_dumps(payload),
                        parent_id,
                        item.get("branch_id"),
                        item.get("created_at") or now,
                    ),
                )
                created.append(
                    AgentSessionEntryResponse(
                        id=entry_id,
                        agent_session_id=agent_session_id,
                        sequence=sequence,
                        entry_type=item.get("entry_type") or "custom",
                        entry_payload=payload if isinstance(payload, dict) else {},
                        parent_entry_id=parent_id,
                        branch_id=item.get("branch_id"),
                        created_at=item.get("created_at") or now,
                    )
                )

            conn.execute(
                "UPDATE agent_sessions SET updated_at = ? WHERE id = ?",
                (now, agent_session_id),
            )
            conn.commit()
        return created

    def build_jsonl(self, agent_session_id: str) -> str:
        """Materialize full Pi SDK JSONL (header + entries in sequence order)."""
        session = self.get(agent_session_id)
        if session is None:
            raise KeyError(f"agent session not found: {agent_session_id}")
        header = dict(session.header_payload or {})
        if not header or header.get("type") != "session":
            header = {
                "type": "session",
                "version": session.session_schema_version or 3,
                "id": session.sdk_session_id or session.id,
                "timestamp": session.created_at or datetime.now(timezone.utc).isoformat(),
                "cwd": "/tmp",
            }
        lines = [json.dumps(header, ensure_ascii=False, default=str)]
        for entry in self.list_entries(agent_session_id):
            payload = entry.entry_payload or {}
            lines.append(json.dumps(payload, ensure_ascii=False, default=str))
        return "\n".join(lines) + ("\n" if lines else "")

    def _row_to_model(
        self, row: Any, *, entry_count: int = 0
    ) -> AgentSessionResponse:
        def _col(name: str, default=None):
            try:
                val = row[name]
            except (KeyError, IndexError, TypeError):
                return default
            return default if val is None else val

        header = _json_loads(_col("header_payload", "{}"))
        if not isinstance(header, dict):
            header = {}
        return AgentSessionResponse(
            id=row["id"],
            conversation_id=row["conversation_id"],
            sdk_session_id=_col("sdk_session_id"),
            workspace_id=_col("workspace_id"),
            sandbox_session_id=_col("sandbox_session_id"),
            status=_col("status", AgentSessionStatus.ACTIVE.value),
            model_id=_col("model_id"),
            thinking_level=_col("thinking_level"),
            system_prompt_version=_col("system_prompt_version"),
            tool_registry_version=_col("tool_registry_version"),
            sdk_version=_col("sdk_version"),
            session_schema_version=int(_col("session_schema_version", 3) or 3),
            header_payload=header,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_compacted_at=_col("last_compacted_at"),
            entry_count=entry_count,
        )

    @staticmethod
    def _entry_row_to_model(row: Any) -> AgentSessionEntryResponse:
        def _col(name: str, default=None):
            try:
                val = row[name]
            except (KeyError, IndexError, TypeError):
                return default
            return default if val is None else val

        payload = _json_loads(_col("entry_payload", "{}"))
        if not isinstance(payload, dict):
            payload = {}
        return AgentSessionEntryResponse(
            id=row["id"],
            agent_session_id=row["agent_session_id"],
            sequence=int(row["sequence"]),
            entry_type=row["entry_type"],
            entry_payload=payload,
            parent_entry_id=_col("parent_entry_id"),
            branch_id=_col("branch_id"),
            created_at=row["created_at"],
        )


class AgentRunRepository:
    """CRUD + optimistic lease for agent runs."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def create(self, entry: dict[str, Any]) -> AgentRunResponse:
        now = datetime.now(timezone.utc).isoformat()
        budget_json = entry.get("budget_json")
        if budget_json is not None and not isinstance(budget_json, str):
            budget_json = _json_dumps(budget_json)
        pending_json = entry.get("pending_approval_json")
        if pending_json is not None and not isinstance(pending_json, str):
            pending_json = _json_dumps(pending_json)
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO agent_runs (
                    run_id, conversation_id, owner_user_id, organization_id,
                    status, lease_owner, lease_until, version,
                    sandbox_session_id, workspace_id, model_id,
                    budget_json, pending_approval_json,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry["run_id"],
                    entry["conversation_id"],
                    entry.get("owner_user_id"),
                    entry.get("organization_id"),
                    entry.get("status", AgentRunStatus.PENDING.value),
                    entry.get("lease_owner"),
                    entry.get("lease_until"),
                    int(entry.get("version", 0)),
                    entry.get("sandbox_session_id"),
                    entry.get("workspace_id"),
                    entry.get("model_id"),
                    budget_json,
                    pending_json,
                    entry.get("created_at", now),
                    entry.get("updated_at", now),
                ),
            )
            conn.commit()
        return self.get(entry["run_id"])  # type: ignore[return-value]

    def get(self, run_id: str) -> AgentRunResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM agent_runs WHERE run_id = ?", (run_id,)
            ).fetchone()
        return self._row_to_model(row) if row else None

    def get_active_for_conversation(
        self, conversation_id: str
    ) -> AgentRunResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM agent_runs
                WHERE conversation_id = ?
                  AND status IN ('pending', 'running', 'waiting_approval')
                ORDER BY created_at DESC
                LIMIT 1
                """,
                (conversation_id,),
            ).fetchone()
        return self._row_to_model(row) if row else None

    def list_by_conversation(self, conversation_id: str) -> list[AgentRunResponse]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM agent_runs
                WHERE conversation_id = ?
                ORDER BY created_at DESC
                """,
                (conversation_id,),
            ).fetchall()
        return [self._row_to_model(r) for r in rows]

    def list_by_status(self, status: str) -> list[AgentRunResponse]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM agent_runs
                WHERE status = ?
                ORDER BY created_at DESC
                """,
                (status,),
            ).fetchall()
        return [self._row_to_model(r) for r in rows]

    def set_pending_approval(
        self,
        run_id: str,
        pending: dict[str, Any] | None,
        *,
        status: str | None = None,
    ) -> AgentRunResponse | None:
        now = datetime.now(timezone.utc).isoformat()
        current = self.get(run_id)
        if current is None:
            return None
        new_status = status or current.status
        payload = _json_dumps(pending) if pending is not None else None
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE agent_runs
                SET pending_approval_json = ?,
                    status = ?,
                    version = version + 1,
                    updated_at = ?
                WHERE run_id = ?
                """,
                (payload, new_status, now, run_id),
            )
            conn.commit()
        return self.get(run_id)

    def set_budget_json(
        self, run_id: str, budget: dict[str, Any] | None
    ) -> AgentRunResponse | None:
        now = datetime.now(timezone.utc).isoformat()
        if self.get(run_id) is None:
            return None
        payload = _json_dumps(budget) if budget is not None else None
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE agent_runs
                SET budget_json = ?, version = version + 1, updated_at = ?
                WHERE run_id = ?
                """,
                (payload, now, run_id),
            )
            conn.commit()
        return self.get(run_id)

    def claim_lease(
        self,
        run_id: str,
        *,
        lease_owner: str,
        lease_until: str,
        expected_version: int | None = None,
        now_iso: str | None = None,
    ) -> AgentRunResponse | None:
        """Optimistic lease claim. Returns updated run or None on conflict."""
        now = now_iso or datetime.now(timezone.utc).isoformat()
        current = self.get(run_id)
        if current is None:
            return None
        version = (
            expected_version if expected_version is not None else current.version
        )
        # Reject if another owner holds a non-expired lease
        if (
            current.lease_owner
            and current.lease_owner != lease_owner
            and current.lease_until
            and current.lease_until > now
        ):
            return None
        if current.version != version:
            return None

        with self.db.connect() as conn:
            cur = conn.execute(
                """
                UPDATE agent_runs
                SET lease_owner = ?,
                    lease_until = ?,
                    version = version + 1,
                    status = ?,
                    updated_at = ?
                WHERE run_id = ?
                  AND version = ?
                  AND (
                    lease_owner IS NULL
                    OR lease_owner = ?
                    OR lease_until IS NULL
                    OR lease_until <= ?
                  )
                """,
                (
                    lease_owner,
                    lease_until,
                    AgentRunStatus.RUNNING.value,
                    now,
                    run_id,
                    version,
                    lease_owner,
                    now,
                ),
            )
            conn.commit()
            if cur.rowcount == 0:
                return None
        return self.get(run_id)

    def release_lease(
        self,
        run_id: str,
        *,
        lease_owner: str,
        status: str | None = None,
    ) -> AgentRunResponse | None:
        now = datetime.now(timezone.utc).isoformat()
        current = self.get(run_id)
        if current is None:
            return None
        if current.lease_owner and current.lease_owner != lease_owner:
            return None
        new_status = status or current.status
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE agent_runs
                SET lease_owner = NULL,
                    lease_until = NULL,
                    version = version + 1,
                    status = ?,
                    updated_at = ?
                WHERE run_id = ?
                  AND (lease_owner IS NULL OR lease_owner = ?)
                """,
                (new_status, now, run_id, lease_owner),
            )
            conn.commit()
        return self.get(run_id)

    def update_status(self, run_id: str, status: str) -> AgentRunResponse | None:
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE agent_runs
                SET status = ?, version = version + 1, updated_at = ?
                WHERE run_id = ?
                """,
                (status, now, run_id),
            )
            conn.commit()
        return self.get(run_id)

    def mark_interrupted(self, run_id: str) -> AgentRunResponse | None:
        return self.update_status(run_id, AgentRunStatus.INTERRUPTED.value)

    def update_usage(
        self,
        run_id: str,
        *,
        usage: dict[str, Any] | None = None,
        model_id: str | None = None,
    ) -> AgentRunResponse | None:
        """Persist run usage (tokens/cost) and optional final model_id."""
        now = datetime.now(timezone.utc).isoformat()
        current = self.get(run_id)
        if current is None:
            return None
        usage_json = (
            json.dumps(usage, ensure_ascii=False, default=str)
            if usage is not None
            else None
        )
        with self.db.connect() as conn:
            if usage is not None and model_id is not None:
                conn.execute(
                    """
                    UPDATE agent_runs
                    SET usage = ?, model_id = ?, version = version + 1, updated_at = ?
                    WHERE run_id = ?
                    """,
                    (usage_json, model_id, now, run_id),
                )
            elif usage is not None:
                conn.execute(
                    """
                    UPDATE agent_runs
                    SET usage = ?, version = version + 1, updated_at = ?
                    WHERE run_id = ?
                    """,
                    (usage_json, now, run_id),
                )
            elif model_id is not None:
                conn.execute(
                    """
                    UPDATE agent_runs
                    SET model_id = ?, version = version + 1, updated_at = ?
                    WHERE run_id = ?
                    """,
                    (model_id, now, run_id),
                )
            else:
                return current
            conn.commit()
        return self.get(run_id)

    def list_run_ids_for_conversation(self, conversation_id: str) -> list[str]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "SELECT run_id FROM agent_runs WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchall()
        return [r["run_id"] for r in rows]

    def delete_by_conversation(self, conversation_id: str) -> int:
        with self.db.connect() as conn:
            cur = conn.execute(
                "DELETE FROM agent_runs WHERE conversation_id = ?",
                (conversation_id,),
            )
            conn.commit()
            return cur.rowcount

    def delete(self, run_id: str) -> bool:
        with self.db.connect() as conn:
            cur = conn.execute(
                "DELETE FROM agent_runs WHERE run_id = ?", (run_id,)
            )
            conn.commit()
            return cur.rowcount > 0

    @staticmethod
    def _row_to_model(row) -> AgentRunResponse:
        def _col(name: str, default=None):
            try:
                val = row[name]
            except (KeyError, IndexError, TypeError):
                return default
            return default if val is None else val

        budget_raw = _col("budget_json")
        pending_raw = _col("pending_approval_json")
        usage_raw = _col("usage")
        usage: dict[str, Any] | None = None
        if usage_raw:
            if isinstance(usage_raw, dict):
                usage = usage_raw
            elif isinstance(usage_raw, str):
                try:
                    parsed = json.loads(usage_raw)
                    if isinstance(parsed, dict):
                        usage = parsed
                except (TypeError, ValueError, json.JSONDecodeError):
                    usage = None

        return AgentRunResponse(
            run_id=row["run_id"],
            conversation_id=row["conversation_id"],
            owner_user_id=_col("owner_user_id"),
            organization_id=_col("organization_id"),
            status=row["status"],
            lease_owner=_col("lease_owner"),
            lease_until=_col("lease_until"),
            version=int(row["version"] or 0),
            sandbox_session_id=_col("sandbox_session_id"),
            workspace_id=_col("workspace_id"),
            model_id=_col("model_id"),
            budget_json=_json_loads(budget_raw) if isinstance(budget_raw, str) else budget_raw,
            pending_approval_json=(
                _json_loads(pending_raw) if isinstance(pending_raw, str) else pending_raw
            ),
            usage=usage,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


def _is_unique_violation(exc: BaseException) -> bool:
    """True if *exc* is a unique/primary-key constraint failure (SQLite or PG)."""
    if isinstance(exc, sqlite3.IntegrityError):
        return True
    name = type(exc).__name__
    if name in {"IntegrityError", "UniqueViolation"}:
        return True
    # psycopg2.IntegrityError subclasses Exception; pgcode 23505 = unique_violation
    pgcode = getattr(exc, "pgcode", None)
    if pgcode == "23505":
        return True
    msg = str(exc).lower()
    return "unique" in msg or "duplicate key" in msg


def _unique_violation_kind(exc: BaseException) -> str:
    """Classify unique violation as ``event_id``, ``sequence``, or ``unknown``."""
    msg = str(exc).lower()
    if "event_id" in msg or "idx_agent_events_event_id" in msg:
        return "event_id"
    if (
        "sequence" in msg
        or "agent_events_pkey" in msg
        or "primary key" in msg
        or "(run_id, sequence)" in msg
        or "run_id, agent_events.sequence" in msg
    ):
        return "sequence"
    return "unknown"


class AgentEventRepository:
    """Append-only event store with monotonic sequence per run."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def append(
        self,
        *,
        run_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        event_id: str | None = None,
        schema_version: int = 1,
    ) -> AgentEventResponse:
        """Append event with next monotonic sequence.

        Uses an exclusive write transaction (SQLite ``BEGIN IMMEDIATE`` /
        PostgreSQL ``SELECT … FOR UPDATE`` on the run row) so concurrent
        appends on the same run allocate contiguous sequences. On
        ``UNIQUE(run_id, sequence)`` conflict, retries up to
        :data:`MAX_APPEND_SEQUENCE_RETRIES` times. On ``UNIQUE(event_id)``
        conflict, returns the existing row (idempotent success). Never
        leaves a partial commit for a failed attempt.
        """
        now = datetime.now(timezone.utc).isoformat()
        eid = event_id or f"evt_{uuid.uuid4().hex}"
        payload_json = _json_dumps(payload or {})
        payload_dict = payload or {}

        # Fast path: stable idempotent return if event_id already exists.
        if event_id is not None:
            existing = self.get_by_event_id(eid)
            if existing is not None:
                return existing

        last_error: BaseException | None = None
        for attempt in range(MAX_APPEND_SEQUENCE_RETRIES):
            try:
                return self._append_once(
                    run_id=run_id,
                    event_type=event_type,
                    payload_json=payload_json,
                    payload_dict=payload_dict,
                    eid=eid,
                    schema_version=schema_version,
                    now=now,
                )
            except Exception as exc:
                if not _is_unique_violation(exc):
                    raise
                kind = _unique_violation_kind(exc)
                if kind == "event_id" or kind == "unknown":
                    # Idempotent: another writer committed this event_id.
                    existing = self.get_by_event_id(eid)
                    if existing is not None:
                        return existing
                    if kind == "event_id":
                        # Race: constraint fired but row not visible yet; brief retry.
                        last_error = exc
                        if attempt + 1 < MAX_APPEND_SEQUENCE_RETRIES:
                            time.sleep(0.001 * (attempt + 1))
                            continue
                        raise
                # sequence conflict (or unclassified unique) → bounded retry
                last_error = exc
                if attempt + 1 >= MAX_APPEND_SEQUENCE_RETRIES:
                    break
                time.sleep(0.001 * (attempt + 1))

        raise RuntimeError(
            f"agent event append failed after {MAX_APPEND_SEQUENCE_RETRIES} "
            f"sequence retries for run_id={run_id!r}"
        ) from last_error

    def _append_once(
        self,
        *,
        run_id: str,
        event_type: str,
        payload_json: str,
        payload_dict: dict[str, Any],
        eid: str,
        schema_version: int,
        now: str,
    ) -> AgentEventResponse:
        """Single transactional attempt: lock, allocate sequence, insert."""
        with self.db.connect() as conn:
            backend = conn.backend
            try:
                if isinstance(backend, SQLiteBackend):
                    # Exclusive write lock for the whole allocate+insert unit.
                    conn.execute("BEGIN IMMEDIATE")
                elif isinstance(backend, PostgreSQLBackend):
                    # Serialize appends per run via the parent run row when present.
                    conn.execute(
                        "SELECT run_id FROM agent_runs WHERE run_id = ? FOR UPDATE",
                        (run_id,),
                    )

                existing = conn.execute(
                    "SELECT * FROM agent_events WHERE event_id = ?",
                    (eid,),
                ).fetchone()
                if existing is not None:
                    conn.commit()
                    return self._row_to_model(existing)

                row = conn.execute(
                    "SELECT COALESCE(MAX(sequence), 0) AS max_seq "
                    "FROM agent_events WHERE run_id = ?",
                    (run_id,),
                ).fetchone()
                try:
                    max_seq = int(row["max_seq"] if row is not None else 0)
                except (KeyError, IndexError, TypeError):
                    max_seq = int(row[0]) if row is not None else 0
                sequence = max_seq + 1

                conn.execute(
                    """
                    INSERT INTO agent_events (
                        run_id, sequence, event_id, type, payload, schema_version, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        run_id,
                        sequence,
                        eid,
                        event_type,
                        payload_json,
                        schema_version,
                        now,
                    ),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise

        return AgentEventResponse(
            run_id=run_id,
            sequence=sequence,
            event_id=eid,
            type=event_type,
            payload=payload_dict,
            schema_version=schema_version,
            created_at=now,
        )

    def get_by_event_id(self, event_id: str) -> AgentEventResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM agent_events WHERE event_id = ?",
                (event_id,),
            ).fetchone()
        return self._row_to_model(row) if row else None

    def list_by_run(
        self,
        run_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[AgentEventResponse]:
        with self.db.connect() as conn:
            if limit is not None:
                rows = conn.execute(
                    """
                    SELECT * FROM agent_events
                    WHERE run_id = ? AND sequence > ?
                    ORDER BY sequence ASC
                    LIMIT ?
                    """,
                    (run_id, after_sequence, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM agent_events
                    WHERE run_id = ? AND sequence > ?
                    ORDER BY sequence ASC
                    """,
                    (run_id, after_sequence),
                ).fetchall()
        return [self._row_to_model(r) for r in rows]

    def max_sequence(self, run_id: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM agent_events WHERE run_id = ?",
                (run_id,),
            ).fetchone()
        if row is None:
            return 0
        try:
            return int(row["max_seq"])
        except (KeyError, IndexError, TypeError):
            return int(row[0])

    def delete_by_run_ids(self, run_ids: list[str]) -> int:
        if not run_ids:
            return 0
        placeholders = ",".join("?" for _ in run_ids)
        with self.db.connect() as conn:
            cur = conn.execute(
                f"DELETE FROM agent_events WHERE run_id IN ({placeholders})",
                tuple(run_ids),
            )
            conn.commit()
            return cur.rowcount

    def count_older_than(
        self,
        older_than_iso: str,
        *,
        exclude_legal_hold: bool = True,
    ) -> int:
        hold_clause = ""
        if exclude_legal_hold:
            hold_clause = """
              AND run_id NOT IN (
                SELECT ar.run_id FROM agent_runs ar
                INNER JOIN conversations c ON c.id = ar.conversation_id
                WHERE COALESCE(c.legal_hold, 0) = 1
              )
            """
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                SELECT COUNT(*) AS n FROM agent_events
                WHERE created_at < ?
                {hold_clause}
                """,
                (older_than_iso,),
            ).fetchone()
        return int(row["n"] if row is not None else 0)

    def delete_older_than(
        self,
        *,
        older_than_iso: str,
        exclude_legal_hold: bool = True,
        limit: int | None = None,
    ) -> int:
        """Hard-delete agent_events older than cutoff (Legal Hold aware)."""
        hold_clause = ""
        if exclude_legal_hold:
            hold_clause = """
              AND run_id NOT IN (
                SELECT ar.run_id FROM agent_runs ar
                INNER JOIN conversations c ON c.id = ar.conversation_id
                WHERE COALESCE(c.legal_hold, 0) = 1
              )
            """
        with self.db.connect() as conn:
            if limit is not None:
                # Delete by (run_id, sequence) primary key in a bounded batch
                rows = conn.execute(
                    f"""
                    SELECT run_id, sequence FROM agent_events
                    WHERE created_at < ?
                    {hold_clause}
                    ORDER BY created_at ASC
                    LIMIT ?
                    """,
                    (older_than_iso, limit),
                ).fetchall()
                deleted = 0
                for r in rows:
                    cur = conn.execute(
                        "DELETE FROM agent_events WHERE run_id = ? AND sequence = ?",
                        (r["run_id"], r["sequence"]),
                    )
                    deleted += cur.rowcount
                conn.commit()
                return deleted
            cur = conn.execute(
                f"""
                DELETE FROM agent_events
                WHERE created_at < ?
                {hold_clause}
                """,
                (older_than_iso,),
            )
            conn.commit()
            return cur.rowcount

    @staticmethod
    def _row_to_model(row) -> AgentEventResponse:
        payload_raw = row["payload"]
        if isinstance(payload_raw, dict):
            payload = payload_raw
        else:
            payload = _json_loads(payload_raw) if payload_raw else {}
            if not isinstance(payload, dict):
                payload = {"value": payload}
        return AgentEventResponse(
            run_id=row["run_id"],
            sequence=int(row["sequence"]),
            event_id=row["event_id"],
            type=row["type"],
            payload=payload,
            schema_version=int(row["schema_version"] or 1),
            created_at=row["created_at"],
        )


class ToolExecutionRepository:
    """Tool execution ledger: prepared → waiting_approval → executing → terminal.

    Never auto-retry ``unknown`` or other terminal statuses (ADR §4.4 / §12.3).
    """

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def prepare(
        self,
        *,
        tool_call_id: str,
        run_id: str,
        idempotency_key: str,
        tool_name: str | None = None,
        arguments: dict | list | None = None,
        session_id: str | None = None,
        conversation_id: str | None = None,
        workspace_id: str | None = None,
        execution_id: str | None = None,
        summary: str | None = None,
    ) -> ToolExecutionResponse:
        """Insert prepared row. Idempotent on tool_call_id / idempotency_key."""
        existing = self.get_by_idempotency_key(idempotency_key)
        if existing is not None:
            return existing
        by_id = self.get(tool_call_id)
        if by_id is not None:
            return by_id

        now = datetime.now(timezone.utc).isoformat()
        args_json = _json_dumps(arguments) if arguments is not None else None
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO tool_executions (
                    tool_call_id, run_id, status, idempotency_key, summary,
                    session_id, conversation_id, workspace_id, tool_name,
                    arguments, execution_id, result_summary,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tool_call_id,
                    run_id,
                    ToolExecutionStatus.PREPARED.value,
                    idempotency_key,
                    summary,
                    session_id,
                    conversation_id,
                    workspace_id,
                    tool_name,
                    args_json,
                    execution_id,
                    summary,
                    now,
                    now,
                ),
            )
            conn.commit()
        return self.get(tool_call_id)  # type: ignore[return-value]

    def get(self, tool_call_id: str) -> ToolExecutionResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM tool_executions WHERE tool_call_id = ?",
                (tool_call_id,),
            ).fetchone()
        return self._row_to_model(row) if row else None

    def get_by_idempotency_key(
        self, idempotency_key: str
    ) -> ToolExecutionResponse | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM tool_executions WHERE idempotency_key = ?",
                (idempotency_key,),
            ).fetchone()
        return self._row_to_model(row) if row else None

    def list_by_run(self, run_id: str) -> list[ToolExecutionResponse]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM tool_executions
                WHERE run_id = ?
                ORDER BY created_at ASC
                """,
                (run_id,),
            ).fetchall()
        return [self._row_to_model(r) for r in rows]

    def mark_executing(self, tool_call_id: str) -> ToolExecutionResponse | None:
        current = self.get(tool_call_id)
        if current is None:
            return None
        if current.status in TOOL_TERMINAL_STATUSES:
            return current
        if current.status not in {
            ToolExecutionStatus.PREPARED.value,
            ToolExecutionStatus.WAITING_APPROVAL.value,
            ToolExecutionStatus.EXECUTING.value,
        }:
            return current
        if current.status == ToolExecutionStatus.EXECUTING.value:
            return current
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE tool_executions
                SET status = ?, started_at = COALESCE(started_at, ?), updated_at = ?
                WHERE tool_call_id = ? AND status IN (?, ?)
                """,
                (
                    ToolExecutionStatus.EXECUTING.value,
                    now,
                    now,
                    tool_call_id,
                    ToolExecutionStatus.PREPARED.value,
                    ToolExecutionStatus.WAITING_APPROVAL.value,
                ),
            )
            conn.commit()
        return self.get(tool_call_id)

    def mark_waiting_approval(
        self, tool_call_id: str
    ) -> ToolExecutionResponse | None:
        return self._transition(
            tool_call_id,
            allowed_from={ToolExecutionStatus.PREPARED.value},
            to_status=ToolExecutionStatus.WAITING_APPROVAL.value,
        )

    def mark_terminal(
        self,
        tool_call_id: str,
        status: str,
        *,
        summary: str | None = None,
        error: str | None = None,
        result_json: dict | list | None = None,
        execution_id: str | None = None,
    ) -> ToolExecutionResponse | None:
        if status not in TOOL_TERMINAL_STATUSES:
            raise ValueError(
                f"status must be terminal ({sorted(TOOL_TERMINAL_STATUSES)}), got {status!r}"
            )
        current = self.get(tool_call_id)
        if current is None:
            return None
        if current.status in TOOL_TERMINAL_STATUSES:
            # Already terminal — do not overwrite (especially unknown)
            return current
        now = datetime.now(timezone.utc).isoformat()
        result_blob = _json_dumps(result_json) if result_json is not None else None
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE tool_executions
                SET status = ?,
                    summary = COALESCE(?, summary),
                    result_summary = COALESCE(?, result_summary),
                    error = COALESCE(?, error),
                    result_json = COALESCE(?, result_json),
                    execution_id = COALESCE(?, execution_id),
                    finished_at = ?,
                    updated_at = ?
                WHERE tool_call_id = ?
                """,
                (
                    status,
                    summary,
                    summary,
                    error,
                    result_blob,
                    execution_id,
                    now,
                    now,
                    tool_call_id,
                ),
            )
            conn.commit()
        return self.get(tool_call_id)

    def can_auto_retry(self, tool_call_id: str) -> bool:
        """Return False for terminal or unknown; True only if never prepared or non-terminal."""
        row = self.get(tool_call_id)
        if row is None:
            return True  # never prepared → may start
        if row.status == ToolExecutionStatus.UNKNOWN.value:
            return False
        if row.status in TOOL_TERMINAL_STATUSES:
            return False
        # executing / waiting_approval: do not auto-retry side effects
        if row.status in {
            ToolExecutionStatus.EXECUTING.value,
            ToolExecutionStatus.WAITING_APPROVAL.value,
        }:
            return False
        return True

    def delete_by_run_ids(self, run_ids: list[str]) -> int:
        if not run_ids:
            return 0
        placeholders = ",".join("?" for _ in run_ids)
        with self.db.connect() as conn:
            cur = conn.execute(
                f"DELETE FROM tool_executions WHERE run_id IN ({placeholders})",
                tuple(run_ids),
            )
            conn.commit()
            return cur.rowcount

    def _transition(
        self,
        tool_call_id: str,
        *,
        allowed_from: set[str],
        to_status: str,
    ) -> ToolExecutionResponse | None:
        current = self.get(tool_call_id)
        if current is None:
            return None
        if current.status in TOOL_TERMINAL_STATUSES:
            return current
        if current.status not in allowed_from:
            return current
        now = datetime.now(timezone.utc).isoformat()
        with self.db.connect() as conn:
            conn.execute(
                """
                UPDATE tool_executions
                SET status = ?, updated_at = ?
                WHERE tool_call_id = ? AND status = ?
                """,
                (to_status, now, tool_call_id, current.status),
            )
            conn.commit()
        return self.get(tool_call_id)

    @staticmethod
    def _row_to_model(row) -> ToolExecutionResponse:
        def _col(name: str, default=None):
            try:
                val = row[name]
            except (KeyError, IndexError, TypeError):
                return default
            return default if val is None else val

        summary = _col("summary")
        result_summary = _col("result_summary") or summary
        args_raw = _col("arguments")
        result_raw = _col("result_json")
        return ToolExecutionResponse(
            tool_call_id=row["tool_call_id"],
            run_id=row["run_id"],
            status=row["status"],
            idempotency_key=row["idempotency_key"],
            tool_name=_col("tool_name"),
            arguments=_json_loads(args_raw) if args_raw else None,
            session_id=_col("session_id"),
            conversation_id=_col("conversation_id"),
            workspace_id=_col("workspace_id"),
            execution_id=_col("execution_id"),
            started_at=_col("started_at"),
            finished_at=_col("finished_at"),
            result_summary=result_summary,
            error=_col("error"),
            result_json=_json_loads(result_raw) if result_raw else None,
            summary=result_summary,
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

    def count_older_than(
        self,
        older_than_iso: str,
        *,
        exclude_legal_hold: bool = True,
    ) -> int:
        hold_clause = ""
        if exclude_legal_hold:
            hold_clause = """
              AND (
                session_id IS NULL
                OR session_id = ''
                OR session_id NOT IN (
                  SELECT sandbox_session_id FROM conversations
                  WHERE COALESCE(legal_hold, 0) = 1
                    AND sandbox_session_id IS NOT NULL
                    AND sandbox_session_id != ''
                )
              )
            """
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                SELECT COUNT(*) AS n FROM audit_logs
                WHERE created_at < ?
                {hold_clause}
                """,
                (older_than_iso,),
            ).fetchone()
        return int(row["n"] if row is not None else 0)

    def delete_older_than(
        self,
        *,
        older_than_iso: str,
        exclude_legal_hold: bool = True,
        limit: int | None = None,
    ) -> int:
        """Hard-delete audit_logs older than cutoff (Legal Hold aware)."""
        hold_clause = ""
        if exclude_legal_hold:
            hold_clause = """
              AND (
                session_id IS NULL
                OR session_id = ''
                OR session_id NOT IN (
                  SELECT sandbox_session_id FROM conversations
                  WHERE COALESCE(legal_hold, 0) = 1
                    AND sandbox_session_id IS NOT NULL
                    AND sandbox_session_id != ''
                )
              )
            """
        with self.db.connect() as conn:
            if limit is not None:
                id_rows = conn.execute(
                    f"""
                    SELECT id FROM audit_logs
                    WHERE created_at < ?
                    {hold_clause}
                    ORDER BY created_at ASC, id ASC
                    LIMIT ?
                    """,
                    (older_than_iso, limit),
                ).fetchall()
                ids = [r["id"] for r in id_rows]
                if not ids:
                    return 0
                placeholders = ",".join("?" for _ in ids)
                cur = conn.execute(
                    f"DELETE FROM audit_logs WHERE id IN ({placeholders})",
                    tuple(ids),
                )
            else:
                cur = conn.execute(
                    f"""
                    DELETE FROM audit_logs
                    WHERE created_at < ?
                    {hold_clause}
                    """,
                    (older_than_iso,),
                )
            conn.commit()
            return cur.rowcount


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


class ProcessRepository:
    """Persistence for managed process_executions (B2 Process Manager)."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def upsert(self, entry: dict[str, Any]) -> None:
        status = entry.get("status", ProcessStatus.CREATED)
        if hasattr(status, "value"):
            status = status.value
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO process_executions (
                    process_id, session_id, run_id, command, cwd, env_json,
                    status, pid, exit_code, background, timeout_seconds, error,
                    stdout_log, stderr_log, log_truncated, log_total,
                    started_at, finished_at, created_at, updated_at, trace_id
                ) VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                ON CONFLICT(process_id) DO UPDATE SET
                    session_id=excluded.session_id,
                    run_id=excluded.run_id,
                    command=excluded.command,
                    cwd=excluded.cwd,
                    env_json=excluded.env_json,
                    status=excluded.status,
                    pid=excluded.pid,
                    exit_code=excluded.exit_code,
                    background=excluded.background,
                    timeout_seconds=excluded.timeout_seconds,
                    error=excluded.error,
                    stdout_log=excluded.stdout_log,
                    stderr_log=excluded.stderr_log,
                    log_truncated=excluded.log_truncated,
                    log_total=excluded.log_total,
                    started_at=excluded.started_at,
                    finished_at=excluded.finished_at,
                    updated_at=excluded.updated_at,
                    trace_id=excluded.trace_id
                """,
                (
                    entry["process_id"],
                    entry["session_id"],
                    entry.get("run_id"),
                    entry.get("command", ""),
                    entry.get("cwd"),
                    entry.get("env_json"),
                    str(status),
                    entry.get("pid"),
                    entry.get("exit_code"),
                    1 if entry.get("background") else 0,
                    entry.get("timeout_seconds"),
                    entry.get("error"),
                    entry.get("stdout_log", "") or "",
                    entry.get("stderr_log", "") or "",
                    1 if entry.get("log_truncated") else 0,
                    int(entry.get("log_total") or 0),
                    entry.get("started_at"),
                    entry.get("finished_at"),
                    entry.get("created_at"),
                    entry.get("updated_at"),
                    entry.get("trace_id"),
                ),
            )
            conn.commit()

    def get(self, process_id: str) -> dict[str, Any] | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "SELECT * FROM process_executions WHERE process_id = ?",
                (process_id,),
            ).fetchone()
        return self._row_to_dict(row) if row else None

    def list_by_session(self, session_id: str) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM process_executions
                WHERE session_id = ?
                ORDER BY created_at
                """,
                (session_id,),
            ).fetchall()
        return [self._row_to_dict(r) for r in rows if r is not None]

    def list_by_run(self, run_id: str) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM process_executions
                WHERE run_id = ?
                ORDER BY created_at
                """,
                (run_id,),
            ).fetchall()
        return [self._row_to_dict(r) for r in rows if r is not None]

    def list_active(self) -> list[dict[str, Any]]:
        """Return processes that were non-terminal at last persist (orphan candidates)."""
        active_values = sorted(
            {s.value if hasattr(s, "value") else str(s) for s in PROCESS_ACTIVE_STATUSES}
        )
        placeholders = ",".join("?" for _ in active_values)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                SELECT * FROM process_executions
                WHERE status IN ({placeholders})
                ORDER BY created_at
                """,
                tuple(active_values),
            ).fetchall()
        return [self._row_to_dict(r) for r in rows if r is not None]

    def total_count(self) -> int:
        with self.db.connect() as conn:
            row = conn.execute("SELECT COUNT(*) FROM process_executions").fetchone()
        if row is None:
            return 0
        try:
            return int(row[0])
        except (KeyError, IndexError, TypeError):
            return int(next(iter(dict(row).values())))

    @staticmethod
    def _row_to_dict(row: Any) -> dict[str, Any]:
        return {
            "process_id": row["process_id"],
            "session_id": row["session_id"],
            "run_id": row["run_id"],
            "command": row["command"] or "",
            "cwd": row["cwd"],
            "env_json": row["env_json"],
            "status": row["status"],
            "pid": row["pid"],
            "exit_code": row["exit_code"],
            "background": bool(row["background"]),
            "timeout_seconds": row["timeout_seconds"],
            "error": row["error"],
            "stdout_log": row["stdout_log"] or "",
            "stderr_log": row["stderr_log"] or "",
            "log_truncated": bool(row["log_truncated"]),
            "log_total": int(row["log_total"] or 0),
            "started_at": row["started_at"],
            "finished_at": row["finished_at"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
            "trace_id": row["trace_id"],
        }
