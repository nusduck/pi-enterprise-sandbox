"""Tests for WorkspaceManager — AgentSession-owned paths; no global symlink."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from sandbox.config import settings
from sandbox.paths import (
    PUBLIC_WORKSPACE_TOKEN,
    get_session_physical_workspace,
)
from sandbox.services.session_manager import SessionManager
from sandbox.services.workspace_manager import WorkspaceManager

AGENT_A = "01JTESTAGENT0000000000000A"
AGENT_B = "01JTESTAGENT0000000000000B"
WSP_A = "01JTESTWRKSP0000000000000A"
WSP_B = "01JTESTWRKSP0000000000000B"


class TestWorkspaceManager:
    def test_init_workspace_creates_empty_dir(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        monkeypatch.setattr(settings, "temp_root", str(tmp_path / "tmp"))
        (tmp_path / "workspaces").mkdir()
        mgr = WorkspaceManager()
        ws = mgr.init_workspace(WSP_A)
        assert ws.is_dir()
        # Empty — no skills symlink, no seed folders
        children = [p for p in ws.iterdir()]
        assert children == []

    def test_init_workspace_no_skills_symlink(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        monkeypatch.setattr(settings, "temp_root", str(tmp_path / "tmp"))
        monkeypatch.setattr(settings, "skills_root", str(tmp_path / "skill"))
        (tmp_path / "workspaces").mkdir()
        (tmp_path / "skill").mkdir()
        mgr = WorkspaceManager()
        ws = mgr.init_workspace(WSP_A)
        assert not (ws / "skills").exists()
        assert not (ws / "skill").exists()

    def test_init_workspace_rejects_non_formal_id(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        (tmp_path / "workspaces").mkdir()
        mgr = WorkspaceManager()
        with pytest.raises(ValueError):
            mgr.init_workspace("conv_not-formal")
        with pytest.raises(ValueError):
            mgr.init_workspace("../escape")

    def test_get_workspace_path_is_physical(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        mgr = WorkspaceManager()
        path = mgr.get_workspace_path(WSP_A)
        assert path == Path(tmp_path / "workspaces" / WSP_A)
        assert str(path) != PUBLIC_WORKSPACE_TOKEN
        assert not str(path).startswith("/home/sandbox")

    def test_no_global_symlink_api(self):
        """Static absence: global symlink symbols must not exist on WorkspaceManager."""
        mgr = WorkspaceManager()
        assert not hasattr(mgr, "activate_workspace")
        assert not hasattr(mgr, "get_unified_workspace")
        assert not hasattr(settings, "enable_global_workspace_symlink")
        import sandbox.services.workspace_manager as wm_mod

        assert not hasattr(wm_mod, "WORKSPACE_LINK")
        assert not hasattr(wm_mod, "write_lease")
        assert not hasattr(wm_mod, "WorkspaceWriteLease")
        assert not hasattr(wm_mod, "WorkspaceWriteConflict")


class TestGlobalSymlinkStaticAbsence:
    def test_source_has_no_global_symlink_machinery(self):
        root = Path(__file__).resolve().parents[1]
        targets = [
            root / "sandbox" / "services" / "workspace_manager.py",
            root / "sandbox" / "config.py",
            root / "sandbox" / "routers" / "sessions.py",
        ]
        forbidden = (
            "WORKSPACE_LINK",
            "enable_global_workspace_symlink",
            "activate_workspace",
            "get_unified_workspace",
            "WorkspaceWriteLease",
            "write_lease",
        )
        for path in targets:
            text = path.read_text(encoding="utf-8")
            # Parse to ensure files are valid Python, then scan source text.
            ast.parse(text)
            for token in forbidden:
                assert token not in text, f"{path.name} still contains {token}"


class TestSessionPhysicalIsolation:
    def test_two_sessions_use_different_physical_paths(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        monkeypatch.setattr(settings, "temp_root", str(tmp_path / "tmp"))
        (tmp_path / "workspaces").mkdir(parents=True, exist_ok=True)
        mgr = WorkspaceManager()
        sm = SessionManager()

        s1 = sm.create(agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a")
        s2 = sm.create(agent_session_id=AGENT_B, workspace_id=WSP_B, caller_id="b")
        p1 = Path(get_session_physical_workspace(s1))
        p2 = Path(get_session_physical_workspace(s2))
        assert p1 != p2
        assert s1.workspace_id == WSP_A
        assert s2.workspace_id == WSP_B
        assert s1.workspace_id != s2.workspace_id

        mgr.init_workspace(WSP_A)
        mgr.init_workspace(WSP_B)
        s1.metadata["_physical_workspace"] = str(mgr.get_workspace_path(WSP_A))
        s2.metadata["_physical_workspace"] = str(mgr.get_workspace_path(WSP_B))
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
        monkeypatch.setattr(settings, "temp_root", str(tmp_path / "tmp"))
        (tmp_path / "workspaces").mkdir(parents=True, exist_ok=True)
        mgr = WorkspaceManager()
        sm = SessionManager()

        ids = [
            ("01JTESTAGENT0000000000000A", "01JTESTWRKSP0000000000000A"),
            ("01JTESTAGENT0000000000000B", "01JTESTWRKSP0000000000000B"),
            ("01JTESTAGENT0000000000000C", "01JTESTWRKSP0000000000000C"),
            ("01JTESTAGENT0000000000000D", "01JTESTWRKSP0000000000000D"),
        ]
        sessions = [
            sm.create(agent_session_id=a, workspace_id=w, caller_id=f"c{i}")
            for i, (a, w) in enumerate(ids)
        ]
        for s in sessions:
            mgr.init_workspace(s.workspace_id)
            s.metadata["_physical_workspace"] = str(
                mgr.get_workspace_path(s.workspace_id)
            )

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
            files = {p.name for p in root.iterdir() if p.is_file()}
            assert files == {f"{s.session_id}.txt"}

    def test_agent_session_rebind_same_workspace(self, tmp_path, monkeypatch):
        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        monkeypatch.setattr(settings, "temp_root", str(tmp_path / "tmp"))
        (tmp_path / "workspaces").mkdir(parents=True, exist_ok=True)
        mgr = WorkspaceManager()
        sm = SessionManager()
        physical = mgr.init_workspace(WSP_A)
        (physical / "persist.txt").write_text("kept", encoding="utf-8")

        s1 = sm.create(agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="a")
        assert Path(get_session_physical_workspace(s1)).name == WSP_A
        # Align physical path under monkeypatched root
        s1.metadata["_physical_workspace"] = str(physical)
        assert (physical / "persist.txt").read_text() == "kept"

        from sandbox.models import SessionStatus

        sm.update_status(s1.session_id, SessionStatus.COMPLETED)
        s2 = sm.create(agent_session_id=AGENT_A, workspace_id=WSP_A, caller_id="b")
        assert s2.session_id == s1.session_id
        assert s2.workspace_id == WSP_A
        assert (physical / "persist.txt").read_text() == "kept"
