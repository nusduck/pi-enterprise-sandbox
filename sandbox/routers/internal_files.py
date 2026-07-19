"""Agent internal plane: files tools (PR-07B).

Auth is HMAC internal
dependency only — legacy API key / JWT middleware is bypassed for
``/internal/v1/*`` but cannot authenticate these routes.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse

from sandbox.security.internal_http_auth import (
    InternalAuthContext,
    require_internal_auth,
)
from sandbox.services.files_read_runtime import get_files_read_runtime
from sandbox.services.files_write_runtime import get_files_write_runtime

logger = logging.getLogger("sandbox.routers.internal_files")

router = APIRouter(tags=["internal-files"])

_INTERNAL_SCOPE = "sandbox.files.read"
_INTERNAL_TOOL = "read"
_DETAIL_UNAVAILABLE = "Service temporarily unavailable"

# files.read body is a small JSON envelope (path + identity + hashes).
# Hard endpoint cap well under the global write-oriented internal body limit.
FILES_READ_MAX_BODY_BYTES = 16 * 1024  # 16 KiB
# A 16 MiB binary write expands to ~21.4 MiB as base64 inside JSON. Edit
# permits two independently bounded 16 MiB UTF-8 strings. Endpoint caps cover
# those valid contracts plus a small identity envelope while remaining below
# the global internal-plane cap.
FILES_WRITE_MAX_BODY_BYTES = 24 * 1024 * 1024
FILES_EDIT_MAX_BODY_BYTES = 34 * 1024 * 1024

_auth_dep = require_internal_auth(
    expected_scope=_INTERNAL_SCOPE,
    expected_tool_name=_INTERNAL_TOOL,
    max_body_bytes=FILES_READ_MAX_BODY_BYTES,
)

_write_auth_dep = require_internal_auth(
    expected_scope="sandbox.files.write",
    expected_tool_name="write",
    max_body_bytes=FILES_WRITE_MAX_BODY_BYTES,
)
_edit_auth_dep = require_internal_auth(
    expected_scope="sandbox.files.edit",
    expected_tool_name="edit",
    max_body_bytes=FILES_EDIT_MAX_BODY_BYTES,
)


@router.post("/internal/v1/files/read")
async def internal_files_read(
    request: Request,
    ctx: InternalAuthContext = Depends(_auth_dep),
) -> JSONResponse:
    """Strict claim/read/finalize orchestration for the read tool.

    Re-reads the Starlette-cached exact raw body after auth (no re-stream
    of a different buffer). Runtime missing → 503 fail closed.
    """
    runtime = get_files_read_runtime(request.app)
    if runtime is None:
        logger.warning("files.read runtime unconfigured")
        raise HTTPException(status_code=503, detail=_DETAIL_UNAVAILABLE)

    # Must be the same bytes the auth dependency hashed (cached on Request).
    raw_body = await request.body()
    if type(raw_body) is not bytes:  # noqa: E721
        raise HTTPException(status_code=400, detail="Invalid request")

    return await runtime.handle(claims=ctx.claims, raw_body=raw_body)


async def _internal_files_write_or_edit(request: Request, ctx: InternalAuthContext, *, tool: str) -> JSONResponse:
    runtime = get_files_write_runtime(request.app)
    if runtime is None:
        raise HTTPException(status_code=503, detail=_DETAIL_UNAVAILABLE)
    raw_body = await request.body()
    if type(raw_body) is not bytes:  # noqa: E721
        raise HTTPException(status_code=400, detail="Invalid request")
    return await runtime.handle(tool=tool, claims=ctx.claims, raw_body=raw_body)


@router.post("/internal/v1/files/write")
async def internal_files_write(request: Request, ctx: InternalAuthContext = Depends(_write_auth_dep)) -> JSONResponse:
    return await _internal_files_write_or_edit(request, ctx, tool="write")


@router.post("/internal/v1/files/edit")
async def internal_files_edit(request: Request, ctx: InternalAuthContext = Depends(_edit_auth_dep)) -> JSONResponse:
    return await _internal_files_write_or_edit(request, ctx, tool="edit")


__all__ = [
    "FILES_EDIT_MAX_BODY_BYTES",
    "FILES_READ_MAX_BODY_BYTES",
    "FILES_WRITE_MAX_BODY_BYTES",
    "router",
]
