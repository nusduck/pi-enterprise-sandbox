"""Agent internal plane: files tools (PR-07B).

Only ``POST /internal/v1/files/read`` in this batch. Auth is HMAC internal
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

logger = logging.getLogger("sandbox.routers.internal_files")

router = APIRouter(tags=["internal-files"])

_INTERNAL_SCOPE = "sandbox.files.read"
_INTERNAL_TOOL = "read"
_DETAIL_UNAVAILABLE = "Service temporarily unavailable"

# files.read body is a small JSON envelope (path + identity + hashes).
# Hard endpoint cap well under the global write-oriented internal body limit.
FILES_READ_MAX_BODY_BYTES = 16 * 1024  # 16 KiB

_auth_dep = require_internal_auth(
    expected_scope=_INTERNAL_SCOPE,
    expected_tool_name=_INTERNAL_TOOL,
    max_body_bytes=FILES_READ_MAX_BODY_BYTES,
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


__all__ = ["FILES_READ_MAX_BODY_BYTES", "router"]
