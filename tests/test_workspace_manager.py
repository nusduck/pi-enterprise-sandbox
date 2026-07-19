"""Tests for WorkspaceManager — AgentSession-owned paths; no global symlink."""
from __future__ import annotations

import ast
from pathlib import Path

import pytest

from sandbox.config import settings
from sandbox.paths import (
    PUBLIC_WORKSPACE_TOKEN,
)
from sandbox.services.workspace_manager import WorkspaceManager

WSP_A = "01JTESTWRKSP0000000000000A"


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
