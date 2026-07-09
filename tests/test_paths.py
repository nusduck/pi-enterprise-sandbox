"""Tests for stable agent path constants and physical workspace helper."""

from __future__ import annotations

from types import SimpleNamespace

from sandbox.config import settings
from sandbox.paths import (
    AGENT_SKILL_PATH,
    AGENT_WORKSPACE_PATH,
    get_session_physical_workspace,
)


def test_agent_path_constants():
    assert AGENT_WORKSPACE_PATH == "/home/sandbox/workspace"
    assert AGENT_SKILL_PATH == "/home/sandbox/skill"
    assert settings.agent_workspace_path == AGENT_WORKSPACE_PATH
    assert settings.agent_skill_path == AGENT_SKILL_PATH


def test_get_session_physical_workspace_from_metadata():
    session = SimpleNamespace(
        session_id="sandbox_abc",
        metadata={"_physical_workspace": "/tmp/ws/sandbox_abc"},
    )
    assert get_session_physical_workspace(session) == "/tmp/ws/sandbox_abc"


def test_get_session_physical_workspace_fallback(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspaces_root", str(tmp_path))
    session = SimpleNamespace(session_id="sandbox_xyz", metadata={})
    assert get_session_physical_workspace(session) == str(tmp_path / "sandbox_xyz")
