"""Tests for ArtifactManager — submit path only (PR-13).

Metadata-only READY / register / hash_file_streaming / resolve_download_path
compatibility paths are removed. Authority is workspace file → control-plane
snapshot via :meth:`ArtifactManager.submit`.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox.services.artifact_manager import ArtifactError, ArtifactManager
from sandbox.services.control_plane_storage import artifact_blob_path


def _workspace_with(tmp_path: Path, rel: str, content: bytes) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir(parents=True, exist_ok=True)
    target = ws / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return ws


class TestArtifactManager:
    def test_submit_artifact_hashes_and_snapshots(self, tmp_path):
        mgr = ArtifactManager(auto_wire_formal=False)
        content = b"xlsx-bytes"
        ws = _workspace_with(tmp_path, "output/report.xlsx", content)
        art = mgr.submit(
            session_id="s1",
            path="output/report.xlsx",
            name="report.xlsx",
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            source_execution_id="exec_001",
            physical_workspace=ws,
        )
        assert art.artifact_id
        assert art.name == "report.xlsx"
        assert art.size == len(content)
        assert art.sha256
        # Control-plane snapshot is the download source (not workspace).
        snap = artifact_blob_path("_local", art.artifact_id)
        if not snap.is_file():
            # org defaults to _local when org_id omitted
            from sandbox.services.control_plane_storage import artifacts_root

            candidates = list(artifacts_root().rglob(art.artifact_id))
            assert candidates, "expected control-plane snapshot for submitted artifact"
            assert candidates[0].read_bytes() == content
        else:
            assert snap.read_bytes() == content

    def test_list_by_session(self, tmp_path):
        mgr = ArtifactManager(auto_wire_formal=False)
        ws = _workspace_with(tmp_path, "a.txt", b"a")
        (ws / "b.txt").write_bytes(b"b")
        mgr.submit(
            session_id="s2",
            path="a.txt",
            name="a.txt",
            physical_workspace=ws,
        )
        mgr.submit(
            session_id="s2",
            path="b.txt",
            name="b.txt",
            physical_workspace=ws,
        )
        arts = mgr.list_by_session("s2")
        assert len(arts) == 2

    def test_list_empty_session(self):
        mgr = ArtifactManager(auto_wire_formal=False)
        assert mgr.list_by_session("empty") == []

    def test_get_artifact(self, tmp_path):
        mgr = ArtifactManager(auto_wire_formal=False)
        ws = _workspace_with(tmp_path, "test.txt", b"hi")
        art = mgr.submit(
            session_id="s3",
            path="test.txt",
            name="test.txt",
            physical_workspace=ws,
        )
        fetched = mgr.get(art.artifact_id)
        assert fetched is not None
        assert fetched.name == "test.txt"

    def test_get_nonexistent(self):
        mgr = ArtifactManager(auto_wire_formal=False)
        assert mgr.get("nonexistent") is None

    def test_get_for_session_rejects_cross_session(self, tmp_path):
        mgr = ArtifactManager(auto_wire_formal=False)
        ws = _workspace_with(tmp_path, "secret.txt", b"secret")
        art = mgr.submit(
            session_id="owner",
            path="secret.txt",
            name="secret.txt",
            physical_workspace=ws,
        )
        assert mgr.get_for_session("owner", art.artifact_id) is not None
        assert mgr.get_for_session("other", art.artifact_id) is None

    def test_delete_by_session(self, tmp_path):
        mgr = ArtifactManager(auto_wire_formal=False)
        ws = _workspace_with(tmp_path, "a.txt", b"a")
        (ws / "b.txt").write_bytes(b"b")
        mgr.submit(session_id="s4", path="a.txt", name="a.txt", physical_workspace=ws)
        mgr.submit(session_id="s4", path="b.txt", name="b.txt", physical_workspace=ws)
        count = mgr.delete_by_session("s4")
        assert count == 2
        assert mgr.list_by_session("s4") == []

    def test_submit_missing_workspace_file_fails_closed(self, tmp_path):
        """No workspace leaf → no READY artifact (not metadata-only READY)."""
        mgr = ArtifactManager(auto_wire_formal=False)
        ws = tmp_path / "empty-ws"
        ws.mkdir()
        with pytest.raises(ArtifactError) as ei:
            mgr.submit(
                session_id="s-bad",
                path="missing.txt",
                name="missing.txt",
                physical_workspace=ws,
            )
        assert ei.value.status in (400, 403, 404)
        assert mgr.list_by_session("s-bad") == []

    def test_workspace_mutate_after_submit_does_not_change_snapshot(self, tmp_path):
        mgr = ArtifactManager(auto_wire_formal=False)
        ws = _workspace_with(tmp_path, "a.txt", b"ORIGINAL-CONTENT")
        art = mgr.submit(
            session_id="s-m",
            path="a.txt",
            name="a.txt",
            physical_workspace=ws,
            org_id="01K0G2PAV8FPMVC9QHJG7JPN4Z",
            user_id="01K0G2PAV8FPMVC9QHJG7JPN50",
        )
        (ws / "a.txt").write_bytes(b"EVIL-MUTATED-BYTES!!")
        _art, path, _ident = mgr.resolve_download(
            session_id="s-m",
            artifact_id=art.artifact_id,
            org_id="01K0G2PAV8FPMVC9QHJG7JPN4Z",
            user_id="01K0G2PAV8FPMVC9QHJG7JPN50",
        )
        assert path.read_bytes() == b"ORIGINAL-CONTENT"
