"""File API router — read, write, list, preview, download, attachment upload, search."""

from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import APIRouter, File, Header, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse as FastAPIFileResponse

from sandbox.config import settings
from sandbox.models import (
    AttachmentUploadResponse,
    FileApplyPatchRequest,
    FileEditRequest,
    FileEditResponse,
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
from sandbox.paths import sanitize_path_error
from sandbox.security.ownership import require_owned_session
from sandbox.services.attachment_manager import (
    AttachmentError,
    attachment_manager,
    new_attachment_id,
)
from sandbox.services.audit_logger import audit_logger
from sandbox.services.file_edit import file_edit_service
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.file_manager import file_manager
from sandbox.services.file_search import file_search_service

router = APIRouter(prefix="/sessions/{session_id}/files", tags=["files"])

# Stream uploads in 64 KiB chunks; never hold the full body in memory.
_CHUNK_SIZE = 64 * 1024


def _audit_scope(request: Request) -> dict[str, str]:
    """Return the authenticated actor scope for formal audit writes."""
    from sandbox.security.ownership import resolve_actor

    actor = resolve_actor(request)
    if actor is None:
        return {}
    return {
        "org_id": actor.organization_id,
        "user_id": actor.user_id,
    }


def _get_context(
    session_id: str, request: Request | None = None
) -> SandboxExecutionContext:
    """Resolve trusted workspace/temp roots and enforce session ownership."""
    session = require_owned_session(session_id, request)
    return SandboxExecutionContext.from_session(session)


def _get_workspace(session_id: str, request: Request | None = None) -> str:
    """Compatibility helper for workspace-only attachment operations."""
    return str(_get_context(session_id, request).physical_workspace)


def _attachment_http_error(exc: AttachmentError) -> HTTPException:
    return HTTPException(status_code=exc.status, detail=exc.as_detail())


@router.get("", response_model=FileListResponse)
def list_files(session_id: str, request: Request, path: str = "."):
    context = _get_context(session_id, request)
    files = file_manager.list_files(
        str(context.physical_workspace),
        path,
        temp_path=str(context.physical_temp),
    )
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
    context = _get_context(session_id, request)
    ws = str(context.physical_workspace)
    try:
        result = file_search_service.ls(
            ws,
            path=body.path,
            depth=body.depth,
            include_hidden=body.include_hidden,
            temp_path=str(context.physical_temp),
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
        **_audit_scope(request),
    )
    return result


@router.post("/find", response_model=FileSearchResponse)
def find_files(session_id: str, body: FindRequest, request: Request):
    """Glob file discovery (default depth 20, ≤ 500 items)."""
    context = _get_context(session_id, request)
    ws = str(context.physical_workspace)
    try:
        result = file_search_service.find(
            ws,
            path=body.path,
            pattern=body.pattern,
            type=body.type,
            max_depth=body.max_depth,
            limit=body.limit,
            temp_path=str(context.physical_temp),
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
        **_audit_scope(request),
    )
    return result


@router.post("/grep", response_model=GrepResponse)
def grep_files(session_id: str, body: GrepRequest, request: Request):
    """Text search with budgets (≤ 500 matches, 5s, 100MB scan)."""
    context = _get_context(session_id, request)
    ws = str(context.physical_workspace)
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
            temp_path=str(context.physical_temp),
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
        **_audit_scope(request),
    )
    return result


@router.post("/read", response_model=FileResponse)
def read_file(session_id: str, body: FileReadRequest, request: Request):
    context = _get_context(session_id, request)
    return file_manager.read_file(
        str(context.physical_workspace),
        body.path,
        body.offset,
        body.limit,
        temp_path=str(context.physical_temp),
    )


@router.get("/read", response_model=FileResponse)
def read_file_query(
    session_id: str,
    request: Request,
    path: str,
    offset: int | None = None,
    limit: int | None = None,
):
    context = _get_context(session_id, request)
    return file_manager.read_file(
        str(context.physical_workspace),
        path,
        offset,
        limit,
        temp_path=str(context.physical_temp),
    )


@router.post("/write", response_model=FileResponse, status_code=201)
def write_file(session_id: str, body: FileWriteRequest, request: Request):
    context = _get_context(session_id, request)
    try:
        return file_manager.write_file(
            str(context.physical_workspace),
            body.path,
            body.content,
            body.mode,
            temp_path=str(context.physical_temp),
        )
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


@router.post("/edit", response_model=FileEditResponse)
def edit_file(session_id: str, body: FileEditRequest, request: Request):
    """Unique old_string replacement with unified diff + hashes (ADR §9)."""
    context = _get_context(session_id, request)
    try:
        result = file_edit_service.edit(
            str(context.physical_workspace),
            body.path,
            body.old_string,
            body.new_string,
            expected_hash=body.expected_hash,
            temp_path=str(context.physical_temp),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    audit_logger.log_tool_call(
        session_id=session_id,
        tool_name="edit",
        caller_id="api",
        allowed=result.ok,
        risk_level="medium",
        reason=result.error or "unique edit",
        metadata={
            "path": body.path,
            "ok": result.ok,
            "match_count": result.match_count,
            "match_lines": result.match_lines,
            "before_hash": result.before_hash,
            "after_hash": result.after_hash,
            "changed_lines": result.changed_lines,
        },
        **_audit_scope(request),
    )
    return result


@router.post("/apply_patch", response_model=FileEditResponse)
def apply_patch_file(session_id: str, body: FileApplyPatchRequest, request: Request):
    """Apply unified diff patch with before/after hashes (ADR §9)."""
    context = _get_context(session_id, request)
    try:
        result = file_edit_service.apply_patch(
            str(context.physical_workspace),
            body.path,
            body.patch,
            expected_hash=body.expected_hash,
            temp_path=str(context.physical_temp),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    audit_logger.log_tool_call(
        session_id=session_id,
        tool_name="apply_patch",
        caller_id="api",
        allowed=result.ok,
        risk_level="medium",
        reason=result.error or "apply_patch",
        metadata={
            "path": body.path,
            "ok": result.ok,
            "before_hash": result.before_hash,
            "after_hash": result.after_hash,
            "changed_lines": result.changed_lines,
        },
        **_audit_scope(request),
    )
    return result


@router.get("/preview", response_model=FileResponse)
def preview_file(session_id: str, request: Request, path: str):
    context = _get_context(session_id, request)
    # Preview = first 2000 chars
    return file_manager.read_file(
        str(context.physical_workspace),
        path,
        offset=1,
        limit=40,
        temp_path=str(context.physical_temp),
    )


@router.get("/download")
def download_file(session_id: str, request: Request, path: str):
    context = _get_context(session_id, request)
    try:
        safe = file_manager.get_binary_path(
            str(context.physical_workspace),
            path,
            temp_path=str(context.physical_temp),
        )
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
    context = _get_context(session_id, request)
    try:
        file_manager.delete_file(
            str(context.physical_workspace),
            path,
            temp_path=str(context.physical_temp),
        )
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
                upload_time=existing.get("upload_time"),
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
            upload_time=entry.get("upload_time"),
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
