"""Agent internal HMAC plane for synchronous bash and Python tools."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from sandbox.security.internal_http_auth import InternalAuthContext, require_internal_auth
from sandbox.services.formal_execution_runtime import get_formal_execution_runtime

router = APIRouter(tags=["internal-executions"])

EXECUTION_MAX_BODY_BYTES = 384 * 1024


def _auth(tool_name: str):
    return require_internal_auth(
        expected_scope=f"sandbox.executions.{tool_name}",
        expected_tool_name=tool_name,
        max_body_bytes=EXECUTION_MAX_BODY_BYTES,
    )


async def _handle(
    request: Request, ctx: InternalAuthContext, *, tool_name: str
) -> JSONResponse:
    runtime = get_formal_execution_runtime(request.app)
    if runtime is None:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")
    return await runtime.handle(
        claims=ctx.claims,
        raw_body=await request.body(),
        tool_name=tool_name,
    )


@router.post("/internal/v1/executions/bash")
async def internal_bash(
    request: Request,
    ctx: InternalAuthContext = Depends(_auth("bash")),
) -> JSONResponse:
    return await _handle(request, ctx, tool_name="bash")


@router.post("/internal/v1/executions/python")
async def internal_python(
    request: Request,
    ctx: InternalAuthContext = Depends(_auth("python")),
) -> JSONResponse:
    return await _handle(request, ctx, tool_name="python")


__all__ = ["EXECUTION_MAX_BODY_BYTES", "router"]
