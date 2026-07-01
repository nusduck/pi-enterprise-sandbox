"""Tests for FileManager."""

import shutil
import tempfile
from pathlib import Path

import pytest
from sandbox.services.file_manager import FileManager


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
