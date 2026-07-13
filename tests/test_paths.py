"""Tests for relative workspace path contract and physical workspace helper."""

from __future__ import annotations

from types import SimpleNamespace

from sandbox.config import settings
from sandbox.paths import (
    AGENT_SKILL_PATH,
    AGENT_TEMP_PATH,
    PUBLIC_WORKSPACE_TOKEN,
    conversation_workspace_id,
    get_session_physical_workspace,
    get_session_physical_temp,
    public_metadata,
    sanitize_path_error,
    sanitize_physical_paths,
    temp_id_for_workspace_id,
    to_public_workspace_path,
)


def test_public_tokens_and_skill_constant():
    assert PUBLIC_WORKSPACE_TOKEN == "<workspace>"
    assert AGENT_SKILL_PATH == "/home/sandbox/skill"
    assert settings.agent_skill_path == AGENT_SKILL_PATH
    assert AGENT_TEMP_PATH == "/tmp"


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


def test_get_session_physical_temp_from_workspace_id(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "temp_root", str(tmp_path))
    session = SimpleNamespace(
        session_id="sandbox_xyz",
        metadata={"workspace_id": "conv_abc"},
    )
    assert get_session_physical_temp(session) == str(tmp_path / "tmp_conv_abc")
    assert temp_id_for_workspace_id("conv_abc") == "tmp_conv_abc"


def test_to_public_workspace_path_redacts():
    assert to_public_workspace_path(None) == PUBLIC_WORKSPACE_TOKEN
    assert to_public_workspace_path("/var/sandbox/workspaces/conv_x") == PUBLIC_WORKSPACE_TOKEN
    assert to_public_workspace_path("conv_x") == PUBLIC_WORKSPACE_TOKEN


def test_public_metadata_strips_internal_keys():
    assert public_metadata(
        {"workspace_id": "conv_a", "_physical_workspace": "/secret", "ok": 1}
    ) == {"workspace_id": "conv_a", "ok": 1}
    assert public_metadata(None) == {}


def test_sanitize_physical_paths_includes_workspaces_root(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
    physical = str(tmp_path / "workspaces" / "conv_abc")
    msg = f"failed under {physical}/file.txt"
    out = sanitize_physical_paths(msg, physical_workspace=physical)
    assert physical not in out
    assert PUBLIC_WORKSPACE_TOKEN in out
    assert str(tmp_path / "workspaces") not in out


def test_sanitize_path_error_redacts_defaults():
    msg = "error in /var/sandbox/workspaces/conv_x/a.txt"
    out = sanitize_path_error(msg)
    assert "/var/sandbox/workspaces" not in out
    assert PUBLIC_WORKSPACE_TOKEN in out


def test_conversation_workspace_id():
    assert conversation_workspace_id("abc") == "conv_abc"
