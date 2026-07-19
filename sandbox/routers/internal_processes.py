"""Agent internal HMAC plane for managed process tools."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from sandbox.security.internal_http_auth import InternalAuthContext, require_internal_auth
from sandbox.services.formal_process_runtime import get_formal_process_runtime

router = APIRouter(tags=["internal-processes"])
PROCESS_MAX_BODY_BYTES = 64 * 1024


def _auth(tool_name: str):
    return require_internal_auth(expected_scope=f"sandbox.processes.{tool_name}", expected_tool_name=tool_name, max_body_bytes=PROCESS_MAX_BODY_BYTES)


async def _handle(request: Request, ctx: InternalAuthContext, *, tool_name: str) -> JSONResponse:
    runtime = get_formal_process_runtime(request.app)
    if runtime is None:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")
    return await runtime.handle(claims=ctx.claims, raw_body=await request.body(), tool_name=tool_name)


@router.post("/internal/v1/processes/start")
async def internal_process_start(request: Request, ctx: InternalAuthContext = Depends(_auth("process_start"))) -> JSONResponse:
    return await _handle(request, ctx, tool_name="process_start")


@router.post("/internal/v1/processes/status")
async def internal_process_status(request: Request, ctx: InternalAuthContext = Depends(_auth("process_status"))) -> JSONResponse:
    return await _handle(request, ctx, tool_name="process_status")


@router.post("/internal/v1/processes/read")
async def internal_process_read(request: Request, ctx: InternalAuthContext = Depends(_auth("process_read"))) -> JSONResponse:
    return await _handle(request, ctx, tool_name="process_read")


@router.post("/internal/v1/processes/kill")
async def internal_process_kill(request: Request, ctx: InternalAuthContext = Depends(_auth("process_kill"))) -> JSONResponse:
    return await _handle(request, ctx, tool_name="process_kill")


__all__ = ["PROCESS_MAX_BODY_BYTES", "router"]
