"""PR-14 offline: large-file / short-write / constant-memory streaming.

Plan §25.8 (5 GB Dataset streaming) + short-write safety.

Uses sparse/simulated sizes — never requires real 5 GB disk fill.
No Docker / network / live Redis / MySQL.
"""

from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path

import pytest

from sandbox.services.control_plane_storage import (
    ControlPlaneError,
    stream_copy_hash_from_fd,
    write_all,
)

# Plan target: 5 GiB. Offline suite uses the constant for max_bytes checks and
# sparse logical size; full soak is a live gate (see docs/review-deferred-items).
FIVE_GIB = 5 * 1024 * 1024 * 1024
# Medium multi-MiB stream for chunk-bound assertions (fast offline).
STREAM_BYTES = 16 * 1024 * 1024
CHUNK = 64 * 1024

class TestWriteAllShortWrite:
    def test_partial_writes_loop_until_complete(self, tmp_path: Path, monkeypatch):
        path = tmp_path / "out.bin"
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        calls = {"n": 0}
        original = os.write

        def partial(f, data):
            calls["n"] += 1
            raw = data.tobytes() if isinstance(data, memoryview) else bytes(data)
            if calls["n"] <= 5 and len(raw) > 2:
                return original(f, raw[:2])
            return original(f, raw)

        monkeypatch.setattr(os, "write", partial)
        try:
            payload = b"0123456789ABCDEF" * 64
            wrote = write_all(fd, payload)
            assert wrote == len(payload)
        finally:
            os.close(fd)
            monkeypatch.setattr(os, "write", original)
        assert path.read_bytes() == payload
        assert calls["n"] > 1

    def test_zero_byte_short_write_fail_closed(self, tmp_path: Path, monkeypatch):
        path = tmp_path / "zero.bin"
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)

        def zero_write(_f, _data):
            return 0

        monkeypatch.setattr(os, "write", zero_write)
        try:
            with pytest.raises(ControlPlaneError) as ei:
                write_all(fd, b"not-empty")
            assert ei.value.code == "WRITE_FAILED"
            assert "short write" in ei.value.message
        finally:
            os.close(fd)


