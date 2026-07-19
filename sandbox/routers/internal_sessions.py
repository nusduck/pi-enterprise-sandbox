"""Agent internal plane: idempotent SandboxSession provisioning."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from sandbox.security.internal_http_auth import (
    InternalAuthContext,
    require_internal_auth,
)
from sandbox.services.formal_session_runtime import (
    SessionProvisioningError,
    get_formal_session_runtime,
    parse_session_ensure_body,
)

router = APIRouter(tags=["internal-sessions"])

SESSION_ENSURE_SCOPE = "sandbox.sessions.ensure"
SESSION_ENSURE_TOOL = "session.ensure"
SESSION_ENSURE_MAX_BODY_BYTES = 1024

_auth_dep = require_internal_auth(
    expected_scope=SESSION_ENSURE_SCOPE,
    expected_tool_name=SESSION_ENSURE_TOOL,
    max_body_bytes=SESSION_ENSURE_MAX_BODY_BYTES,
)


@router.post("/internal/v1/sessions/ensure")
async def internal_session_ensure(
    request: Request,
    ctx: InternalAuthContext = Depends(_auth_dep),
) -> JSONResponse:
    runtime = get_formal_session_runtime(request.app)
    if runtime is None:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")
    try:
        workspace_id = parse_session_ensure_body(await request.body())
        record = runtime.ensure(claims=ctx.claims, workspace_id=workspace_id)
    except SessionProvisioningError as exc:
        raise HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    return JSONResponse(
        status_code=200,
        content={
            "sandboxSessionId": record.sandbox_session_id,
            "agentSessionId": record.agent_session_id,
            "workspaceId": record.workspace_id,
            "status": record.status,
        },
    )


__all__ = [
    "SESSION_ENSURE_MAX_BODY_BYTES",
    "SESSION_ENSURE_SCOPE",
    "SESSION_ENSURE_TOOL",
    "router",
]
