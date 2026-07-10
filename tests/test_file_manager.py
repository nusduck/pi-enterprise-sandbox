"""Tests for FileManager."""

import shutil
import tempfile
from pathlib import Path

import pytest
from sandbox.config import settings
from sandbox.services.file_manager import FileManager, workspace_size_bytes


@pytest.fixture
def ws():
    tmp = Path(tempfile.mkdtemp())
    yield str(tmp)
    shutil.rmtree(str(tmp), ignore_errors=True)


class TestFileManager:
    @pytest.fixture
    def mgr(self):
        return FileManager()

    def test_write_and_read(self, mgr: FileManager, ws: str):
        mgr.write_file(ws, "hello.txt", "Hello, Sandbox!")
        result = mgr.read_file(ws, "hello.txt")
        assert result.content == "Hello, Sandbox!"
        assert result.size == 15

    def test_read_nonexistent_returns_empty(self, mgr: FileManager, ws: str):
        result = mgr.read_file(ws, "nonexistent.txt")
        assert result.content == ""

    def test_write_creates_subdirs(self, mgr: FileManager, ws: str):
        mgr.write_file(ws, "a/b/c/deep.txt", "deep content")
        result = mgr.read_file(ws, "a/b/c/deep.txt")
        assert result.content == "deep content"

    def test_list_files(self, mgr: FileManager, ws: str):
        mgr.write_file(ws, "file1.txt", "one")
        mgr.write_file(ws, "file2.txt", "two")
        files = mgr.list_files(ws, ".")
        names = [f.name for f in files]
        assert "file1.txt" in names
        assert "file2.txt" in names

    def test_list_subdirectory(self, mgr: FileManager, ws: str):
        mgr.write_file(ws, "sub/inside.txt", "inside")
        files = mgr.list_files(ws, "sub")
        assert len(files) == 1
        assert files[0].name == "inside.txt"

    def test_preview(self, mgr: FileManager, ws: str):
        content = "\n".join([f"line {i}" for i in range(100)])
        mgr.write_file(ws, "big.txt", content)
        result = mgr.read_file(ws, "big.txt", offset=1, limit=5)
        lines = result.content.strip().split("\n")
        assert len(lines) == 5

    def test_delete_file(self, mgr: FileManager, ws: str):
        mgr.write_file(ws, "delete_me.txt", "bye")
        assert mgr.delete_file(ws, "delete_me.txt") is True
        assert not (Path(ws) / "delete_me.txt").exists()

    def test_path_escape_blocked(self, mgr: FileManager, ws: str):
        with pytest.raises(PermissionError):
            mgr.read_file(ws, "../etc/passwd")
        with pytest.raises(PermissionError):
            mgr.write_file(ws, "../outside.txt", "content")

    def test_write_append_mode(self, mgr: FileManager, ws: str):
        mgr.write_file(ws, "append.txt", "first\n")
        mgr.write_file(ws, "append.txt", "second\n", mode="a")
        result = mgr.read_file(ws, "append.txt")
        assert "first" in result.content
        assert "second" in result.content

    def test_workspace_size_bytes(self, mgr: FileManager, ws: str):
        mgr.write_file(ws, "a.txt", "abcd")  # 4 bytes
        mgr.write_file(ws, "sub/b.txt", "ef")  # 2 bytes
        assert workspace_size_bytes(ws) == 6
        assert workspace_size_bytes(Path(ws) / "missing") == 0

    def test_workspace_quota_exceeded(self, mgr: FileManager, ws: str, monkeypatch):
        # ~10 bytes quota so a modest write fails
        monkeypatch.setattr(settings, "workspace_quota_mb", 0)
        # 0 MB → 0 bytes; any non-empty write exceeds
        with pytest.raises(ValueError, match="Workspace quota exceeded"):
            mgr.write_file(ws, "too_big.txt", "x")

    def test_workspace_quota_allows_within_limit(self, mgr: FileManager, ws: str, monkeypatch):
        # 1 MB is ample for a small write
        monkeypatch.setattr(settings, "workspace_quota_mb", 1)
        result = mgr.write_file(ws, "ok.txt", "hello")
        assert result.size == 5

    def test_write_binary_roundtrip_invalid_utf8_and_nul(self, mgr: FileManager, ws: str):
        payload = b"hello\x00world\xff\xfe binary"
        result = mgr.write_binary(ws, "bin.dat", payload)
        assert result.size == len(payload)
        on_disk = (Path(ws) / "bin.dat").read_bytes()
        assert on_disk == payload

    def test_write_binary_quota_no_partial(self, mgr: FileManager, ws: str, monkeypatch):
        monkeypatch.setattr(settings, "workspace_quota_mb", 0)
        target = Path(ws) / "too_big.bin"
        with pytest.raises(ValueError, match="Workspace quota exceeded"):
            mgr.write_binary(ws, "too_big.bin", b"\x00\x01\x02")
        assert not target.exists()
        # No leftover temp files either
        leftovers = list(Path(ws).glob(".upload_*"))
        assert leftovers == []

    def test_write_binary_file_size_limit(self, mgr: FileManager, ws: str, monkeypatch):
        monkeypatch.setattr(settings, "max_file_size_mb", 0)
        with pytest.raises(ValueError, match="max file size"):
            mgr.write_binary(ws, "big.bin", b"x")
        assert not (Path(ws) / "big.bin").exists()

    def test_write_binary_does_not_corrupt_existing_on_quota_fail(
        self, mgr: FileManager, ws: str, monkeypatch,
    ):
        original = b"\x00keep-me"
        mgr.write_binary(ws, "keep.bin", original)
        monkeypatch.setattr(settings, "workspace_quota_mb", 0)
        with pytest.raises(ValueError, match="Workspace quota exceeded"):
            mgr.write_binary(ws, "keep.bin", b"overwrite-should-fail")
        assert (Path(ws) / "keep.bin").read_bytes() == original
