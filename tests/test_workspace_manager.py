"""Tests for WorkspaceManager — empty init, no skills symlink, physical paths."""
from __future__ import annotations

from pathlib import Path

import pytest

from sandbox.config import settings
from sandbox.paths import (
    AGENT_WORKSPACE_PATH,
    conversation_workspace_id,
    get_session_physical_workspace,
)
from sandbox.services.session_manager import SessionManager
from sandbox.services.workspace_manager import (
    WorkspaceManager,
    WorkspaceWriteConflict,
    write_lease,
)


class TestWorkspaceManager:
    def test_init_workspace_creates_empty_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        (tmp_path / "workspaces").mkdir()
        mgr = WorkspaceManager()
        ws = mgr.init_workspace("sandbox_abc")
        assert ws.is_dir()
        # P2: empty — no skills symlink, no seed folders
        children = list(ws.iterdir())
        assert children == []

    def test_init_workspace_no_skills_symlink(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        monkeypatch.setattr(settings, "skills_root", str(tmp_path / "skill"))
        (tmp_path / "workspaces").mkdir()
        (tmp_path / "skill").mkdir()
        mgr = WorkspaceManager()
        ws = mgr.init_workspace("sandbox_skills_check")
        assert not (ws / "skills").exists()
        assert not (ws / "skill").exists()

    def test_init_conversation_workspace_path(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        (tmp_path / "workspaces").mkdir()
        mgr = WorkspaceManager()
        conv_id = "test-123"
        ws = mgr.init_conversation_workspace(conv_id)
        assert ws.name == f"conv_{conv_id}"
        assert list(ws.iterdir()) == []

    def test_conversation_workspace_naming(self):
        conv_a = "550e8400-e29b-41d4-a716-446655440000"
        conv_b = "550e8400-e29b-41d4-a716-446655440001"
        assert conversation_workspace_id(conv_a) != conversation_workspace_id(conv_b)

    def test_get_workspace_path_is_physical(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        mgr = WorkspaceManager()
        path = mgr.get_workspace_path("sandbox_xyz")
        assert path == Path(tmp_path / "workspaces" / "sandbox_xyz")
        assert str(path) != AGENT_WORKSPACE_PATH

    def test_activate_workspace_disabled_by_default(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        monkeypatch.setattr(settings, "enable_global_workspace_symlink", False)
        mgr = WorkspaceManager()
        target = tmp_path / "workspaces" / "s1"
        target.mkdir(parents=True)
        # Must not raise and must not require /home/sandbox
        assert mgr.activate_workspace(target) == target.resolve()


class TestWriteLease:
    def setup_method(self):
        write_lease.clear()

    def test_single_writer_claim(self):
        write_lease.claim("conv_a", "session_1")
        assert write_lease.holder("conv_a") == "session_1"
        # Same session re-claim is idempotent
        write_lease.claim("conv_a", "session_1")
        with pytest.raises(WorkspaceWriteConflict):
            write_lease.claim("conv_a", "session_2")
        write_lease.release("conv_a", "session_1")
        write_lease.claim("conv_a", "session_2")
        assert write_lease.holder("conv_a") == "session_2"

    def test_reclaim_when_holder_dead(self):
        write_lease.claim("conv_b", "dead_session")

        def alive(sid: str) -> bool:
            return sid != "dead_session"

        write_lease.claim_with_liveness(
            "conv_b", "new_session", is_holder_alive=alive
        )
        assert write_lease.holder("conv_b") == "new_session"


class TestSessionPhysicalIsolation:
    def setup_method(self):
        write_lease.clear()

    def test_two_sessions_use_different_physical_paths(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        (tmp_path / "workspaces").mkdir(parents=True, exist_ok=True)
        mgr = WorkspaceManager()
        sm = SessionManager()  # in-memory

        s1 = sm.create(caller_id="a")
        s2 = sm.create(caller_id="b")
        p1 = Path(get_session_physical_workspace(s1))
        p2 = Path(get_session_physical_workspace(s2))
        assert p1 != p2
        assert s1.workspace_path == AGENT_WORKSPACE_PATH
        assert s2.workspace_path == AGENT_WORKSPACE_PATH

        mgr.init_workspace(s1.session_id)
        mgr.init_workspace(s2.session_id)
        # Align physical metadata with manager paths under monkeypatched root
        s1.metadata["_physical_workspace"] = str(mgr.get_workspace_path(s1.session_id))
        s2.metadata["_physical_workspace"] = str(mgr.get_workspace_path(s2.session_id))
        p1 = Path(get_session_physical_workspace(s1))
        p2 = Path(get_session_physical_workspace(s2))

        (p1 / "only_a.txt").write_text("a")
        (p2 / "only_b.txt").write_text("b")
        assert (p1 / "only_a.txt").read_text() == "a"
        assert not (p1 / "only_b.txt").exists()
        assert (p2 / "only_b.txt").read_text() == "b"
        assert not (p2 / "only_a.txt").exists()

    def test_concurrent_writes_do_not_collide(self, tmp_path, monkeypatch):
        from concurrent.futures import ThreadPoolExecutor

        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        (tmp_path / "workspaces").mkdir(parents=True, exist_ok=True)
        mgr = WorkspaceManager()
        sm = SessionManager()

        sessions = [sm.create(caller_id=f"c{i}") for i in range(4)]
        for s in sessions:
            mgr.init_workspace(s.session_id)
            s.metadata["_physical_workspace"] = str(mgr.get_workspace_path(s.session_id))

        def write_marker(session):
            root = Path(get_session_physical_workspace(session))
            marker = root / f"{session.session_id}.txt"
            marker.write_text(session.session_id)
            return marker.read_text()

        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(write_marker, sessions))

        assert results == [s.session_id for s in sessions]
        for s in sessions:
            root = Path(get_session_physical_workspace(s))
            # Only this session's marker
            files = {p.name for p in root.iterdir() if p.is_file()}
            assert files == {f"{s.session_id}.txt"}

    def test_conversation_workspace_shared_across_session_rebind(
        self, tmp_path, monkeypatch
    ):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        (tmp_path / "workspaces").mkdir(parents=True, exist_ok=True)
        mgr = WorkspaceManager()
        sm = SessionManager()
        conv = "rebind-conv-1"
        physical = mgr.init_conversation_workspace(conv)
        (physical / "persist.txt").write_text("kept", encoding="utf-8")

        s1 = sm.create(caller_id="a", conversation_id=conv)
        assert Path(get_session_physical_workspace(s1)) == physical.resolve() or Path(
            get_session_physical_workspace(s1)
        ).name == conversation_workspace_id(conv)
        assert (Path(get_session_physical_workspace(s1)) / "persist.txt").read_text() == "kept"

        # End first session → lease released
        sm.update_status(s1.session_id, __import__("sandbox.models", fromlist=["SessionStatus"]).SessionStatus.COMPLETED)
        sm.delete(s1.session_id)

        s2 = sm.create(caller_id="b", conversation_id=conv)
        assert (Path(get_session_physical_workspace(s2)) / "persist.txt").read_text() == "kept"
