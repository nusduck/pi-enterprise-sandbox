"""PR-07B: anti-TOCTOU secure workspace regular-file opener (macOS-safe)."""

from __future__ import annotations

import os
import stat
import time
from pathlib import Path

import pytest

from sandbox.security.secure_workspace_file import (
    SecureWorkspaceFileError,
    fstat_identity,
    identities_equal,
    open_workspace_regular_file,
    validate_relative_parts,
)

WS = "01K0G2PAV8FPMVC9QHJG7JPN56"


@pytest.fixture
def tree(tmp_path: Path):
    """workspaces_root / WS / ..."""
    root = tmp_path / "workspaces"
    root.mkdir()
    ws = root / WS
    ws.mkdir()
    return root, ws


class TestValidateRelativeParts:
    def test_happy(self) -> None:
        assert validate_relative_parts(["a", "b.txt"]) == ("a", "b.txt")

    def test_reject_empty_list(self) -> None:
        with pytest.raises(SecureWorkspaceFileError) as ei:
            validate_relative_parts([])
        assert ei.value.code == "PATH_INVALID"

    def test_reject_dot_dot(self) -> None:
        with pytest.raises(SecureWorkspaceFileError) as ei:
            validate_relative_parts(["..", "x"])
        assert ei.value.code == "PATH_INVALID"

    def test_reject_dot(self) -> None:
        with pytest.raises(SecureWorkspaceFileError) as ei:
            validate_relative_parts([".", "x"])
        assert ei.value.code == "PATH_INVALID"

    def test_reject_nul(self) -> None:
        with pytest.raises(SecureWorkspaceFileError) as ei:
            validate_relative_parts(["a\x00b"])
        assert ei.value.code == "PATH_INVALID"

    def test_reject_slash_in_part(self) -> None:
        with pytest.raises(SecureWorkspaceFileError) as ei:
            validate_relative_parts(["a/b"])
        assert ei.value.code == "PATH_INVALID"

    def test_reject_backslash(self) -> None:
        with pytest.raises(SecureWorkspaceFileError) as ei:
            validate_relative_parts(["a\\b"])
        assert ei.value.code == "PATH_INVALID"

    def test_reject_empty_segment(self) -> None:
        with pytest.raises(SecureWorkspaceFileError) as ei:
            validate_relative_parts(["a", ""])
        assert ei.value.code == "PATH_INVALID"