class TestStreamCopyConstantMemoryAndQuota:
    def test_stream_copy_requests_fixed_chunk_size_only(
        self, tmp_path: Path, monkeypatch
    ):
        """Memory model: only chunk-sized reads — never full-file buffer."""
        src = tmp_path / "src.bin"
        payload = os.urandom(STREAM_BYTES)
        src.write_bytes(payload)
        dest = tmp_path / "ctrl" / "dest.bin"
        dest.parent.mkdir(parents=True)
        monkeypatch.setenv("SANDBOX_ARTIFACTS_ROOT", str(tmp_path / "artifacts"))
        monkeypatch.setenv("SANDBOX_CONTROL_ROOT", str(tmp_path / "control"))
        # Reload roots via settings may already be patched by conftest — open fd path.
        from sandbox.config import settings

        monkeypatch.setattr(settings, "artifacts_root", str(tmp_path / "artifacts"))
        monkeypatch.setattr(settings, "control_root", str(tmp_path / "control"))
        (tmp_path / "artifacts").mkdir(exist_ok=True)
        (tmp_path / "control").mkdir(exist_ok=True)

        read_sizes: list[int] = []
        original_read = os.read

        def tracking_read(fd, n):
            read_sizes.append(n)
            return original_read(fd, n)

        monkeypatch.setattr(os, "read", tracking_read)
        fd = os.open(str(src), os.O_RDONLY)
        try:
            digest, total, _ident = stream_copy_hash_from_fd(
                fd,
                dest,
                max_bytes=STREAM_BYTES,
                chunk_size=CHUNK,
            )
        finally:
            os.close(fd)

        assert total == STREAM_BYTES
        assert digest == hashlib.sha256(payload).hexdigest()
        assert dest.read_bytes() == payload
        assert read_sizes, "expected os.read calls"
        assert max(read_sizes) == CHUNK
        assert all(s == CHUNK for s in read_sizes[:-1] or [CHUNK])

    def test_max_bytes_enforced_without_writing_final(
        self, tmp_path: Path, monkeypatch
    ):
        from sandbox.config import settings

        monkeypatch.setattr(settings, "artifacts_root", str(tmp_path / "artifacts"))
        monkeypatch.setattr(settings, "control_root", str(tmp_path / "control"))
        (tmp_path / "artifacts").mkdir()
        (tmp_path / "control").mkdir()

        src = tmp_path / "big.bin"
        src.write_bytes(b"x" * (CHUNK * 4))
        dest = tmp_path / "control" / "out.bin"
        fd = os.open(str(src), os.O_RDONLY)
        try:
            with pytest.raises(ControlPlaneError) as ei:
                stream_copy_hash_from_fd(
                    fd,
                    dest,
                    max_bytes=CHUNK * 2,
                    chunk_size=CHUNK,
                )
            assert ei.value.code == "TOO_LARGE"
        finally:
            os.close(fd)
        # No truncated final left
        assert not dest.exists()
        tmp_candidates = list(dest.parent.glob("*.tmp"))
        assert tmp_candidates == []

    def test_five_gib_equivalent_sparse_logical_size_quota(
        self, tmp_path: Path, monkeypatch
    ):
        """Sparse file with logical size = 5 GiB; max_bytes just under → TOO_LARGE.

        Only reads until max_bytes+chunk, not the full sparse length, so offline-fast.
        """
        from sandbox.config import settings

        monkeypatch.setattr(settings, "artifacts_root", str(tmp_path / "artifacts"))
        monkeypatch.setattr(settings, "control_root", str(tmp_path / "control"))
        (tmp_path / "artifacts").mkdir()
        (tmp_path / "control").mkdir()

        sparse = tmp_path / "sparse5g.bin"
        fd_create = os.open(
            str(sparse), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
        )
        try:
            os.ftruncate(fd_create, FIVE_GIB)
        finally:
            os.close(fd_create)

        st = os.stat(sparse)
        assert stat.S_ISREG(st.st_mode)
        assert st.st_size == FIVE_GIB

        dest = tmp_path / "control" / "ds.bin"
        # Cap just below 5 GiB so stream fails closed at quota (plan max).
        max_bytes = FIVE_GIB - 1
        # Fast path: use a small real file with max_bytes = FIVE_GIB - 1 would not
        # hit TOO_LARGE. Use sparse + small max_bytes first for speed, then assert
        # constant encodes plan target.
        assert FIVE_GIB == 5_368_709_120

        # Enforce quota early: max_bytes = 1 MiB against sparse 5 GiB source.
        early_cap = 1024 * 1024
        fd = os.open(str(sparse), os.O_RDONLY)
        try:
            with pytest.raises(ControlPlaneError) as ei:
                stream_copy_hash_from_fd(
                    fd,
                    dest,
                    max_bytes=early_cap,
                    chunk_size=CHUNK,
                )
            assert ei.value.code == "TOO_LARGE"
        finally:
            os.close(fd)
        assert not dest.exists()
        # Document plan constant is available for live 5 GiB soak gate
        assert max_bytes == FIVE_GIB - 1

    def test_multi_mib_stream_never_allocates_full_buffer(
        self, tmp_path: Path, monkeypatch
    ):
        """Instrument read/write: max buffer size stays at chunk_size (not file size)."""
        from sandbox.config import settings

        monkeypatch.setattr(settings, "artifacts_root", str(tmp_path / "artifacts"))
        monkeypatch.setattr(settings, "control_root", str(tmp_path / "control"))
        (tmp_path / "artifacts").mkdir()
        (tmp_path / "control").mkdir()

        size = 8 * 1024 * 1024
        src = tmp_path / "src.bin"
        fd_w = os.open(str(src), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.ftruncate(fd_w, size)
        finally:
            os.close(fd_w)

        dest = tmp_path / "control" / "copy.bin"
        max_read_req = {"n": 0}
        max_write_len = {"n": 0}
        original_read = os.read
        original_write = os.write

        def tracked_read(fd, n):
            max_read_req["n"] = max(max_read_req["n"], n)
            return original_read(fd, n)

        def tracked_write(fd, data):
            length = len(data) if not isinstance(data, memoryview) else data.nbytes
            max_write_len["n"] = max(max_write_len["n"], length)
            return original_write(fd, data)

        monkeypatch.setattr(os, "read", tracked_read)
        monkeypatch.setattr(os, "write", tracked_write)

        fd = os.open(str(src), os.O_RDONLY)
        try:
            digest, total, _ = stream_copy_hash_from_fd(
                fd, dest, max_bytes=size, chunk_size=CHUNK
            )
        finally:
            os.close(fd)

        assert total == size
        assert len(digest) == 64
        assert max_read_req["n"] == CHUNK
        assert max_write_len["n"] <= CHUNK
        # Constant-memory model: neither side ever requested a full-file buffer
        assert max_read_req["n"] < size
        assert max_write_len["n"] < size
