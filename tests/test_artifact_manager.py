"""Tests for ArtifactManager."""

import pytest
from sandbox.services.artifact_manager import ArtifactManager


class TestArtifactManager:
    @pytest.fixture
    def mgr(self):
        return ArtifactManager()

    def test_register_artifact(self, mgr: ArtifactManager):
        art = mgr.register(
            session_id="s1",
            name="report.xlsx",
            path="output/exec_001/report.xlsx",
            mime_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            source_execution_id="exec_001",
            size=1024,
        )
        assert art.artifact_id.startswith("art_")
        assert art.name == "report.xlsx"
        assert art.size == 1024

    def test_list_by_session(self, mgr: ArtifactManager):
        mgr.register(session_id="s2", name="a.txt", path="a.txt")
        mgr.register(session_id="s2", name="b.txt", path="b.txt")
        arts = mgr.list_by_session("s2")
        assert len(arts) == 2

    def test_list_empty_session(self, mgr: ArtifactManager):
        assert mgr.list_by_session("empty") == []

    def test_get_artifact(self, mgr: ArtifactManager):
        art = mgr.register(session_id="s3", name="test.txt", path="test.txt")
        fetched = mgr.get(art.artifact_id)
        assert fetched is not None
        assert fetched.name == "test.txt"

    def test_get_nonexistent(self, mgr: ArtifactManager):
        assert mgr.get("nonexistent") is None

    def test_get_for_session_rejects_cross_session(self, mgr: ArtifactManager):
        art = mgr.register(session_id="owner", name="secret.txt", path="secret.txt")
        assert mgr.get_for_session("owner", art.artifact_id) is not None
        assert mgr.get_for_session("other", art.artifact_id) is None

    def test_delete_by_session(self, mgr: ArtifactManager):
        mgr.register(session_id="s4", name="a.txt", path="a.txt")
        mgr.register(session_id="s4", name="b.txt", path="b.txt")
        count = mgr.delete_by_session("s4")
        assert count == 2
        assert mgr.list_by_session("s4") == []