class TestOpenWorkspaceRegularFile:
    def test_read_nested_file(self, tree) -> None:
        root, ws = tree
        sub = ws / "dir"
        sub.mkdir()
        (sub / "f.txt").write_text("hello", encoding="utf-8")
        with open_workspace_regular_file(root, WS, ["dir", "f.txt"]) as fd:
            assert os.read(fd, 20) == b"hello"
            st = os.fstat(fd)
            assert stat.S_ISREG(st.st_mode)

    def test_leaf_symlink_rejected(self, tree) -> None:
        root, ws = tree
        outside = tree[0].parent / "secret.txt"
        outside.write_text("SECRET", encoding="utf-8")
        (ws / "link.txt").symlink_to(outside)
        with pytest.raises(SecureWorkspaceFileError) as ei:
            with open_workspace_regular_file(root, WS, ["link.txt"]) as fd:
                os.read(fd, 100)
        assert ei.value.code in ("SYMLINK_REJECTED", "NOT_REGULAR_FILE", "FILE_NOT_FOUND")
        # No physical path leak
        assert str(root) not in str(ei.value)
        assert "secret" not in str(ei.value).lower() or "SECRET" not in str(ei.value)

    def test_intermediate_symlink_rejected(self, tree) -> None:
        root, ws = tree
        real = ws / "realdir"
        real.mkdir()
        (real / "x.txt").write_text("x", encoding="utf-8")
        (ws / "linkdir").symlink_to(real)
        with pytest.raises(SecureWorkspaceFileError) as ei:
            with open_workspace_regular_file(
                root, WS, ["linkdir", "x.txt"]
            ) as fd:
                os.read(fd, 10)
        assert ei.value.code in (
            "SYMLINK_REJECTED",
            "NOT_REGULAR_FILE",
            "FILE_NOT_FOUND",
        )

    def test_rename_swap_still_reads_original_inode(self, tree) -> None:
        root, ws = tree
        target = ws / "stable.txt"
        target.write_text("ORIGINAL", encoding="utf-8")
        with open_workspace_regular_file(root, WS, ["stable.txt"]) as fd:
            # Replace pathname with different content while fd is open.
            target.unlink()
            target.write_text("REPLACED", encoding="utf-8")
            data = os.read(fd, 100)
            # Open fd still references original inode content.
            assert data == b"ORIGINAL"

    def test_symlink_swap_after_open_no_exfiltration(self, tree) -> None:
        root, ws = tree
        target = ws / "data.txt"
        target.write_text("SAFE", encoding="utf-8")
        outside = tree[0].parent / "evil.txt"
        outside.write_text("EVIL", encoding="utf-8")
        with open_workspace_regular_file(root, WS, ["data.txt"]) as fd:
            target.unlink()
            target.symlink_to(outside)
            data = os.read(fd, 100)
            assert data == b"SAFE"
            assert b"EVIL" not in data

    def test_fifo_does_not_hang(self, tree) -> None:
        root, ws = tree
        fifo = ws / "pipe"
        os.mkfifo(fifo)
        t0 = time.monotonic()
        with pytest.raises(SecureWorkspaceFileError) as ei:
            with open_workspace_regular_file(root, WS, ["pipe"]) as fd:
                os.read(fd, 1)
        elapsed = time.monotonic() - t0
        assert elapsed < 1.0, "FIFO open must not block"
        assert ei.value.code == "NOT_REGULAR_FILE"

    def test_directory_leaf_rejected(self, tree) -> None:
        root, ws = tree
        (ws / "subdir").mkdir()
        with pytest.raises(SecureWorkspaceFileError) as ei:
            with open_workspace_regular_file(root, WS, ["subdir"]) as fd:
                pass
        assert ei.value.code in ("NOT_REGULAR_FILE", "FILE_NOT_FOUND")

    def test_missing_file(self, tree) -> None:
        root, _ws = tree
        with pytest.raises(SecureWorkspaceFileError) as ei:
            with open_workspace_regular_file(root, WS, ["nope.txt"]) as fd:
                pass
        assert ei.value.code == "FILE_NOT_FOUND"

    def test_missing_workspace_dir_not_created(self, tmp_path: Path) -> None:
        root = tmp_path / "workspaces"
        root.mkdir()
        # WS directory does not exist — opener must not create it.
        with pytest.raises(SecureWorkspaceFileError) as ei:
            with open_workspace_regular_file(root, WS, ["a.txt"]) as fd:
                pass
        assert ei.value.code == "FILE_NOT_FOUND"
        assert not (root / WS).exists()

    def test_fd_closed_after_context(self, tree) -> None:
        root, ws = tree
        (ws / "c.txt").write_text("c", encoding="utf-8")
        held: list[int] = []
        with open_workspace_regular_file(root, WS, ["c.txt"]) as fd:
            held.append(fd)
            assert os.fstat(fd).st_size == 1
        with pytest.raises(OSError):
            os.fstat(held[0])

    def test_invalid_workspace_id(self, tree) -> None:
        root, _ = tree
        with pytest.raises(SecureWorkspaceFileError) as ei:
            with open_workspace_regular_file(root, "../etc", ["x"]) as fd:
                pass
        assert ei.value.code == "PATH_INVALID"

    def test_error_message_no_physical_root(self, tree) -> None:
        root, _ = tree
        with pytest.raises(SecureWorkspaceFileError) as ei:
            with open_workspace_regular_file(root, WS, ["missing.bin"]) as fd:
                pass
        msg = str(ei.value)
        assert str(root) not in msg
        assert WS not in msg or ei.value.code == "FILE_NOT_FOUND"

    def test_fstat_identity_stable(self, tree) -> None:
        root, ws = tree
        (ws / "id.txt").write_text("id", encoding="utf-8")
        with open_workspace_regular_file(root, WS, ["id.txt"]) as fd:
            a = fstat_identity(fd)
            b = fstat_identity(fd)
            assert identities_equal(a, b)
            assert a.st_size == 2
