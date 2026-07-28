"""Public contracts owned by the Artifact domain."""

from __future__ import annotations

from pydantic import BaseModel, Field, field_validator

from sandbox.models import ArtifactListResponse, ArtifactRegister, ArtifactResponse


class ArtifactImportRequest(BaseModel):
    """Import an existing immutable Artifact as a target-workspace input."""

    artifact_id: str = Field(..., min_length=1, max_length=128)
    target_filename: str | None = Field(default=None, min_length=1, max_length=256)

    @field_validator("artifact_id")
    @classmethod
    def _artifact_id_nonblank(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("artifact_id must not be blank")
        return normalized

    @field_validator("target_filename")
    @classmethod
    def _target_filename_nonblank(cls, value: str | None) -> str | None:
        if value is None:
            return None
        normalized = value.strip()
        if not normalized:
            raise ValueError("target_filename must not be blank")
        return normalized


class ArtifactWorkspaceFile(BaseModel):
    """Workspace input created by an Artifact import."""

    name: str
    path: str
    mime_type: str = "application/octet-stream"
    size: int = 0
    sha256: str | None = None


class ArtifactImportResponse(BaseModel):
    """Result of copying Artifact bytes into a target session workspace."""

    import_id: str
    artifact_id: str
    target_session_id: str
    target_conversation_id: str | None = None
    workspace_file: ArtifactWorkspaceFile


__all__ = [
    "ArtifactImportRequest",
    "ArtifactImportResponse",
    "ArtifactListResponse",
    "ArtifactRegister",
    "ArtifactResponse",
    "ArtifactWorkspaceFile",
]
