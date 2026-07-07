"""Artifact API router."""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse as FastAPIFileResponse

from sandbox.models import ArtifactListResponse, ArtifactRegister, ArtifactResponse
from sandbox.services.artifact_manager import artifact_manager
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(prefix="/sessions/{session_id}/artifacts", tags=["artifacts"])


@router.get("", response_model=ArtifactListResponse)
def list_artifacts(session_id: str):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    artifacts = artifact_manager.list_by_session(session_id)
    return ArtifactListResponse(artifacts=artifacts, total=len(artifacts))


@router.post("/register", response_model=ArtifactResponse, status_code=201)
def register_artifact(session_id: str, body: ArtifactRegister):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    physical = session.metadata.get("_physical_workspace")
    ws_path = physical or str(workspace_manager.get_workspace_path(session_id))
    ws = Path(ws_path)
    artifact_path = ws / body.path

    size = artifact_path.stat().st_size if artifact_path.exists() else 0

    return artifact_manager.register(
        session_id=session_id,
        name=body.name,
        path=body.path,
        mime_type=body.mime_type,
        source_execution_id=body.source_execution_id,
        size=size,
    )


@router.get("/{artifact_id}/download")
def download_artifact(session_id: str, artifact_id: str):
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    artifact = artifact_manager.get(artifact_id)
    if artifact is None:
        raise HTTPException(status_code=404, detail="Artifact not found")

    physical = session.metadata.get("_physical_workspace")
    ws_path = physical or str(workspace_manager.get_workspace_path(session_id))
    ws = Path(ws_path)
    file_path = ws / artifact.path

    if not file_path.is_file():
        # Check relative to workspace root
        alt = ws / artifact.path
        if alt.is_file():
            file_path = alt
        else:
            raise HTTPException(status_code=404, detail="Artifact file not found on disk")

    return FastAPIFileResponse(
        path=str(file_path),
        filename=artifact.name,
        media_type=artifact.mime_type,
    )


@router.post("/submit", response_model=ArtifactResponse, status_code=201)
def submit_artifact(session_id: str, body: ArtifactRegister):
    """Explicitly submit a file as an artifact.

    This is the primary endpoint for agent-originated artifact submissions.
    The agent calls this (via submit_artifact tool or bash → HTTP) to
    declare a workspace file as a downloadable artifact.
    No automatic scans happen — only explicitly submitted files are tracked.
    """
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")

    physical = session.metadata.get("_physical_workspace")
    ws_path = physical or str(workspace_manager.get_workspace_path(session_id))
    ws = Path(ws_path)
    artifact_path = ws / body.path

    size = artifact_path.stat().st_size if artifact_path.exists() else 0

    return artifact_manager.register(
        session_id=session_id,
        name=body.name,
        path=body.path,
        mime_type=body.mime_type,
        source_execution_id=body.source_execution_id,
        size=size,
    )
