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
            "session_id": session_id,
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
        return ArtifactResponse(
            artifact_id=entry["artifact_id"],
            name=entry["name"],
            path=entry["path"],
            mime_type=entry["mime_type"],
            source_execution_id=entry["source_execution_id"],
            size=entry["size"],
            created_at=entry["created_at"],
        )

    def list_by_session(self, session_id: str) -> list[ArtifactResponse]:
        if self.repository:
            return self.repository.list_by_session(session_id)
        return [
            ArtifactResponse(
                artifact_id=self._artifacts[aid]["artifact_id"],
                name=self._artifacts[aid]["name"],
                path=self._artifacts[aid]["path"],
                mime_type=self._artifacts[aid]["mime_type"],
                source_execution_id=self._artifacts[aid].get("source_execution_id"),
                size=self._artifacts[aid].get("size", 0),
                created_at=self._artifacts[aid].get("created_at", ""),
            )
            for aid in self._session_artifacts.get(session_id, [])
        ]

    def get(self, artifact_id: str) -> ArtifactResponse | None:
        if self.repository:
            return self.repository.get(artifact_id)
        entry = self._artifacts.get(artifact_id)
        if entry is None:
            return None
        return ArtifactResponse(
            artifact_id=entry["artifact_id"],
            name=entry["name"],
            path=entry["path"],
            mime_type=entry["mime_type"],
            source_execution_id=entry.get("source_execution_id"),
            size=entry.get("size", 0),
            created_at=entry.get("created_at", ""),
        )

    def get_for_session(self, session_id: str, artifact_id: str) -> ArtifactResponse | None:
        """Return artifact only when owned by *session_id*."""
        if self.repository:
            return self.repository.get_for_session(session_id, artifact_id)
        entry = self._artifacts.get(artifact_id)
        if entry is None or entry.get("session_id") != session_id:
            return None
        return ArtifactResponse(
            artifact_id=entry["artifact_id"],
            name=entry["name"],
            path=entry["path"],
            mime_type=entry["mime_type"],
            source_execution_id=entry.get("source_execution_id"),
            size=entry.get("size", 0),
            created_at=entry.get("created_at", ""),
        )

    def delete_by_session(self, session_id: str) -> int:
        if self.repository:
            return self.repository.delete_by_session(session_id)
        ids = self._session_artifacts.pop(session_id, [])
        for aid in ids:
            self._artifacts.pop(aid, None)
        return len(ids)


artifact_manager = ArtifactManager(database=default_database)
