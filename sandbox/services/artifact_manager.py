"""Artifact Manager — register and retrieve execution artifacts."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sandbox.database import Database, database as default_database
from sandbox.models import ArtifactResponse
from sandbox.repositories import ArtifactRepository


class ArtifactManager:
    """Tracks output artifacts generated during executions."""

    def __init__(self, database: Database | None = None) -> None:
        self.repository = ArtifactRepository(database) if database is not None else None
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
        entry = {
            "artifact_id": f"art_{uuid.uuid4().hex[:10]}",
            "name": name,
            "path": path,
            "mime_type": mime_type,
            "source_execution_id": source_execution_id,
            "size": size,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        if self.repository:
            self.repository.upsert(session_id, entry)
        else:
            self._artifacts[entry["artifact_id"]] = entry
            self._session_artifacts.setdefault(session_id, []).append(entry["artifact_id"])
        return ArtifactResponse(**entry)

    def list_by_session(self, session_id: str) -> list[ArtifactResponse]:
        if self.repository:
            return self.repository.list_by_session(session_id)
        return [ArtifactResponse(**self._artifacts[aid]) for aid in self._session_artifacts.get(session_id, [])]

    def get(self, artifact_id: str) -> ArtifactResponse | None:
        if self.repository:
            return self.repository.get(artifact_id)
        entry = self._artifacts.get(artifact_id)
        return ArtifactResponse(**entry) if entry else None

    def delete_by_session(self, session_id: str) -> int:
        if self.repository:
            return self.repository.delete_by_session(session_id)
        ids = self._session_artifacts.pop(session_id, [])
        for aid in ids:
            self._artifacts.pop(aid, None)
        return len(ids)


artifact_manager = ArtifactManager(database=default_database)
