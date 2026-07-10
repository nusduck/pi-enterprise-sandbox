"""File API router — read, write, list, preview, download files."""

from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import FileResponse as FastAPIFileResponse

from sandbox.models import (
    FileListResponse,
    FileReadRequest,
    FileResponse,
    FileWriteRequest,
)
from sandbox.paths import get_session_physical_workspace
from sandbox.services.file_manager import file_manager
from sandbox.services.session_manager import session_manager

router = APIRouter(prefix="/sessions/{session_id}/files", tags=["files"])


def _get_workspace(session_id: str) -> str:
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return get_session_physical_workspace(session)


@router.get("", response_model=FileListResponse)
def list_files(session_id: str, path: str = "."):
    ws = _get_workspace(session_id)
    files = file_manager.list_files(ws, path)
    return FileListResponse(files=files, total=len(files))


@router.post("/read", response_model=FileResponse)
def read_file(session_id: str, body: FileReadRequest):
    ws = _get_workspace(session_id)
    return file_manager.read_file(ws, body.path, body.offset, body.limit)


@router.get("/read", response_model=FileResponse)
def read_file_query(session_id: str, path: str, offset: int | None = None, limit: int | None = None):
    ws = _get_workspace(session_id)
    return file_manager.read_file(ws, path, offset, limit)


@router.post("/write", response_model=FileResponse, status_code=201)
def write_file(session_id: str, body: FileWriteRequest):
    ws = _get_workspace(session_id)
    try:
        return file_manager.write_file(ws, body.path, body.content, body.mode)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))


@router.get("/preview", response_model=FileResponse)
def preview_file(session_id: str, path: str):
    ws = _get_workspace(session_id)
    # Preview = first 2000 chars
    return file_manager.read_file(ws, path, offset=1, limit=40)


@router.get("/download")
def download_file(session_id: str, path: str):
    ws = _get_workspace(session_id)
    try:
        safe = file_manager.get_binary_path(ws, path)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))

    if not safe.is_file():
        raise HTTPException(status_code=404, detail="File not found")

    return FastAPIFileResponse(
        path=str(safe),
        filename=safe.name,
        media_type="application/octet-stream",
    )


@router.delete("", status_code=204)
def delete_file(session_id: str, path: str):
    ws = _get_workspace(session_id)
    try:
        file_manager.delete_file(ws, path)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    return


@router.post("/upload", status_code=201)
async def upload_file(session_id: str, file: UploadFile = File(...), path: str = ""):
    """Upload a binary file to the workspace.

    Writes exact bytes (no UTF-8 decode). Size is bounded by max_file_size_mb
    while reading in chunks so large uploads fail cleanly.
    """
    from sandbox.config import settings

    ws = _get_workspace(session_id)
    filename = file.filename or "upload"
    # Use provided path or default to filename
    user_path = path or filename

    max_bytes = settings.max_file_size_mb * 1024 * 1024
    chunk_size = 64 * 1024
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(chunk_size)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=400,
                detail=f"Content exceeds max file size of {settings.max_file_size_mb}MB",
            )
        chunks.append(chunk)
    content = b"".join(chunks)

    try:
        result = file_manager.write_binary(ws, user_path, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc))
    return result
