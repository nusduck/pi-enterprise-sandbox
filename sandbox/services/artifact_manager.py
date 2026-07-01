"""Artifact Manager — register and retrieve execution artifacts."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path

from sandbox.models import ArtifactResponse


class ArtifactManager:
    """Tracks output artifacts generated during executions."""

    def __init__(self) -> None:
        self._artifacts: dict[str, dict] = {}
        self._session_artifacts: dict[str, list[str]] = {}

    def register(
        self,
        session_id: str,
        name: str,
        path: str,
        mime_type: str = "application/octet-stream",
        source_execution_id: str | None = None,
        size: int = 0,
    ) -> ArtifactResponse:
        artifact_id = f"art_{uuid.uuid4().hex[:10]}"
        now = datetime.now(timezone.utc).isoformat()

        entry = {
            "artifact_id": artifact_id,
            "name": name,
            "path": path,
            "mime_type": mime_type,
            "source_execution_id": source_execution_id,
            "size": size,
            "created_at": now,
        }
        self._artifacts[artifact_id] = entry
        self._session_artifacts.setdefault(session_id, []).append(artifact_id)

        return ArtifactResponse(**entry)

    def list_by_session(self, session_id: str) -> list[ArtifactResponse]:
        ids = self._session_artifacts.get(session_id, [])
        return [ArtifactResponse(**self._artifacts[aid]) for aid in ids]

    def get(self, artifact_id: str) -> ArtifactResponse | None:
        entry = self._artifacts.get(artifact_id)
        if entry is None:
            return None
        return ArtifactResponse(**entry)

    def delete_by_session(self, session_id: str) -> int:
        """Remove all artifacts for a session. Returns count removed."""
        ids = self._session_artifacts.pop(session_id, [])
        for aid in ids:
            self._artifacts.pop(aid, None)
        return len(ids)


artifact_manager = ArtifactManager()
