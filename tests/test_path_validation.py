"""Tests for path validation security module."""

import pytest
from pathlib import Path
from sandbox.security.path_validation import (
    resolve_safe_path,
    is_path_in_workspace,
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

    def test_dot_is_safe(self, tmp_path: Path):
        ws = str(tmp_path)
        result = resolve_safe_path(ws, ".")
        assert result == tmp_path.resolve()

    def test_is_path_in_workspace_returns_bool(self, tmp_path: Path):
        ws = str(tmp_path)
        assert is_path_in_workspace(ws, "sub/file.txt")
        assert not is_path_in_workspace(ws, "../etc/")

    def test_deeply_nested(self, tmp_path: Path):
        ws = str(tmp_path)
        (tmp_path / "a" / "b" / "c").mkdir(parents=True)
        result = resolve_safe_path(ws, "a/b/c/deep.txt")
        assert result == (tmp_path / "a/b/c/deep.txt").resolve()

    def test_dot_dot_in_middle(self, tmp_path: Path):
        ws = str(tmp_path)
        (tmp_path / "sub").mkdir()
        # a/b/../c resolves to a/c which is inside workspace
        result = resolve_safe_path(ws, "sub/../outside.txt")
        # sub/../ resolves to workspace root, so it's inside
        assert result == (tmp_path / "outside.txt").resolve()

    def test_traversal_via_symlink_blocked(self, tmp_path: Path):
        """Symlinks that point outside workspace should be caught by resolve()."""
        ws = str(tmp_path)
        outside = tmp_path / ".." / "outside_file.txt"
        outside.write_text("secret")
        link = tmp_path / "evil_link"
        link.symlink_to(outside.resolve())
        with pytest.raises(PermissionError):
            resolve_safe_path(ws, "evil_link")
