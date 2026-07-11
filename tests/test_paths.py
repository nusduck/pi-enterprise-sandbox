"""Tests for stable agent path constants and physical workspace helper."""

from __future__ import annotations

from types import SimpleNamespace

from sandbox.config import settings
from sandbox.paths import (
    AGENT_SKILL_PATH,
    AGENT_WORKSPACE_PATH,
    conversation_workspace_id,
    get_session_physical_workspace,
    to_public_workspace_path,
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


def test_get_session_physical_from_workspace_id(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspaces_root", str(tmp_path))
    session = SimpleNamespace(
        session_id="sandbox_xyz",
        metadata={"workspace_id": "conv_abc"},
    )
    assert get_session_physical_workspace(session) == str(tmp_path / "conv_abc")


def test_to_public_workspace_path_always_logical():
    assert to_public_workspace_path(None) == AGENT_WORKSPACE_PATH
    assert to_public_workspace_path("/var/sandbox/workspaces/conv_x") == AGENT_WORKSPACE_PATH
    assert to_public_workspace_path("conv_x") == AGENT_WORKSPACE_PATH
    assert to_public_workspace_path(AGENT_WORKSPACE_PATH) == AGENT_WORKSPACE_PATH


def test_conversation_workspace_id():
    assert conversation_workspace_id("abc") == "conv_abc"
