"""Artifact phase-one facade and cross-session import tests."""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox.artifact.application.facade import ArtifactFacade
from sandbox.artifact.infrastructure.manager import ArtifactError, ArtifactManager
from sandbox.artifact.infrastructure.store import (
    FakeFormalArtifactRepository,
    FormalArtifactDualWriter,
)
from sandbox.services.audit_logger import AuditPersistenceError

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
OTHER_USER = "01K0G2PAV8FPMVC9QHJG7JPN60"
SOURCE_CONVERSATION = "01K0G2PAV8FPMVC9QHJG7JPN51"
TARGET_CONVERSATION = "01K0G2PAV8FPMVC9QHJG7JPN61"
SOURCE_AGENT_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN52"
TARGET_AGENT_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN62"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"


def _case(tmp_path: Path) -> tuple[ArtifactFacade, FakeFormalArtifactRepository, str, bytes]:
    repository = FakeFormalArtifactRepository()
    manager = ArtifactManager(
        formal=FormalArtifactDualWriter(repository, authoritative=True),
        auto_wire_formal=False,
    )
    source_workspace = tmp_path / "source"
    source_workspace.mkdir()
    content = b"immutable cross-conversation input"
    (source_workspace / "report.pdf").write_bytes(content)
    artifact = manager.submit(
        session_id="source-session",
        path="report.pdf",
        name="report.pdf",
        mime_type="application/pdf",
        physical_workspace=source_workspace,
        org_id=ORG,
        user_id=USER,
        conversation_id=SOURCE_CONVERSATION,
        agent_session_id=SOURCE_AGENT_SESSION,
        run_id=RUN,
    )
    return ArtifactFacade(manager), repository, artifact.artifact_id, content


def test_import_copies_owner_artifact_to_unique_workspace_input(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    facade, repository, artifact_id, content = _case(tmp_path)
    target_workspace = tmp_path / "target"
    target_workspace.mkdir()
    audit_entries: list[dict] = []
    monkeypatch.setattr(
        "sandbox.artifact.application.facade.audit_logger.log_tool_call",
        lambda *args, **kwargs: audit_entries.append(
            {"args": args, "kwargs": kwargs}
        ),
    )

    result = facade.import_to_workspace(
        artifact_id=artifact_id,
        target_session_id="target-session",
        physical_workspace=target_workspace,
        org_id=ORG,
        user_id=USER,
        target_filename="../../renamed.pdf",
        target_conversation_id=TARGET_CONVERSATION,
        target_agent_session_id=TARGET_AGENT_SESSION,
    )

    assert result.artifact_id == artifact_id
    assert result.target_conversation_id == TARGET_CONVERSATION
    assert result.workspace_file.name == "renamed.pdf"
    assert result.workspace_file.path.startswith(f"imports/{result.import_id}/")
    assert (target_workspace / result.workspace_file.path).read_bytes() == content
    # Import is input-only: no second Artifact row is created.
    assert list(repository.rows) == [artifact_id]
    assert audit_entries[0]["args"][1] == "import_artifact"
    assert audit_entries[0]["args"][6]["source_artifact_id"] == artifact_id
    assert (
        audit_entries[0]["args"][6]["source_conversation_id"]
        == SOURCE_CONVERSATION
    )


def test_import_rejects_foreign_owner_without_creating_workspace_file(
    tmp_path: Path,
) -> None:
    facade, _repository, artifact_id, _content = _case(tmp_path)
    target_workspace = tmp_path / "target"
    target_workspace.mkdir()

    with pytest.raises(ArtifactError) as caught:
        facade.import_to_workspace(
            artifact_id=artifact_id,
            target_session_id="target-session",
            physical_workspace=target_workspace,
            org_id=ORG,
            user_id=OTHER_USER,
            target_conversation_id=TARGET_CONVERSATION,
        )

    assert caught.value.status == 404
    assert not (target_workspace / "imports").exists()


def test_import_rolls_back_published_file_when_audit_is_unavailable(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    facade, _repository, artifact_id, _content = _case(tmp_path)
    target_workspace = tmp_path / "target"
    target_workspace.mkdir()

    def _audit_failure(*_args, **_kwargs):
        raise AuditPersistenceError("offline")

    monkeypatch.setattr(
        "sandbox.artifact.application.facade.audit_logger.log_tool_call",
        _audit_failure,
    )

    with pytest.raises(ArtifactError) as caught:
        facade.import_to_workspace(
            artifact_id=artifact_id,
            target_session_id="target-session",
            physical_workspace=target_workspace,
            org_id=ORG,
            user_id=USER,
            target_conversation_id=TARGET_CONVERSATION,
        )

    assert caught.value.code == "artifact_import_audit_unavailable"
    assert not any(
        path.is_file() for path in (target_workspace / "imports").rglob("*")
    )
