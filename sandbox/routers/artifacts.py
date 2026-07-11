"""Artifact API router."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse as FastAPIFileResponse

from sandbox.config import settings
from sandbox.models import ArtifactListResponse, ArtifactRegister, ArtifactResponse
from sandbox.paths import get_session_physical_workspace
from sandbox.security.ownership import assert_session_owner, resolve_actor
from sandbox.security.path_validation import enforce_path_within_workspace
from sandbox.services.artifact_manager import artifact_manager
from sandbox.services.session_manager import session_manager

router = APIRouter(prefix="/sessions/{session_id}/artifacts", tags=["artifacts"])


def _require_session(session_id: str, request: Request | None = None):
    """Load session and enforce ownership when auth is on."""
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if settings.auth_enabled and request is not None:
        actor = resolve_actor(request)
        if getattr(session, "user_id", None):
            if actor is None:
                raise HTTPException(
                    status_code=401,
                    detail="Authentication required: user JWT or service token with acting headers",
                )
            assert_session_owner(session, actor)
        elif actor is not None:
            assert_session_owner(session, actor)
    return session


def _session_workspace(session_id: str, request: Request | None = None) -> Path:
    session = _require_session(session_id, request)
    return Path(get_session_physical_workspace(session))


def _resolve_artifact_file(workspace: Path, user_path: str) -> Path:
    """Resolve *user_path* inside *workspace* and require a regular file."""
    try:
        safe = enforce_path_within_workspace(str(workspace), user_path)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if not safe.is_file():
        raise HTTPException(
            status_code=400,
            detail="Artifact path must be an existing regular file within the workspace",
        )
    return safe


@router.get("", response_model=ArtifactListResponse)
def list_artifacts(session_id: str, request: Request):
    _require_session(session_id, request)
    artifacts = artifact_manager.list_by_session(session_id)
    return ArtifactListResponse(artifacts=artifacts, total=len(artifacts))


@router.post("/register", response_model=ArtifactResponse, status_code=201)
def register_artifact(session_id: str, body: ArtifactRegister, request: Request):
    ws = _session_workspace(session_id, request)
    safe = _resolve_artifact_file(ws, body.path)
    # Persist a workspace-relative path so download revalidates safely.
    rel_path = str(safe.relative_to(ws.resolve()))

    return artifact_manager.register(
        session_id=session_id,
        name=body.name,
        path=rel_path,
        mime_type=body.mime_type,
        source_execution_id=body.source_execution_id,
        size=safe.stat().st_size,
    )


@router.get("/{artifact_id}/download")
def download_artifact(session_id: str, artifact_id: str, request: Request):
    ws = _session_workspace(session_id, request)

    # Session-scoped lookup — rejects artifacts owned by another session.
    artifact = artifact_manager.get_for_session(session_id, artifact_id)
    if artifact is None:
        raise HTTPException(status_code=404, detail="Artifact not found")

    try:
        file_path = enforce_path_within_workspace(str(ws), artifact.path)
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    if not file_path.is_file():
        raise HTTPException(status_code=404, detail="Artifact file not found on disk")

    return FastAPIFileResponse(
        path=str(file_path),
        filename=artifact.name,
        media_type=artifact.mime_type,
    )


@router.post("/submit", response_model=ArtifactResponse, status_code=201)
def submit_artifact(session_id: str, body: ArtifactRegister, request: Request):
    """Explicitly submit a file as an artifact.

    This is the primary endpoint for agent-originated artifact submissions.
    The agent calls this (via submit_artifact tool or bash → HTTP) to
    declare a workspace file as a downloadable artifact.
    No automatic scans happen — only explicitly submitted files are tracked.
    """
    ws = _session_workspace(session_id, request)
    safe = _resolve_artifact_file(ws, body.path)
    rel_path = str(safe.relative_to(ws.resolve()))

    return artifact_manager.register(
        session_id=session_id,
        name=body.name,
        path=rel_path,
        mime_type=body.mime_type,
        source_execution_id=body.source_execution_id,
        size=safe.stat().st_size,
    )
