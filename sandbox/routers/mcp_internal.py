"""Private direct-operation bridge for the independently deployed MCP facade."""

from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from sandbox.config import settings
from sandbox.mcp.runtime import ControlPlaneError, mcp_sandbox_runtime
from sandbox.security.mcp_internal_auth import require_mcp_internal_auth

router = APIRouter(prefix="/internal/mcp/v1", tags=["mcp-internal"])


class _RequestModel(BaseModel):
    # Do not strip globally: Python source and file content are byte-significant.
    model_config = ConfigDict(extra="forbid")


class ContextRequest(_RequestModel):
    sandbox_session_id: str = Field(min_length=26, max_length=26)
    workspace_id: str = Field(min_length=26, max_length=26)


class PythonRequest(ContextRequest):
    code: str = Field(min_length=1)
    timeout_seconds: int = Field(default=120, ge=1)


class FileWriteRequest(ContextRequest):
    path: str = Field(min_length=1, max_length=4096)
    content: str
    mode: Literal["overwrite", "append"] = "overwrite"


class FileReadRequest(ContextRequest):
    path: str = Field(min_length=1, max_length=4096)
    offset: int | None = Field(default=None, ge=1)
    limit: int | None = Field(default=None, ge=1, le=10_000)


class FileListRequest(ContextRequest):
    path: str = Field(default=".", min_length=1, max_length=4096)
    depth: int = Field(default=1, ge=0, le=5)


class ArtifactSubmitRequest(ContextRequest):
    artifact_id: str = Field(min_length=26, max_length=26)
    source_path: str = Field(min_length=1, max_length=4096)


def _translate_error(exc: Exception) -> HTTPException:
    if isinstance(exc, HTTPException):
        return exc
    if isinstance(exc, ControlPlaneError):
        return HTTPException(
            status_code=exc.status,
            detail={"code": exc.code, "message": exc.message},
        )
    if isinstance(exc, (ValueError, PermissionError)):
        return HTTPException(status_code=400, detail="Invalid request")
    return HTTPException(status_code=500, detail="Sandbox operation failed")


async def _parse_payload(
    request: Request,
    model_type: type[_RequestModel],
    *,
    max_bytes: int,
) -> _RequestModel:
    """Read exactly one bounded JSON body before Pydantic touches it.

    FastAPI's normal body model parsing buffers an entire request first.  These
    private routes accept caller-sized text/code, so enforce the cap while
    streaming rather than trusting Content-Length (which may be missing/false).
    """
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > max_bytes:
                raise HTTPException(status_code=413, detail="Request body too large")
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid request") from None
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail="Request body too large")
        chunks.append(chunk)
    try:
        return model_type.model_validate_json(b"".join(chunks))
    except ValidationError as exc:
        raise HTTPException(status_code=400, detail="Invalid request") from exc


def _json_size_limit(value_limit: int) -> int:
    """JSON escaping can expand a UTF-8 string up to six-fold."""
    return min(
        int(settings.internal_max_request_body_bytes),
        max(64 * 1024, value_limit * 6 + 64 * 1024),
    )


@router.post("/context/ensure", dependencies=[Depends(require_mcp_internal_auth)])
async def ensure_context(request: Request) -> JSONResponse:
    try:
        payload = await _parse_payload(request, ContextRequest, max_bytes=64 * 1024)
        return JSONResponse(mcp_sandbox_runtime.ensure_context(**payload.model_dump()))
    except Exception as exc:
        raise _translate_error(exc) from exc


@router.post("/python/execute", dependencies=[Depends(require_mcp_internal_auth)])
async def execute_python(request: Request) -> JSONResponse:
    try:
        payload = await _parse_payload(
            request, PythonRequest, max_bytes=_json_size_limit(settings.mcp_max_code_length)
        )
        return JSONResponse(mcp_sandbox_runtime.execute_python(**payload.model_dump()))
    except Exception as exc:
        raise _translate_error(exc) from exc


@router.post("/files/write", dependencies=[Depends(require_mcp_internal_auth)])
async def write_file(request: Request) -> JSONResponse:
    try:
        payload = await _parse_payload(
            request, FileWriteRequest, max_bytes=_json_size_limit(settings.mcp_max_file_size_bytes)
        )
        data = payload.model_dump()
        data["append"] = data.pop("mode") == "append"
        return JSONResponse(mcp_sandbox_runtime.write_file(**data))
    except Exception as exc:
        raise _translate_error(exc) from exc


@router.post("/files/read", dependencies=[Depends(require_mcp_internal_auth)])
async def read_file(request: Request) -> JSONResponse:
    try:
        payload = await _parse_payload(request, FileReadRequest, max_bytes=64 * 1024)
        return JSONResponse(mcp_sandbox_runtime.read_file(**payload.model_dump()))
    except Exception as exc:
        raise _translate_error(exc) from exc


@router.post("/files/list", dependencies=[Depends(require_mcp_internal_auth)])
async def list_files(request: Request) -> JSONResponse:
    try:
        payload = await _parse_payload(request, FileListRequest, max_bytes=64 * 1024)
        return JSONResponse(mcp_sandbox_runtime.list_files(**payload.model_dump()))
    except Exception as exc:
        raise _translate_error(exc) from exc


@router.post("/artifacts/submit", dependencies=[Depends(require_mcp_internal_auth)])
async def submit_artifact(request: Request) -> JSONResponse:
    try:
        payload = await _parse_payload(request, ArtifactSubmitRequest, max_bytes=64 * 1024)
        return JSONResponse(mcp_sandbox_runtime.submit_artifact(**payload.model_dump()))
    except Exception as exc:
        raise _translate_error(exc) from exc


@router.get("/artifacts/{artifact_id}/content", dependencies=[Depends(require_mcp_internal_auth)])
def artifact_content(artifact_id: str) -> StreamingResponse:
    try:
        mcp_sandbox_runtime.ensure_artifact_exists(artifact_id)
        return StreamingResponse(
            mcp_sandbox_runtime.artifact_chunks(artifact_id),
            media_type="application/octet-stream",
        )
    except Exception as exc:
        raise _translate_error(exc) from exc


__all__ = ["router"]
