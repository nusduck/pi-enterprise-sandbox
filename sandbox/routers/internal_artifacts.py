"""Agent internal HMAC routes for artifact submission and byte delivery."""

from __future__ import annotations

import asyncio
import re
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

from sandbox.app.domain.internal_artifact_download_contract import (
    ARTIFACT_DOWNLOAD_SCOPE,
    ARTIFACT_DOWNLOAD_TOOL,
    InternalArtifactDownloadContractError,
    parse_and_bind_internal_artifact_download,
)
from sandbox.security.internal_http_auth import InternalAuthContext, require_internal_auth
from sandbox.services.artifact_manager import (
    ArtifactError,
    artifact_manager,
    iter_snapshot_chunks,
    safe_content_disposition_filename,
)
from sandbox.services.formal_artifact_runtime import get_formal_artifact_runtime

router = APIRouter(tags=["internal-artifacts"])
ARTIFACT_SUBMIT_MAX_BODY_BYTES = 16 * 1024
ARTIFACT_DOWNLOAD_MAX_BODY_BYTES = 4 * 1024
_submit_auth = require_internal_auth(
    expected_scope="sandbox.artifacts.submit",
    expected_tool_name="submit_artifact",
    max_body_bytes=ARTIFACT_SUBMIT_MAX_BODY_BYTES,
)
_download_auth = require_internal_auth(
    expected_scope=ARTIFACT_DOWNLOAD_SCOPE,
    expected_tool_name=ARTIFACT_DOWNLOAD_TOOL,
    max_body_bytes=ARTIFACT_DOWNLOAD_MAX_BODY_BYTES,
)
_SAFE_MEDIA_TYPE_RE = re.compile(r"^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$")


@router.post("/internal/v1/artifacts/submit")
async def internal_artifact_submit(
    request: Request,
    ctx: InternalAuthContext = Depends(_submit_auth),
) -> JSONResponse:
    runtime = get_formal_artifact_runtime(request.app)
    if runtime is None:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")
    return await runtime.handle(claims=ctx.claims, raw_body=await request.body())


@router.post("/internal/v1/artifacts/download")
async def internal_artifact_download(
    request: Request,
    ctx: InternalAuthContext = Depends(_download_auth),
) -> StreamingResponse:
    """Stream an immutable artifact snapshot under signed owner bindings."""
    try:
        command = parse_and_bind_internal_artifact_download(
            await request.body(),
            ctx.claims,
        )
    except InternalArtifactDownloadContractError:
        raise HTTPException(status_code=400, detail="Invalid request") from None

    try:
        artifact, snapshot_path, identity = await asyncio.to_thread(
            artifact_manager.resolve_download,
            session_id=command.sandbox_session_id,
            artifact_id=command.artifact_id,
            org_id=command.org_id,
            user_id=command.user_id,
            agent_session_id=command.agent_session_id,
            conversation_id=command.conversation_id,
            run_id=command.run_id,
        )
    except ArtifactError as exc:
        status = exc.status if exc.status in {404, 409, 503} else 503
        detail = {
            404: "Not found",
            409: "Conflict",
            503: "Service temporarily unavailable",
        }[status]
        raise HTTPException(status_code=status, detail=detail) from None

    filename = safe_content_disposition_filename(artifact.name)
    disposition = (
        f'attachment; filename="{filename}"; '
        f"filename*=UTF-8''{quote(filename, safe='')}"
    )
    media_type = str(artifact.mime_type or "application/octet-stream").strip()
    if (
        _SAFE_MEDIA_TYPE_RE.fullmatch(media_type) is None
        or media_type.lower()
        in {"text/html", "application/xhtml+xml", "image/svg+xml"}
    ):
        media_type = "application/octet-stream"

    async def _stream():
        iterator = iter_snapshot_chunks(snapshot_path, expected=identity)

        def _next_chunk():
            try:
                return next(iterator)
            except StopIteration:
                return None

        try:
            while True:
                chunk = await asyncio.to_thread(_next_chunk)
                if chunk is None:
                    break
                yield chunk
        finally:
            close = getattr(iterator, "close", None)
            if callable(close):
                await asyncio.to_thread(close)

    headers = {
        "Content-Disposition": disposition,
        "Content-Length": str(identity.st_size),
        "X-Artifact-Id": artifact.artifact_id,
        "X-Artifact-Sha256": artifact.sha256 or "",
        "X-Content-Type-Options": "nosniff",
    }
    return StreamingResponse(_stream(), media_type=media_type, headers=headers)


__all__ = [
    "ARTIFACT_DOWNLOAD_MAX_BODY_BYTES",
    "ARTIFACT_SUBMIT_MAX_BODY_BYTES",
    "router",
]
