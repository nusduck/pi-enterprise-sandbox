"""Session resource root — public (Actor-authenticated) workspace cleanup.

Companion to ``files.router``'s ``/sessions/{session_id}/files``: this covers
the session resource root itself. Currently exposes only workspace removal,
triggered by Agent conversation delete/archive (D2 triage decision: deleting
a conversation deletes its Sandbox workspace(s); no separate legal-hold
requirement). Not part of the internal HMAC plane — same JWT / service+acting
header auth as the other legacy-but-alive public session routes.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from sandbox.security.ownership import require_end_user_actor
from sandbox.services.formal_session_runtime import (
    SessionProvisioningError,
    get_formal_session_runtime,
)
from sandbox.services.workspace_manager import WorkspaceCleanupError

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.delete("/{session_id}")
def remove_session_workspace(session_id: str, request: Request) -> JSONResponse:
    """Remove a SandboxSession's physical workspace (idempotent GC endpoint).

    A session not owned by the authenticated actor — missing, already
    removed, or belonging to another tenant — is treated as already-clean:
    200 with ``removed: false``, never an error. This lets Agent call it
    once per AgentSession bound to a deleted conversation without needing to
    know in advance whether Sandbox ever provisioned that session.
    """
    runtime = get_formal_session_runtime(request.app)
    if runtime is None:
        raise HTTPException(
            status_code=503, detail="Formal session runtime unavailable"
        )
    actor = require_end_user_actor(request)
    if actor is None:
        raise HTTPException(
            status_code=503,
            detail="Formal public session access requires owner authentication",
        )
    try:
        removed = runtime.remove_owned(
            session_id,
            org_id=actor.organization_id,
            user_id=actor.user_id,
        )
    except WorkspaceCleanupError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except SessionProvisioningError as exc:
        raise HTTPException(
            status_code=exc.status, detail=exc.message
        ) from exc
    return JSONResponse(
        status_code=200,
        content={"sessionId": session_id, "removed": removed},
    )


__all__ = ["router"]
