"""Tests for path validation security module."""

import pytest
from pathlib import Path

from sandbox.paths import PUBLIC_WORKSPACE_TOKEN, sanitize_path_error
from sandbox.security.path_validation import (
    enforce_path_within_workspace,
    is_path_in_workspace,
    normalize_user_path,
    parse_sandbox_path,
    resolve_sandbox_path,
    resolve_safe_path,
    validate_conversation_id,
)


class TestPathValidation:
    def test_basic_resolution(self, tmp_path: Path):
        ws = str(tmp_path)
        result = resolve_safe_path(ws, "myfile.txt")
        assert result == (tmp_path / "myfile.txt").resolve()

    def test_subdirectory(self, tmp_path: Path):
        ws = str(tmp_path)
        (tmp_path / "sub").mkdir()
        result = resolve_safe_path(ws, "sub/file.txt")
        assert result == (tmp_path / "sub/file.txt").resolve()

    def test_escape_detected(self, tmp_path: Path):
        ws = str(tmp_path)
        with pytest.raises(PermissionError, match="Path escape detected"):
            resolve_safe_path(ws, "../etc/passwd")

    def test_escape_with_absolute(self, tmp_path: Path):
        ws = str(tmp_path)
        with pytest.raises(PermissionError):
            resolve_safe_path(ws, "/etc/passwd")

    def test_logical_workspace_absolute_is_normalized(self, tmp_path: Path):
        result = resolve_safe_path(
            str(tmp_path), "/home/sandbox/workspace/notes/a.txt"
        )
        assert result == (tmp_path / "notes" / "a.txt").resolve()
        assert normalize_user_path("/home/sandbox/workspace") == "."

    def test_persistent_temp_absolute_uses_temp_root(self, tmp_path: Path):
        workspace = tmp_path / "workspace"
        temp = tmp_path / "temp"
        workspace.mkdir()
        temp.mkdir()
        parsed, target = resolve_sandbox_path(workspace, temp, "/tmp/cache/a.txt")
        assert parsed.scope.value == "temp"
        assert parsed.as_public() == "/tmp/cache/a.txt"
        assert target == (temp / "cache" / "a.txt").resolve()

    def test_other_absolute_roots_are_rejected(self):
        for path in ("/etc/passwd", "/var/sandbox/workspaces/x", "/home/sandbox/skill/x"):
            with pytest.raises(PermissionError):
                parse_sandbox_path(path)

    def test_dot_is_safe(self, tmp_path: Path):
        ws = str(tmp_path)
        result = resolve_safe_path(ws, ".")
        assert result == tmp_path.resolve()

    def test_is_path_in_workspace_returns_bool(self, tmp_path: Path):
        ws = str(tmp_path)
        assert is_path_in_workspace(ws, "sub/file.txt")
        assert not is_path_in_workspace(ws, "../etc/")
        assert not is_path_in_workspace(ws, "/etc/passwd")

    def test_deeply_nested(self, tmp_path: Path):
        ws = str(tmp_path)
        (tmp_path / "a" / "b" / "c").mkdir(parents=True)
        result = resolve_safe_path(ws, "a/b/c/deep.txt")
        assert result == (tmp_path / "a/b/c/deep.txt").resolve()

    def test_dot_dot_in_middle(self, tmp_path: Path):
        ws = str(tmp_path)
        (tmp_path / "sub").mkdir()
        with pytest.raises(PermissionError):
            resolve_safe_path(ws, "sub/../outside.txt")

    def test_traversal_via_symlink_blocked(self, tmp_path: Path):
        """Symlinks that point outside workspace should be caught by resolve()."""
        ws = str(tmp_path)
        outside = tmp_path / ".." / "outside_file.txt"
        outside.write_text("secret")
        link = tmp_path / "evil_link"
        link.symlink_to(outside.resolve())
        with pytest.raises(PermissionError):
            resolve_safe_path(ws, "evil_link")

    def test_physical_path_not_in_error_detail(self, tmp_path: Path):
        """PermissionError messages must not leak physical workspace roots."""
        ws = str(tmp_path)
        with pytest.raises(PermissionError) as ei:
            resolve_safe_path(ws, "../escape.txt")
        msg = str(ei.value)
        assert str(tmp_path) not in msg
        assert "Path escape detected" in msg

    def test_enforce_path_within_workspace_alias(self, tmp_path: Path):
        p = enforce_path_within_workspace(str(tmp_path), "x.txt")
        assert p == (tmp_path / "x.txt").resolve()

    def test_null_byte_rejected(self, tmp_path: Path):
        with pytest.raises(ValueError):
            resolve_safe_path(str(tmp_path), "foo\x00bar")

    def test_home_expansion_rejected(self, tmp_path: Path):
        with pytest.raises(ValueError):
            normalize_user_path("~/secret")


class TestSanitizePathError:
    def test_replaces_physical_roots(self, tmp_path: Path, monkeypatch):
        from sandbox.config import settings

        monkeypatch.setattr(settings, "workspaces_root", str(tmp_path / "workspaces"))
        physical = str(tmp_path / "workspaces" / "conv_abc")
        msg = f"failed under {physical}/file.txt"
        out = sanitize_path_error(msg, physical_workspace=physical)
        assert physical not in out
        assert PUBLIC_WORKSPACE_TOKEN in out
        assert "/var/sandbox/workspaces" not in out


class TestConversationIdValidation:
    def test_accepts_uuid_and_simple_ids(self):
        assert validate_conversation_id("550e8400-e29b-41d4-a716-446655440000")
        assert validate_conversation_id("test-conv-empty")
        assert validate_conversation_id("abc_123")

    def test_rejects_traversal_and_separators(self):
        for bad in (
            "../etc",
            "..",
            "a/b",
            "a\\b",
            "/abs",
            "conv/../../x",
            "",
            "has space",
            "dot.dot",
            "../../passwd",
        ):
            with pytest.raises(ValueError):
                validate_conversation_id(bad)
