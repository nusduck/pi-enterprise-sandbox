"""File API router — read, write, list, preview, download, attachment upload, search."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import APIRouter, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse as FastAPIFileResponse

from sandbox.config import settings
from sandbox.models import (
    AttachmentUploadResponse,
    FileListResponse,
    FileReadRequest,
    FileResponse,
    FileSearchResponse,
    FileWriteRequest,
    FindRequest,
    GrepRequest,
    GrepResponse,
    LsRequest,
)
from sandbox.paths import get_session_physical_workspace, sanitize_path_error
from sandbox.security.ownership import assert_session_owner, resolve_actor
from sandbox.services.attachment_manager import (
    AttachmentError,
    attachment_manager,
    new_attachment_id,
)
from sandbox.services.audit_logger import audit_logger
from sandbox.services.file_manager import file_manager
from sandbox.services.file_search import file_search_service
from sandbox.services.session_manager import session_manager

router = APIRouter(prefix="/sessions/{session_id}/files", tags=["files"])

# Stream uploads in 64 KiB chunks; never hold the full body in memory.
_CHUNK_SIZE = 64 * 1024


def _get_workspace(session_id: str, request: Request | None = None) -> str:
    """Resolve physical workspace; enforce session ownership when auth is on."""
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if settings.auth_enabled and request is not None:
        actor = resolve_actor(request)
        # Owned sessions require an end-user actor (JWT or service+acting).
        if getattr(session, "user_id", None):
            if actor is None:
                raise HTTPException(
                    status_code=401,
                    detail="Authentication required: user JWT or service token with acting headers",
                )
            assert_session_owner(session, actor)
        elif actor is not None:
            assert_session_owner(session, actor)
    return get_session_physical_workspace(session)


def _attachment_http_error(exc: AttachmentError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.as_detail())


@router.get("", response_model=FileListResponse)
def list_files(session_id: str, request: Request, path: str = "."):
    ws = _get_workspace(session_id, request)
    files = file_manager.list_files(ws, path)
    return FileListResponse(files=files, total=len(files))


# ── Structured search tools (ls / find / grep) ─────────────────────────

def _search_http_error(exc: Exception, workspace: str) -> HTTPException:
    msg = sanitize_path_error(str(exc), physical_workspace=workspace)
    if isinstance(exc, PermissionError):
        return HTTPException(status_code=403, detail=msg)
    if isinstance(exc, ValueError):
        return HTTPException(status_code=400, detail=msg)
    return HTTPException(status_code=400, detail=msg)


@router.post("/ls", response_model=FileSearchResponse)
def ls_files(session_id: str, body: LsRequest, request: Request):
    """Bounded directory listing (depth ≤ 5, ≤ 1000 items)."""
    ws = _get_workspace(session_id, request)
    try:
        result = file_search_service.ls(
            ws,
            path=body.path,
            depth=body.depth,
            include_hidden=body.include_hidden,
        )
    except (PermissionError, ValueError) as exc:
        raise _search_http_error(exc, ws) from exc
    audit_logger.log_tool_call(
        session_id=session_id,
        tool_name="ls",
        caller_id="api",
        allowed=True,
        risk_level="low",
        reason="structured ls",
        metadata={
            "path": body.path,
            "depth": body.depth,
            "matched": result.stats.matched,
            "truncated": result.truncated,
            "stop_reason": result.stop_reason,
        },
    )
    return result


@router.post("/find", response_model=FileSearchResponse)
def find_files(session_id: str, body: FindRequest, request: Request):
    """Glob file discovery (default depth 20, ≤ 500 items)."""
    ws = _get_workspace(session_id, request)
    try:
        result = file_search_service.find(
            ws,
            path=body.path,
            pattern=body.pattern,
            type=body.type,
            max_depth=body.max_depth,
            limit=body.limit,
        )
    except (PermissionError, ValueError) as exc:
        raise _search_http_error(exc, ws) from exc
    audit_logger.log_tool_call(
        session_id=session_id,
        tool_name="find",
        caller_id="api",
        allowed=True,
        risk_level="low",
        reason="structured find",
        metadata={
            "path": body.path,
            "pattern": body.pattern,
            "matched": result.stats.matched,
            "truncated": result.truncated,
            "stop_reason": result.stop_reason,
        },
    )
    return result


@router.post("/grep", response_model=GrepResponse)
def grep_files(session_id: str, body: GrepRequest, request: Request):
    """Text search with budgets (≤ 500 matches, 5s, 100MB scan)."""
    ws = _get_workspace(session_id, request)
    try:
        result = file_search_service.grep(
            ws,
            path=body.path,
            query=body.query,
            glob=body.glob,
            regex=body.regex,
            case_sensitive=body.case_sensitive,
            context=body.context,
            limit=body.limit,
        )
    except (PermissionError, ValueError) as exc:
        raise _search_http_error(exc, ws) from exc
    audit_logger.log_tool_call(
        session_id=session_id,
        tool_name="grep",
        caller_id="api",
        allowed=True,
        risk_level="low",
        reason="structured grep",
        metadata={
            "path": body.path,
            "regex": body.regex,
            "matched": result.stats.matched,
            "truncated": result.truncated,
            "stop_reason": result.stop_reason,
        },
    )
    return result


@router.post("/read", response_model=FileResponse)
def read_file(session_id: str, body: FileReadRequest, request: Request):
    ws = _get_workspace(session_id, request)
    return file_manager.read_file(ws, body.path, body.offset, body.limit)


@router.get("/read", response_model=FileResponse)
def read_file_query(
    session_id: str,
    request: Request,
    path: str,
    offset: int | None = None,
    limit: int | None = None,
):
    ws = _get_workspace(session_id, request)
    return file_manager.read_file(ws, path, offset, limit)


@router.post("/write", response_model=FileResponse, status_code=201)
def write_file(session_id: str, body: FileWriteRequest, request: Request):
    ws = _get_workspace(session_id, request)
    try:
        return file_manager.write_file(ws, body.path, body.content, body.mode)
    except ValueError as exc:
        msg = str(exc)
        if "quota" in msg.lower():
            raise HTTPException(
                status_code=413,
                detail={"code": "workspace_quota_exceeded", "message": msg},
            ) from exc
        if "max file size" in msg.lower():
            raise HTTPException(
                status_code=413,
                detail={"code": "attachment_too_large", "message": msg},
            ) from exc
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.get("/preview", response_model=FileResponse)
def preview_file(session_id: str, request: Request, path: str):
    ws = _get_workspace(session_id, request)
    # Preview = first 2000 chars
    return file_manager.read_file(ws, path, offset=1, limit=40)


@router.get("/download")
def download_file(session_id: str, request: Request, path: str):
    ws = _get_workspace(session_id, request)
    try:
        safe = file_manager.get_binary_path(ws, path)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    if not safe.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FastAPIFileResponse(
        path=str(safe),
        filename=safe.name,
        media_type="application/octet-stream",
    )


@router.delete("", status_code=204)
def delete_file(session_id: str, request: Request, path: str):
    ws = _get_workspace(session_id, request)
    try:
        file_manager.delete_file(ws, path)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    return


@router.post("/upload", status_code=201, response_model=AttachmentUploadResponse)
async def upload_file(
    session_id: str,
    request: Request,
    file: UploadFile = File(...),
    path: str = "",
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
):
    """Upload a binary attachment to an isolated workspace path.

    Storage layout: ``uploads/{attachment_id}/{sanitized_name}``.

    - Streams to a temp file (no full-body heap buffer).
    - Same ``Idempotency-Key`` returns the prior attachment (no second file).
    - Extension whitelist enforced; archives are stored as-is (never extracted).
    - Oversize → 413 ``attachment_too_large``; quota → 413 ``workspace_quota_exceeded``.
    """
    ws = _get_workspace(session_id, request)
    filename = file.filename or path or "upload"
    # Prefer basename from multipart; optional path query only supplies name.
    if path and not file.filename:
        filename = Path(path).name or filename

    # Idempotent short-circuit before streaming body again
    if idempotency_key:
        existing = attachment_manager.lookup_idempotency(ws, idempotency_key)
        if existing:
            return AttachmentUploadResponse(
                attachment_id=existing["attachment_id"],
                path=existing["path"],
                name=existing.get("name") or existing.get("sanitized_name") or filename,
                size=int(existing.get("size") or 0),
                mime_type=existing.get("mime_type") or "application/octet-stream",
                idempotency_key=idempotency_key,
            )

    try:
        sanitized = attachment_manager.validate_filename(filename)
    except AttachmentError as exc:
        raise _attachment_http_error(exc) from exc

    attachment_id = new_attachment_id()
    max_bytes = attachment_manager.max_file_bytes()
    final_path = None
    temp_path = None
    handle = None
    total = 0

    try:
        final_path, temp_path, handle = attachment_manager.open_temp_upload(
            ws, attachment_id, sanitized,
        )
        while True:
            chunk = await file.read(_CHUNK_SIZE)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                attachment_manager.abort_temp(temp_path, handle)
                handle = None
                temp_path = None
                raise AttachmentError(
                    "attachment_too_large",
                    f"File exceeds max size of {settings.max_file_size_mb}MB",
                    status=413,
                )
            handle.write(chunk)

        handle.flush()
        try:
            import os
            os.fsync(handle.fileno())
        except OSError:
            pass
        handle.close()
        handle = None

        guessed, _ = mimetypes.guess_type(filename)
        mime = file.content_type or guessed or "application/octet-stream"

        entry = attachment_manager.commit_upload(
            ws,
            attachment_id=attachment_id,
            sanitized_name=sanitized,
            original_name=Path(filename).name,
            final_path=final_path,
            temp_path=temp_path,
            size=total,
            idempotency_key=idempotency_key,
            mime_type=mime,
        )
        temp_path = None  # committed

        return AttachmentUploadResponse(
            attachment_id=entry["attachment_id"],
            path=entry["path"],
            name=entry["name"],
            size=entry["size"],
            mime_type=entry.get("mime_type") or mime,
            idempotency_key=entry.get("idempotency_key"),
        )
    except AttachmentError as exc:
        attachment_manager.abort_temp(temp_path, handle)
        raise _attachment_http_error(exc) from exc
    except PermissionError as exc:
        attachment_manager.abort_temp(temp_path, handle)
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    except Exception:
        attachment_manager.abort_temp(temp_path, handle)
        raise
    finally:
        try:
            await file.close()
        except Exception:
            pass
