"""Tests for relative workspace path contract and physical workspace helper."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

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


def test_logical_skill_paths_cover_both_tiers():
    """The user tier must not be mistaken for a child of the system tier."""
    from sandbox.paths import (
        AGENT_SKILL_PATH,
        AGENT_USER_SKILL_PATH,
        is_logical_skill_path,
        logical_skill_root,
    )

    assert is_logical_skill_path(f"{AGENT_SKILL_PATH}/pdf/SKILL.md")
    assert is_logical_skill_path(f"{AGENT_USER_SKILL_PATH}/mine/SKILL.md")
    assert not is_logical_skill_path("/home/sandbox/workspace/a.txt")
    assert not is_logical_skill_path(None)

    # Longest root wins, so a user path resolves to the user tier and not to
    # "skill" plus a "-user/..." remainder.
    assert (
        logical_skill_root(f"{AGENT_USER_SKILL_PATH}/mine/SKILL.md")
        == AGENT_USER_SKILL_PATH
    )
    assert (
        logical_skill_root(f"{AGENT_SKILL_PATH}/pdf/SKILL.md") == AGENT_SKILL_PATH
    )
    assert logical_skill_root("/etc/passwd") is None


def test_files_read_accepts_both_skill_tiers_and_rejects_them_on_workspace():
    from sandbox.app.domain.files_read_contract import (
        _validate_canonical_skill_path,
        _validate_canonical_workspace_path,
    )

    for root in ("/home/sandbox/skill", "/home/sandbox/skill-user"):
        path = f"{root}/pkg/SKILL.md"
        assert _validate_canonical_skill_path(path) == path
        with pytest.raises(Exception):
            _validate_canonical_workspace_path(path)

    with pytest.raises(Exception):
        _validate_canonical_skill_path("/home/sandbox/workspace/a.txt")


def test_execution_context_resolves_only_its_own_user_skill_dir(monkeypatch, tmp_path):
    """The per-user skill dir is derived from the trusted session binding."""
    from dataclasses import replace

    from sandbox.config import settings
    from sandbox.services.execution_context import SandboxExecutionContext

    monkeypatch.setattr(settings, "user_skills_root", str(tmp_path))
    base = SandboxExecutionContext(
        session_id="s",
        workspace_id="w",
        temp_id="t",
        physical_workspace=tmp_path,
        physical_temp=tmp_path,
    )

    # No identity → no user tier at all (never the shared base).
    assert base.user_skill_dir is None
    assert replace(base, org_id="org1").user_skill_dir is None
    assert replace(base, user_id="user1").user_skill_dir is None

    owned = replace(base, org_id="org1", user_id="user1")
    assert owned.user_skill_dir == tmp_path / "org1" / "user1"

    # Identity segments become path components, so traversal must be refused.
    for bad in ("../..", "a/b", "", "."):
        assert replace(base, org_id="org1", user_id=bad).user_skill_dir is None
        assert replace(base, org_id=bad, user_id="user1").user_skill_dir is None
