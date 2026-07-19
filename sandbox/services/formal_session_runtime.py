"""Formal AgentSession -> SandboxSession provisioning runtime."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from sandbox.app.domain.types import OwnerScope, SandboxSessionRecord
from sandbox.app.persistence.repositories.session_repository import SessionRepository
from sandbox.security.path_validation import validate_formal_id
from sandbox.services.workspace_manager import workspace_manager

SESSION_RUNTIME_STATE_KEY = "formal_session_runtime"


class SessionProvisioningError(RuntimeError):
    """Safe typed provisioning failure."""

    def __init__(self, code: str, message: str, *, status: int) -> None:
        self.code = code
        self.message = message
        self.status = status
        super().__init__(message)


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def parse_session_ensure_body(raw_body: bytes) -> str:
    """Return the sole ``workspaceId`` from a strict bounded JSON object."""
    try:
        body = json.loads(
            raw_body.decode("utf-8", errors="strict"),
            object_pairs_hook=_strict_object,
        )
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
        raise SessionProvisioningError(
            "SESSION_BODY_INVALID", "Invalid session request", status=400
        ) from exc
    if type(body) is not dict or set(body) != {"workspaceId"}:
        raise SessionProvisioningError(
            "SESSION_BODY_INVALID", "Invalid session request", status=400
        )
    try:
        return validate_formal_id(body["workspaceId"], "workspaceId")
    except (TypeError, ValueError) as exc:
        raise SessionProvisioningError(
            "SESSION_BODY_INVALID", "Invalid session request", status=400
        ) from exc


@dataclass(slots=True)
class FormalSessionRuntime:
    db: Any
    repository: SessionRepository

    def resolve_owned(
        self,
        sandbox_session_id: str,
        *,
        org_id: str,
        user_id: str,
    ) -> FormalPublicSession | None:
        """Resolve the public resource view from the formal owner binding.

        Both sides of the AgentSession/SandboxSession logical 1:1 binding are
        checked. A missing or inconsistent binding is indistinguishable from a
        missing session so public callers cannot probe another tenant.
        """
        try:
            sandbox_session_id = validate_formal_id(
                sandbox_session_id, "sandbox_session_id"
            )
            org_id = validate_formal_id(org_id, "org_id")
            user_id = validate_formal_id(user_id, "user_id")
        except (TypeError, ValueError):
            return None

        scope = OwnerScope(org_id=org_id, user_id=user_id)
        try:
            with self.db.connection() as conn:
                record = self.repository.get_by_id(
                    conn, sandbox_session_id, scope
                )
                if record is None:
                    return None
                conn.execute(
                    """
                    SELECT conversation_id, last_run_id
                    FROM agent_sessions
                    WHERE agent_session_id = %s
                      AND org_id = %s
                      AND user_id = %s
                      AND sandbox_session_id = %s
                      AND workspace_id = %s
                    """,
                    (
                        record.agent_session_id,
                        org_id,
                        user_id,
                        record.sandbox_session_id,
                        record.workspace_id,
                    ),
                )
                parent = conn.fetchone()
        except Exception as exc:
            raise SessionProvisioningError(
                "SESSION_RESOLUTION_FAILED",
                "Session persistence unavailable",
                status=503,
            ) from exc

        if parent is None:
            return None
        conversation_id = str(parent.get("conversation_id") or "").strip()
        if not conversation_id:
            return None
        metadata: dict[str, Any] = {
            "organization_id": record.org_id,
            "conversation_id": conversation_id,
            "workspace_id": record.workspace_id,
            "agent_session_id": record.agent_session_id,
        }
        last_run_id = str(parent.get("last_run_id") or "").strip()
        if last_run_id:
            metadata["last_run_id"] = last_run_id
        return FormalPublicSession(
            session_id=record.sandbox_session_id,
            user_id=record.user_id,
            agent_session_id=record.agent_session_id,
            workspace_id=record.workspace_id,
            status=record.status,
            created_at=record.created_at,
            updated_at=record.updated_at,
            metadata=metadata,
        )

    def ensure(
        self,
        *,
        claims: Mapping[str, Any],
        workspace_id: str,
    ) -> SandboxSessionRecord:
        try:
            org_id = validate_formal_id(str(claims["org_id"]), "org_id")
            user_id = validate_formal_id(str(claims["user_id"]), "user_id")
            conversation_id = validate_formal_id(
                str(claims["conversation_id"]), "conversation_id"
            )
            agent_session_id = validate_formal_id(
                str(claims["agent_session_id"]), "agent_session_id"
            )
            sandbox_session_id = validate_formal_id(
                str(claims["sandbox_session_id"]), "sandbox_session_id"
            )
            workspace_id = validate_formal_id(workspace_id, "workspace_id")
        except (KeyError, TypeError, ValueError) as exc:
            raise SessionProvisioningError(
                "SESSION_IDENTITY_INVALID", "Invalid session identity", status=400
            ) from exc

        scope = OwnerScope(org_id=org_id, user_id=user_id)
        try:
            with self.db.connection() as conn:
                self._require_active_agent_parent(
                    conn,
                    scope=scope,
                    conversation_id=conversation_id,
                    agent_session_id=agent_session_id,
                    sandbox_session_id=sandbox_session_id,
                    workspace_id=workspace_id,
                    execution_fence_token=claims.get("execution_fence_token"),
                )
                matches = [
                    self.repository.get_by_id(conn, sandbox_session_id, scope),
                    self.repository.get_by_agent_session_id(
                        conn, agent_session_id, scope
                    ),
                    self.repository.get_by_workspace_id(conn, workspace_id, scope),
                ]
                existing = next((row for row in matches if row is not None), None)
                if existing is not None:
                    if any(
                        row is not None
                        and row.sandbox_session_id != existing.sandbox_session_id
                        for row in matches
                    ) or not self._same_binding(
                        existing,
                        sandbox_session_id=sandbox_session_id,
                        agent_session_id=agent_session_id,
                        workspace_id=workspace_id,
                    ):
                        raise SessionProvisioningError(
                            "SESSION_BINDING_CONFLICT",
                            "Session binding conflict",
                            status=409,
                        )
                    if existing.status != "ACTIVE":
                        raise SessionProvisioningError(
                            "SESSION_NOT_ACTIVE",
                            "Sandbox session is not active",
                            status=409,
                        )
                    conn.commit()
                    record = existing
                else:
                    record = self.repository.create(
                        conn,
                        {
                            "sandbox_session_id": sandbox_session_id,
                            "org_id": org_id,
                            "user_id": user_id,
                            "agent_session_id": agent_session_id,
                            "workspace_id": workspace_id,
                            "status": "ACTIVE",
                        },
                    )
                    conn.commit()
        except SessionProvisioningError:
            raise
        except Exception as exc:
            raise SessionProvisioningError(
                "SESSION_PERSISTENCE_FAILED",
                "Session persistence unavailable",
                status=503,
            ) from exc

        try:
            workspace_manager.init_workspace(workspace_id)
        except Exception as exc:
            # Keep the formal binding reserved. A retry can repair the physical
            # directory without ever reassigning its identity to another session.
            raise SessionProvisioningError(
                "SESSION_WORKSPACE_FAILED",
                "Workspace initialization failed",
                status=503,
            ) from exc
        return record

    @staticmethod
    def _same_binding(
        row: SandboxSessionRecord,
        *,
        sandbox_session_id: str,
        agent_session_id: str,
        workspace_id: str,
    ) -> bool:
        return (
            row.sandbox_session_id == sandbox_session_id
            and row.agent_session_id == agent_session_id
            and row.workspace_id == workspace_id
        )

    @staticmethod
    def _require_active_agent_parent(
        conn: Any,
        *,
        scope: OwnerScope,
        conversation_id: str,
        agent_session_id: str,
        sandbox_session_id: str,
        workspace_id: str,
        execution_fence_token: int | None,
    ) -> None:
        query = """
            SELECT agent_session_id
            FROM agent_sessions
            WHERE agent_session_id = %s
              AND org_id = %s
              AND user_id = %s
              AND conversation_id = %s
              AND sandbox_session_id = %s
              AND workspace_id = %s
              AND status = 'ACTIVE'
        """
        params: tuple[Any, ...] = (
            agent_session_id,
            scope.org_id,
            scope.user_id,
            conversation_id,
            sandbox_session_id,
            workspace_id,
        )
        if execution_fence_token is not None:
            if (
                type(execution_fence_token) is not int
                or execution_fence_token <= 0
            ):
                raise SessionProvisioningError(
                    "SESSION_IDENTITY_INVALID", "Invalid session identity", status=400
                )
            query += " AND execution_fence_token = %s"
            params += (execution_fence_token,)
        query += " FOR SHARE"
        conn.execute(query, params)
        if conn.fetchone() is None:
            raise SessionProvisioningError(
                "SESSION_PARENT_MISMATCH",
                "Agent session binding not found",
                status=409,
            )


@dataclass(frozen=True, slots=True)
class FormalPublicSession:
    """Compatibility view consumed by public file/dataset/artifact adapters."""

    session_id: str
    user_id: str
    agent_session_id: str
    workspace_id: str
    status: str
    created_at: str
    updated_at: str
    metadata: dict[str, Any]


def set_formal_session_runtime(app: Any, runtime: FormalSessionRuntime | None) -> None:
    app.state.formal_session_runtime = runtime


def get_formal_session_runtime(app: Any) -> FormalSessionRuntime | None:
    return getattr(app.state, SESSION_RUNTIME_STATE_KEY, None)


__all__ = [
    "FormalPublicSession",
    "FormalSessionRuntime",
    "SessionProvisioningError",
    "get_formal_session_runtime",
    "parse_session_ensure_body",
    "set_formal_session_runtime",
]
