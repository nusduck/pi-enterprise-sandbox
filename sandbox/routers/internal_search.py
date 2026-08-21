"""Agent internal HMAC plane for read-only workspace search tools."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from sandbox.security.internal_http_auth import (
    InternalAuthContext,
    require_internal_auth,
)
from sandbox.services.formal_search_runtime import get_formal_search_runtime

router = APIRouter(tags=["internal-search"])

# Search bodies are a small JSON envelope: identity + a bounded path/pattern.
# Well under the global internal-plane cap, which is sized for binary writes.
SEARCH_MAX_BODY_BYTES = 16 * 1024


def _auth(tool_name: str):
    return require_internal_auth(
        expected_scope=f"sandbox.files.{tool_name}",
        expected_tool_name=tool_name,
        max_body_bytes=SEARCH_MAX_BODY_BYTES,
    )


async def _handle(
    request: Request, ctx: InternalAuthContext, *, tool_name: str
) -> JSONResponse:
    runtime = get_formal_search_runtime(request.app)
    if runtime is None:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")
    return await runtime.handle(
        claims=ctx.claims, raw_body=await request.body(), tool_name=tool_name
    )


@router.post("/internal/v1/files/ls")
async def internal_files_ls(
    request: Request, ctx: InternalAuthContext = Depends(_auth("ls"))
) -> JSONResponse:
    return await _handle(request, ctx, tool_name="ls")


@router.post("/internal/v1/files/find")
async def internal_files_find(
    request: Request, ctx: InternalAuthContext = Depends(_auth("find"))
) -> JSONResponse:
    return await _handle(request, ctx, tool_name="find")


@router.post("/internal/v1/files/grep")
async def internal_files_grep(
    request: Request, ctx: InternalAuthContext = Depends(_auth("grep"))
) -> JSONResponse:
    return await _handle(request, ctx, tool_name="grep")


__all__ = ["SEARCH_MAX_BODY_BYTES", "router"]
