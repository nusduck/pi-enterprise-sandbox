"""Single application boundary for Artifact operations."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sandbox.app.domain.ulid import new_ulid
from sandbox.artifact.domain.contracts import (
    ArtifactImportResponse,
    ArtifactWorkspaceFile,
)
from sandbox.artifact.infrastructure.manager import (
    ArtifactError,
    ArtifactManager,
    artifact_manager,
)
from sandbox.config import settings
from sandbox.services.attachment_manager import sanitize_filename
from sandbox.services.audit_logger import AuditPersistenceError, audit_logger
from sandbox.services.control_plane_storage import (
    ControlPlaneError,
    secure_publish_to_workspace,
    unlink_workspace_leaf_if_matches,
)
from sandbox.services.file_manager import workspace_size_bytes


class ArtifactFacade:
    """Stable boundary for submit, list, download, and workspace import."""

    def __init__(self, manager: ArtifactManager = artifact_manager) -> None:
        self.manager = manager

    def submit(self, **kwargs: Any):
        return self.manager.submit(**kwargs)

    def list(self, session_id: str, **kwargs: Any):
        return self.manager.list_by_session(session_id, **kwargs)

    def resolve_download(self, **kwargs: Any):
        return self.manager.resolve_download(**kwargs)

    def import_to_workspace(
        self,
        *,
        artifact_id: str,
        target_session_id: str,
        physical_workspace: Path,
        org_id: str,
        user_id: str,
        target_filename: str | None = None,
        target_conversation_id: str | None = None,
        target_agent_session_id: str | None = None,
    ) -> ArtifactImportResponse:
        """Copy an owner-scoped immutable Artifact into a target workspace.

        Import creates a workspace input only. It deliberately does not create
        Artifact metadata, emit ``artifact.ready``, or reuse the source
        ``artifact_id`` as a target-conversation deliverable.
        """
        org = str(org_id or "").strip()
        user = str(user_id or "").strip()
        target_session = str(target_session_id or "").strip()
        if not org or not user or not target_session:
            raise ArtifactError(
                "artifact_import_identity_invalid",
                "Artifact import requires owner and target session identity",
                status=400,
            )

        artifact, snapshot_path, source_identity = self.manager.resolve_owner_snapshot(
            artifact_id=artifact_id,
            target_session_id=target_session,
            org_id=org,
            user_id=user,
        )
        source = self.manager.source_provenance(artifact_id)
        name = sanitize_filename(target_filename or artifact.name or "artifact")
        import_id = new_ulid()
        relative_parts = ("imports", import_id, name)
        relative_path = "/".join(relative_parts)

        max_file_bytes = int(settings.max_file_size_mb) * 1024 * 1024
        if int(source_identity.st_size) > max_file_bytes:
            raise ArtifactError(
                "artifact_import_too_large",
                "Artifact exceeds the target workspace file-size limit",
                status=413,
            )

        quota_bytes = int(settings.workspace_quota_mb) * 1024 * 1024
        current_bytes = workspace_size_bytes(physical_workspace)
        if current_bytes + int(source_identity.st_size) > quota_bytes:
            raise ArtifactError(
                "workspace_quota_exceeded",
                "Artifact import would exceed the target workspace quota",
                status=413,
            )

        try:
            published = secure_publish_to_workspace(
                src_control_path=snapshot_path,
                workspace_path=physical_workspace,
                relative_parts=relative_parts,
                max_bytes=max_file_bytes,
            )
        except ControlPlaneError as exc:
            raise ArtifactError(
                exc.code.lower(),
                exc.message,
                status=exc.status,
            ) from exc

        try:
            audit_logger.log_tool_call(
                target_session,
                "import_artifact",
                "artifact_facade",
                True,
                "low",
                "owner-authorized immutable Artifact imported to workspace",
                {
                    "import_id": import_id,
                    "source_artifact_id": artifact_id,
                    "source_conversation_id": source["conversation_id"],
                    "source_agent_session_id": source["agent_session_id"],
                    "source_run_id": source["run_id"] or artifact.run_id,
                    "source_sha256": artifact.sha256,
                    "target_conversation_id": target_conversation_id,
                    "target_agent_session_id": target_agent_session_id,
                    "target_workspace_path": relative_path,
                    "size": int(published.st_size),
                },
                org_id=org,
                user_id=user,
            )
        except Exception as exc:
            unlink_workspace_leaf_if_matches(
                workspace_path=physical_workspace,
                relative_parts=relative_parts,
                expected=published,
            )
            if not isinstance(exc, AuditPersistenceError):
                # The import is still failed closed if an unexpected audit
                # implementation error occurs.
                exc = AuditPersistenceError("Artifact import audit failed")
            raise ArtifactError(
                "artifact_import_audit_unavailable",
                "Artifact import audit persistence unavailable",
                status=503,
            ) from exc

        return ArtifactImportResponse(
            import_id=import_id,
            artifact_id=artifact_id,
            target_session_id=target_session,
            target_conversation_id=target_conversation_id,
            workspace_file=ArtifactWorkspaceFile(
                name=name,
                path=relative_path,
                mime_type=artifact.mime_type or "application/octet-stream",
                size=int(published.st_size),
                sha256=artifact.sha256,
            ),
        )


artifact_facade = ArtifactFacade()

__all__ = ["ArtifactFacade", "artifact_facade"]
