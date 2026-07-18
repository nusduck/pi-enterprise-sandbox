"""PR-07B: InternalFileReader unit tests (macOS-safe, no HTTP)."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from sandbox.services.internal_file_reader import (
    InternalFileReadError,
    InternalFileReader,
    _split_lf_lines,
)

WS = "01K0G2PAV8FPMVC9QHJG7JPN56"
LOGICAL = "/home/sandbox/workspace"


@pytest.fixture
def reader_tree(tmp_path: Path):
    root = tmp_path / "workspaces"
    root.mkdir()
    ws = root / WS
    ws.mkdir()
    r = InternalFileReader(workspaces_path=root, max_file_size_mb=1)
    return r, root, ws


def _lp(*parts: str) -> str:
    return LOGICAL + "/" + "/".join(parts)


class TestPathAndArgs:
    def test_rejects_relative_path(self, reader_tree) -> None:
        r, _root, _ws = reader_tree
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path="notes.txt",
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "PATH_INVALID"

    def test_rejects_workspace_root(self, reader_tree) -> None:
        r, _, _ = reader_tree
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=LOGICAL,
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "PATH_INVALID"

    def test_rejects_tmp(self, reader_tree) -> None:
        r, _, _ = reader_tree
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path="/tmp/x.txt",
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "PATH_INVALID"

    def test_rejects_skill(self, reader_tree) -> None:
        r, _, _ = reader_tree
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path="/home/sandbox/skill/a.md",
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "PATH_INVALID"

    def test_rejects_bool_offset(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "a.txt").write_text("a\n", encoding="utf-8")
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("a.txt"),
                offset=True,  # type: ignore[arg-type]
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "INVALID_ARGUMENT"

    def test_rejects_float_limit(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "a.txt").write_text("a\n", encoding="utf-8")
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("a.txt"),
                offset=0,
                limit=1.0,  # type: ignore[arg-type]
                max_bytes=100,
            )
        assert ei.value.code == "INVALID_ARGUMENT"

    def test_rejects_string_max_bytes(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "a.txt").write_text("a\n", encoding="utf-8")
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("a.txt"),
                offset=0,
                limit=10,
                max_bytes="100",  # type: ignore[arg-type]
            )
        assert ei.value.code == "INVALID_ARGUMENT"

    def test_offset_above_50000_js_safe_accepted(self, reader_tree) -> None:
        """Agent offset has no 50000 ceiling; only JS safe integer upper bound."""
        r, _, ws = reader_tree
        (ws / "a.txt").write_text("only\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("a.txt"),
            offset=60_000,
            limit=10,
            max_bytes=100,
        )
        assert out["content"] == ""
        assert out["offset"] == 60_000


class TestTextRead:
    def test_utf8_multibyte(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "u.txt").write_text("你好\n世界\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("u.txt"),
            offset=0,
            limit=10,
            max_bytes=1000,
        )
        assert out["binary"] is False
        assert out["content"] == "你好\n世界\n"
        assert out["truncated"] is False
        assert out["offset"] == 0
        assert out["path"] == _lp("u.txt")
        assert "content" in out
        # No physical path
        assert str(ws) not in str(out)

    def test_crlf_lf_lines(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "crlf.txt").write_bytes(b"a\r\nb\r\nc")
        out = r.read(
            workspace_id=WS,
            path=_lp("crlf.txt"),
            offset=0,
            limit=10,
            max_bytes=1000,
        )
        assert out["binary"] is False
        # LF split keeps \\r on the line body
        assert out["content"] == "a\r\nb\r\nc"
        assert out["returnedLines"] == 3

    def test_zero_based_offset(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "o.txt").write_text("L0\nL1\nL2\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("o.txt"),
            offset=1,
            limit=1,
            max_bytes=1000,
        )
        assert out["content"] == "L1\n"
        assert out["offset"] == 1
        assert out["returnedLines"] == 1
        assert out["nextOffset"] == 2
        assert out["truncated"] is True

    def test_eof_offset_past_end(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "e.txt").write_text("only\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("e.txt"),
            offset=5,
            limit=10,
            max_bytes=1000,
        )
        assert out["content"] == ""
        assert out["truncated"] is False
        assert out["returnedLines"] == 0

    def test_limit_truncation(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "t.txt").write_text("a\nb\nc\nd\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("t.txt"),
            offset=0,
            limit=2,
            max_bytes=1000,
        )
        assert out["content"] == "a\nb\n"
        assert out["truncated"] is True
        assert out["nextOffset"] == 2

    def test_max_bytes_hard_limit_no_half_line(self, reader_tree) -> None:
        r, _, ws = reader_tree
        # Each line is 5 bytes ("xxxx\n")
        (ws / "m.txt").write_text("aaaa\nbbbb\ncccc\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("m.txt"),
            offset=0,
            limit=10,
            max_bytes=7,  # fits first line (5), not second
        )
        assert out["content"] == "aaaa\n"
        assert out["truncated"] is True
        assert out["returnedLines"] == 1
        assert "\nbbbb" not in out["content"]

    def test_line_too_large(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "big.txt").write_text("x" * 50 + "\n", encoding="utf-8")
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("big.txt"),
                offset=0,
                limit=10,
                max_bytes=10,
            )
        assert ei.value.code == "FILE_LINE_TOO_LARGE"

    def test_multibyte_not_split_by_max_bytes(self, reader_tree) -> None:
        r, _, ws = reader_tree
        # "你" is 3 UTF-8 bytes; line "你\n" is 4 bytes
        (ws / "mb.txt").write_text("你\n好\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("mb.txt"),
            offset=0,
            limit=10,
            max_bytes=4,
        )
        assert out["content"] == "你\n"
        assert out["truncated"] is True
        # content is valid UTF-8
        out["content"].encode("utf-8")


class TestBinary:
    def test_nul_is_binary_no_content(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "bin.dat").write_bytes(b"abc\x00def")
        out = r.read(
            workspace_id=WS,
            path=_lp("bin.dat"),
            offset=0,
            limit=10,
            max_bytes=1000,
        )
        assert out["binary"] is True
        assert "content" not in out
        assert out["size"] == 7
        assert out["path"] == _lp("bin.dat")
        assert "mimeType" in out

    def test_invalid_utf8_is_binary(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "bad.bin").write_bytes(b"\xff\xfe\xfd")
        out = r.read(
            workspace_id=WS,
            path=_lp("bad.bin"),
            offset=0,
            limit=10,
            max_bytes=1000,
        )
        assert out["binary"] is True
        assert "content" not in out


class TestSecurityAndErrors:
    def test_missing_file(self, reader_tree) -> None:
        r, _, _ = reader_tree
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("gone.txt"),
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "FILE_NOT_FOUND"
        assert ei.value.code != "UNKNOWN"

    def test_leaf_symlink_rejected(self, reader_tree) -> None:
        r, root, ws = reader_tree
        outside = root.parent / "secret"
        outside.write_text("SECRET", encoding="utf-8")
        (ws / "l.txt").symlink_to(outside)
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("l.txt"),
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code in ("NOT_REGULAR_FILE", "FILE_NOT_FOUND")
        assert "SECRET" not in str(ei.value)
        assert str(root) not in str(ei.value)

    def test_fifo_not_hang(self, reader_tree) -> None:
        r, _, ws = reader_tree
        os.mkfifo(ws / "fifo")
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("fifo"),
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "NOT_REGULAR_FILE"

    def test_pathname_replace_after_open_reads_original(self, reader_tree) -> None:
        r, _, ws = reader_tree
        p = ws / "swap.txt"
        p.write_text("ONE\n", encoding="utf-8")

        def after_open(_fd: int) -> None:
            p.unlink()
            p.write_text("TWO\n", encoding="utf-8")

        out = r.read(
            workspace_id=WS,
            path=_lp("swap.txt"),
            offset=0,
            limit=10,
            max_bytes=100,
            after_open=after_open,
        )
        assert out["content"] == "ONE\n"

    def test_file_changed_during_read(self, reader_tree) -> None:
        r, _, ws = reader_tree
        p = ws / "chg.txt"
        p.write_text("stable\n", encoding="utf-8")

        def mutate(_fd: int) -> None:
            # Same-inode truncate+write via pathname while fd open.
            # (unlink+recreate would leave the open fd on the old inode.)
            with open(p, "w", encoding="utf-8") as f:
                f.write("mutated-content-longer\n")
                f.flush()
                os.fsync(f.fileno())

        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("chg.txt"),
                offset=0,
                limit=10,
                max_bytes=1000,
                before_second_fstat=mutate,
            )
        assert ei.value.code == "FILE_CHANGED_DURING_READ"

    def test_file_too_large(self, tmp_path: Path) -> None:
        root = tmp_path / "workspaces"
        root.mkdir()
        ws = root / WS
        ws.mkdir()
        # 1 MB max via reader config; write slightly over using max_file_size_mb=0
        # is invalid — use max_file_size_mb=1 and a file > 1MB is heavy; instead
        # set max_file_size_mb=1 and write 1MB+1 via smaller unit: use 1 and
        # create a 1MB+ file is slow. Patch via max_file_size_mb=1 with small
        # content by constructing reader that has max 1 byte via hack:
        # max_file_size_mb=1 means 1 MiB — for unit test inject reader with
        # private override after construct.
        r = InternalFileReader(workspaces_path=root, max_file_size_mb=1)
        r._max_file_bytes = 4  # type: ignore[attr-defined]
        (ws / "big.txt").write_text("12345", encoding="utf-8")
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("big.txt"),
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "FILE_TOO_LARGE"

    def test_workspace_not_created(self, tmp_path: Path) -> None:
        root = tmp_path / "workspaces"
        root.mkdir()
        r = InternalFileReader(workspaces_path=root, max_file_size_mb=1)
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("x.txt"),
                offset=0,
                limit=10,
                max_bytes=100,
            )
        assert ei.value.code == "FILE_NOT_FOUND"
        assert not (root / WS).exists()


class TestSplitLf:
    def test_basic(self) -> None:
        assert _split_lf_lines("a\nb\n") == ["a\n", "b\n"]
        assert _split_lf_lines("a\nb") == ["a\n", "b"]
        assert _split_lf_lines("") == []
        assert _split_lf_lines("solo") == ["solo"]


class TestStreamingMemory:
    """PR-07B Offline Batch C: bounded chunk streaming, no full-file buffers."""

    def test_utf8_multibyte_split_across_chunks(self, reader_tree) -> None:
        r, _, ws = reader_tree
        # "你" = e4 bd a0 — force 1-byte chunks so the codepoint spans reads.
        (ws / "u.txt").write_bytes("你好\n".encode("utf-8"))
        out = r.read(
            workspace_id=WS,
            path=_lp("u.txt"),
            offset=0,
            limit=10,
            max_bytes=1000,
            read_chunk_size=1,
        )
        assert out["binary"] is False
        assert out["content"] == "你好\n"
        assert out["returnedLines"] == 1

    def test_newline_split_across_chunks(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "nl.txt").write_bytes(b"a\r\nb\nc")
        out = r.read(
            workspace_id=WS,
            path=_lp("nl.txt"),
            offset=0,
            limit=10,
            max_bytes=1000,
            read_chunk_size=1,
        )
        assert out["binary"] is False
        assert out["content"] == "a\r\nb\nc"
        assert out["returnedLines"] == 3

    def test_late_nul_is_binary_not_text(self, reader_tree) -> None:
        r, _, ws = reader_tree
        # Valid UTF-8 prefix; NUL only in the second half.
        body = b"hello\nworld\n" + (b"x" * 100) + b"\x00" + b"tail"
        (ws / "late_nul.bin").write_bytes(body)
        out = r.read(
            workspace_id=WS,
            path=_lp("late_nul.bin"),
            offset=0,
            limit=10,
            max_bytes=1000,
            read_chunk_size=8,
        )
        assert out["binary"] is True
        assert "content" not in out
        assert out["size"] == len(body)

    def test_late_invalid_utf8_is_binary_not_text(self, reader_tree) -> None:
        r, _, ws = reader_tree
        body = b"line0\nline1\n" + (b"y" * 50) + b"\xff\xfe"
        (ws / "late_bad.bin").write_bytes(body)
        out = r.read(
            workspace_id=WS,
            path=_lp("late_bad.bin"),
            offset=0,
            limit=10,
            max_bytes=1000,
            read_chunk_size=7,
        )
        assert out["binary"] is True
        assert "content" not in out

    def test_overlong_first_line_chunked(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "long.txt").write_text("x" * 50 + "\nmore\n", encoding="utf-8")
        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("long.txt"),
                offset=0,
                limit=10,
                max_bytes=10,
                read_chunk_size=3,
            )
        assert ei.value.code == "FILE_LINE_TOO_LARGE"

    def test_large_file_chunk_requests_bounded_and_max_bytes(
        self, tmp_path: Path
    ) -> None:
        # 8 MiB of LF text (not sparse zeros — holes are NUL / binary).
        # Reader max file size must allow it; returned content still ≤ max_bytes.
        root = tmp_path / "workspaces"
        root.mkdir()
        ws = root / WS
        ws.mkdir()
        r = InternalFileReader(workspaces_path=root, max_file_size_mb=16)
        path = ws / "big8.txt"
        target = 8 * 1024 * 1024
        block = (b"x" * 80 + b"\n") * 1024  # ~81 KiB
        with open(path, "wb") as f:
            written = 0
            while written < target:
                n = min(len(block), target - written)
                f.write(block[:n])
                written += n

        chunk = 64 * 1024
        req_sizes: list[int] = []

        def tracking_read(fd: int, n: int) -> bytes:
            req_sizes.append(n)
            return os.read(fd, n)

        out = r.read(
            workspace_id=WS,
            path=_lp("big8.txt"),
            offset=0,
            limit=50_000,
            max_bytes=262_144,
            read_chunk_size=chunk,
            read_fn=tracking_read,
        )
        assert out["binary"] is False
        assert len(out["content"].encode("utf-8")) <= 262_144
        assert out["content"].startswith("x" * 80 + "\n")
        assert out["truncated"] is True
        assert req_sizes, "expected at least one read syscall"
        assert all(n <= chunk for n in req_sizes)
        assert all(n == chunk for n in req_sizes)
        assert out["size"] == target

    def test_offset_next_offset_contract_chunked(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "o.txt").write_text("L0\nL1\nL2\nL3\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("o.txt"),
            offset=1,
            limit=2,
            max_bytes=1000,
            read_chunk_size=2,
        )
        assert out["content"] == "L1\nL2\n"
        assert out["offset"] == 1
        assert out["returnedLines"] == 2
        assert out["nextOffset"] == 3
        assert out["truncated"] is True

    def test_file_changed_during_stream_still_detected(self, reader_tree) -> None:
        r, _, ws = reader_tree
        p = ws / "chg2.txt"
        p.write_text("stable\n", encoding="utf-8")

        def mutate(_fd: int) -> None:
            with open(p, "w", encoding="utf-8") as f:
                f.write("mutated-content-longer\n")
                f.flush()
                os.fsync(f.fileno())

        with pytest.raises(InternalFileReadError) as ei:
            r.read(
                workspace_id=WS,
                path=_lp("chg2.txt"),
                offset=0,
                limit=10,
                max_bytes=1000,
                before_second_fstat=mutate,
                read_chunk_size=2,
            )
        assert ei.value.code == "FILE_CHANGED_DURING_READ"

    def test_max_bytes_no_half_line_with_tiny_chunks(self, reader_tree) -> None:
        r, _, ws = reader_tree
        (ws / "m.txt").write_text("aaaa\nbbbb\ncccc\n", encoding="utf-8")
        out = r.read(
            workspace_id=WS,
            path=_lp("m.txt"),
            offset=0,
            limit=10,
            max_bytes=7,
            read_chunk_size=1,
        )
        assert out["content"] == "aaaa\n"
        assert out["truncated"] is True
        assert out["returnedLines"] == 1
        assert out["nextOffset"] == 1
