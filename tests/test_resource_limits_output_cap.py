"""P0: run_with_timeout must retain O(cap) output, not buffer multi-MiB streams.

Also covers PR-07 hard RLIMIT inheritance, over-limit enforcement, fail-closed
apply, and parent-process non-pollution.
"""

from __future__ import annotations

import os
import resource
import signal
import sys
import time

import pytest

from sandbox.utils.resource_limits import (
    BoundedTextCapture,
    ResourceLimitError,
    apply_resource_limits,
    assert_production_resource_primitives,
    child_resource_limit_kwargs,
    missing_linux_resource_primitives,
    run_with_timeout,
    supported_rlimit_names,
)


def _pid_is_running(pid: int) -> bool:
    """True if ``pid`` still exists (signal 0 probe)."""
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _force_kill_pid(pid: int) -> None:
    if pid <= 0:
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError, OSError):
        pass

# Cap under test (1 KiB). Child must emit far more so unbounded buffering would
# be obvious via retained_chars / parts growth and return lengths.
_CAP = 1024
# At least tens of MiB of pipe traffic (not stored by the parent).
_OUTPUT_MIB = 32
_OUTPUT_BYTES = _OUTPUT_MIB * 1024 * 1024
_TIMEOUT = 60


def _py_write_stream(stream: str, nbytes: int) -> list[str]:
    """python -c that writes ``nbytes`` of 'x' to stdout or stderr then exits 0."""
    if stream == "stdout":
        body = (
            f"import sys; n={nbytes}; b=b'x'*65536; "
            f"w=sys.stdout.buffer.write; "
            f"[w(b) for _ in range(n//65536)]; "
            f"w(b'x'*(n%65536)); sys.stdout.buffer.flush()"
        )
    elif stream == "stderr":
        body = (
            f"import sys; n={nbytes}; b=b'x'*65536; "
            f"w=sys.stderr.buffer.write; "
            f"[w(b) for _ in range(n//65536)]; "
            f"w(b'x'*(n%65536)); sys.stderr.buffer.flush()"
        )
    else:
        raise ValueError(stream)
    return [sys.executable, "-c", body]


def _py_write_both(nbytes_each: int) -> list[str]:
    return [
        sys.executable,
        "-c",
        (
            f"import sys; n={nbytes_each}; b=b'x'*65536; "
            f"wo=sys.stdout.buffer.write; we=sys.stderr.buffer.write; "
            f"[ (wo(b), we(b)) for _ in range(n//65536) ]; "
            f"wo(b'x'*(n%65536)); we(b'x'*(n%65536)); "
            f"sys.stdout.buffer.flush(); sys.stderr.buffer.flush()"
        ),
    ]


def _assert_bounded(
    result: dict,
    stats: dict,
    *,
    expect_stdout_trunc: bool,
    expect_stderr_trunc: bool,
    cap: int = _CAP,
) -> None:
    assert result["truncated"] is True
    assert len(result["stdout_preview"]) <= cap
    assert len(result["stderr_preview"]) <= cap
    assert stats["stdout"]["retained_chars"] <= cap
    assert stats["stderr"]["retained_chars"] <= cap
    assert stats["stdout"]["forwarded_chars"] <= cap
    assert stats["stderr"]["forwarded_chars"] <= cap
    # Retained storage is O(cap): parts hold only the prefix.
    assert stats["stdout"]["retained_chars"] == len(result["stdout_preview"])
    assert stats["stderr"]["retained_chars"] == len(result["stderr_preview"])

    if expect_stdout_trunc:
        assert stats["stdout"]["truncated"] is True
        assert stats["stdout"]["total_seen_chars"] > cap
        assert len(result["stdout_preview"]) == cap
        assert result["stdout_preview"] == "x" * cap
    if expect_stderr_trunc:
        assert stats["stderr"]["truncated"] is True
        assert stats["stderr"]["total_seen_chars"] > cap
        assert len(result["stderr_preview"]) == cap
        assert result["stderr_preview"] == "x" * cap


class TestBoundedTextCapture:
    def test_feed_prefix_and_hard_cap(self):
        c = BoundedTextCapture(8)
        assert c.feed("abcd") == "abcd"
        assert c.feed("efghij") == "efgh"
        assert c.truncated is True
        assert c.feed("more") == ""
        assert c.getvalue() == "abcdefgh"
        assert c.retained_chars == 8
        assert c.total_seen_chars == 4 + 6 + 4
        assert c.forwarded_chars == 8

    def test_zero_cap_forwards_nothing(self):
        c = BoundedTextCapture(0)
        assert c.feed("hello") == ""
        assert c.truncated is True
        assert c.getvalue() == ""
        assert c.retained_chars == 0


class TestRunWithTimeoutOutputCap:
    """Large-output children must not grow parent retention beyond cap."""

    @pytest.mark.parametrize("with_callback", [False, True])
    def test_stdout_only_large_output_bounded(self, with_callback: bool):
        stats: dict = {}
        forwarded: list[str] = []

        def on_output(stream: str, text: str) -> None:
            forwarded.append(text)
            # Naive re-accumulation — still must stay O(cap) because feed bounds it.
            assert stream == "stdout"

        result = run_with_timeout(
            _py_write_stream("stdout", _OUTPUT_BYTES),
            timeout=_TIMEOUT,
            max_output_chars=_CAP,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            on_output=on_output if with_callback else None,
            capture_stats=stats,
        )
        assert result["exit_code"] == 0
        _assert_bounded(
            result, stats, expect_stdout_trunc=True, expect_stderr_trunc=False
        )
        assert result["stderr_preview"] == ""
        if with_callback:
            assert sum(len(t) for t in forwarded) == _CAP
            assert "".join(forwarded) == "x" * _CAP

    @pytest.mark.parametrize("with_callback", [False, True])
    def test_stderr_only_large_output_bounded(self, with_callback: bool):
        stats: dict = {}
        forwarded_len = 0

        def on_output(stream: str, text: str) -> None:
            nonlocal forwarded_len
            assert stream == "stderr"
            forwarded_len += len(text)

        result = run_with_timeout(
            _py_write_stream("stderr", _OUTPUT_BYTES),
            timeout=_TIMEOUT,
            max_output_chars=_CAP,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            on_output=on_output if with_callback else None,
            capture_stats=stats,
        )
        assert result["exit_code"] == 0
        _assert_bounded(
            result, stats, expect_stdout_trunc=False, expect_stderr_trunc=True
        )
        assert result["stdout_preview"] == ""
        if with_callback:
            assert forwarded_len == _CAP

    @pytest.mark.parametrize("with_callback", [False, True])
    def test_both_streams_large_output_bounded(self, with_callback: bool):
        stats: dict = {}
        forwarded = {"stdout": 0, "stderr": 0}

        def on_output(stream: str, text: str) -> None:
            forwarded[stream] = forwarded.get(stream, 0) + len(text)

        result = run_with_timeout(
            _py_write_both(_OUTPUT_BYTES),
            timeout=_TIMEOUT,
            max_output_chars=_CAP,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            on_output=on_output if with_callback else None,
            capture_stats=stats,
        )
        assert result["exit_code"] == 0
        _assert_bounded(
            result, stats, expect_stdout_trunc=True, expect_stderr_trunc=True
        )
        if with_callback:
            assert forwarded["stdout"] == _CAP
            assert forwarded["stderr"] == _CAP

    def test_utf8_multibyte_prefix_is_valid(self):
        """Truncation must not return invalid UTF-16 surrogates / half chars."""
        # Each '€' is one Unicode code point (3 UTF-8 bytes). Cap mid-stream.
        stats: dict = {}
        n_chars = 5000
        result = run_with_timeout(
            [
                sys.executable,
                "-c",
                f"import sys; sys.stdout.write({'€'!r} * {n_chars}); sys.stdout.flush()",
            ],
            timeout=_TIMEOUT,
            max_output_chars=_CAP,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            capture_stats=stats,
        )
        assert result["exit_code"] == 0
        assert result["truncated"] is True
        preview = result["stdout_preview"]
        assert len(preview) == _CAP
        assert preview == "€" * _CAP
        # Round-trip encode must succeed (no lone surrogates / broken text).
        preview.encode("utf-8")
        assert stats["stdout"]["retained_chars"] == _CAP
        assert stats["stdout"]["total_seen_chars"] == n_chars

    def test_small_output_not_truncated(self):
        stats: dict = {}
        result = run_with_timeout(
            [sys.executable, "-c", "print('hello-cap', end='')"],
            timeout=_TIMEOUT,
            max_output_chars=_CAP,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            capture_stats=stats,
        )
        assert result["exit_code"] == 0
        assert result["truncated"] is False
        assert result["stdout_preview"] == "hello-cap"
        assert stats["stdout"]["retained_chars"] == len("hello-cap")
        assert stats["stdout"]["total_seen_chars"] == len("hello-cap")

    def test_timeout_still_drains_and_kills(self):
        """After cap, process wait/timeout + process-group kill still work."""
        stats: dict = {}
        # Child floods stdout forever; parent must cap, then kill on timeout.
        result = run_with_timeout(
            [
                sys.executable,
                "-c",
                (
                    "import sys, time\n"
                    "b=b'x'*65536\n"
                    "while True:\n"
                    "    sys.stdout.buffer.write(b)\n"
                    "    sys.stdout.buffer.flush()\n"
                ),
            ],
            timeout=2,
            max_output_chars=_CAP,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            capture_stats=stats,
        )
        assert result["exit_code"] == -signal.SIGKILL
        assert result["truncated"] is True
        assert len(result["stdout_preview"]) == _CAP
        assert stats["stdout"]["retained_chars"] == _CAP
        assert stats["stdout"]["total_seen_chars"] > _CAP
        assert stats.get("readers_alive") is False

    def test_orphan_descendant_writer_reaped_after_leader_exit(self, tmp_path):
        """Leader exits 0 while a forked child keeps writing on inherited stdout.

        Readers would hang forever if we only wait on the leader and join with
        a short timeout. The saved process group must be TERM/KILL'd even when
        the leader is already reaped.
        """
        pid_file = tmp_path / "bg_writer.pid"
        # Child stays in the leader's process group (no second setsid). Ignore
        # SIGHUP so session-leader exit does not silently reap the writer before
        # we assert group cleanup.
        child_src = f"""
import os, signal, sys
signal.signal(signal.SIGHUP, signal.SIG_IGN)
pid = os.fork()
if pid == 0:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    b = b'x' * 65536
    while True:
        try:
            sys.stdout.buffer.write(b)
            sys.stdout.buffer.flush()
        except Exception:
            break
    os._exit(0)
with open({str(pid_file)!r}, 'w') as f:
    f.write(str(pid))
    f.flush()
    os.fsync(f.fileno())
sys.exit(0)
"""
        bg_pid: int | None = None
        stats: dict = {}
        t0 = time.monotonic()
        try:
            result = run_with_timeout(
                [sys.executable, "-c", child_src],
                timeout=30,
                max_output_chars=_CAP,
                max_process_count=0,
                max_memory_mb=0,
                max_cpu_seconds=0,
                capture_stats=stats,
            )
            elapsed = time.monotonic() - t0
            # Must not hang for the full wall timeout waiting on orphan writers.
            assert elapsed < 15.0, f"run_with_timeout hung ({elapsed:.1f}s)"
            assert result["truncated"] is True
            assert len(result["stdout_preview"]) == _CAP
            assert result["stdout_preview"] == "x" * _CAP
            assert stats["stdout"]["retained_chars"] == _CAP
            assert stats["stdout"]["total_seen_chars"] > _CAP
            assert stats.get("readers_alive") is False
            # Leader exited cleanly; cleanup of descendants is separate.
            assert result["exit_code"] == 0

            # Background writer pid recorded by the leader before exit.
            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and not pid_file.exists():
                time.sleep(0.01)
            assert pid_file.exists(), "leader never wrote bg pid file"
            bg_pid = int(pid_file.read_text().strip())
            assert bg_pid > 0

            # Allow a brief moment for SIGKILL to land, then require dead.
            dead_deadline = time.monotonic() + 3.0
            while time.monotonic() < dead_deadline and _pid_is_running(bg_pid):
                time.sleep(0.05)
            assert not _pid_is_running(bg_pid), f"orphan writer pid {bg_pid} still running"
        finally:
            # Fail-safe: never leave a flooder on the machine.
            if bg_pid is None and pid_file.exists():
                try:
                    bg_pid = int(pid_file.read_text().strip())
                except ValueError:
                    bg_pid = None
            if bg_pid is not None:
                _force_kill_pid(bg_pid)
            # Also try the captured group if still present.
            pgid = stats.get("pgid")
            if isinstance(pgid, int) and pgid > 0:
                try:
                    if pgid != os.getpgrp():
                        os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    pass

    def test_escaped_setsid_descendant_cannot_hang_run_with_timeout(self, tmp_path):
        """Descendant that setsid() escapes original pgid and keeps writing.

        Killing the original process group is a no-op for the escapee; readers
        must still stop under a hard bound (poll + request_stop), not bare join.
        """
        pid_file = tmp_path / "escaped_writer.pid"
        child_src = f"""
import os, signal, sys
signal.signal(signal.SIGHUP, signal.SIG_IGN)
pid = os.fork()
if pid == 0:
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    try:
        os.setsid()  # leave leader process group
    except OSError:
        pass
    b = b'x' * 65536
    while True:
        try:
            sys.stdout.buffer.write(b)
            sys.stdout.buffer.flush()
        except Exception:
            break
    os._exit(0)
with open({str(pid_file)!r}, 'w') as f:
    f.write(str(pid))
    f.flush()
    os.fsync(f.fileno())
# Give the child a moment to setsid + start writing, then leader exits 0.
import time
time.sleep(0.15)
sys.exit(0)
"""
        bg_pid: int | None = None
        stats: dict = {}
        t0 = time.monotonic()
        try:
            result = run_with_timeout(
                [sys.executable, "-c", child_src],
                timeout=30,
                max_output_chars=_CAP,
                max_process_count=0,
                max_memory_mb=0,
                max_cpu_seconds=0,
                capture_stats=stats,
            )
            elapsed = time.monotonic() - t0
            # Must return well under wall timeout even though escapee still runs.
            assert elapsed < 20.0, f"run_with_timeout hung ({elapsed:.1f}s)"
            assert result["truncated"] is True
            assert len(result["stdout_preview"]) == _CAP
            assert stats["stdout"]["retained_chars"] == _CAP
            assert stats.get("readers_alive") is False
            assert result["exit_code"] == 0

            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline and not pid_file.exists():
                time.sleep(0.01)
            assert pid_file.exists()
            bg_pid = int(pid_file.read_text().strip())
            assert bg_pid > 0
            # Escapee may still be alive (intentionally not in original pgid).
            # Parent must not hang; cleanup is the test's responsibility.
        finally:
            if bg_pid is None and pid_file.exists():
                try:
                    bg_pid = int(pid_file.read_text().strip())
                except ValueError:
                    bg_pid = None
            if bg_pid is not None:
                # Kill the escaped session by its own pgid (child is session leader).
                try:
                    os.killpg(bg_pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    _force_kill_pid(bg_pid)
                # Wait briefly so we don't leave zombies confusing later probes.
                dead_deadline = time.monotonic() + 2.0
                while time.monotonic() < dead_deadline and _pid_is_running(bg_pid):
                    time.sleep(0.05)
                _force_kill_pid(bg_pid)


# ── PR-07 hard RLIMIT: inheritance / over-limit / fail-closed / no pollution ─


def _parent_rlimit_snapshot() -> dict[str, tuple[int, int]]:
    """Capture parent soft/hard for limits we may touch (must stay unchanged)."""
    out: dict[str, tuple[int, int]] = {}
    for name in (
        "RLIMIT_CPU",
        "RLIMIT_AS",
        "RLIMIT_FSIZE",
        "RLIMIT_NOFILE",
        "RLIMIT_NPROC",
    ):
        if not hasattr(resource, name):
            continue
        try:
            out[name] = resource.getrlimit(getattr(resource, name))
        except (ValueError, OSError, resource.error):
            pass
    return out


class TestResourceLimitPrimitives:
    def test_supported_rlimit_names_include_core_set(self):
        names = supported_rlimit_names()
        # macOS and Linux both expose these; required for offline suite.
        for required in (
            "RLIMIT_CPU",
            "RLIMIT_AS",
            "RLIMIT_FSIZE",
            "RLIMIT_NOFILE",
        ):
            assert required in names

    def test_missing_linux_primitives_noop_on_non_linux(self):
        assert missing_linux_resource_primitives(platform="darwin") == []
        assert missing_linux_resource_primitives(platform="win32") == []

    def test_assert_production_primitives_noop_on_non_linux(self):
        assert_production_resource_primitives(platform="darwin")  # no raise

    def test_assert_production_primitives_fails_when_linux_missing(self, monkeypatch):
        monkeypatch.setattr(
            "sandbox.utils.resource_limits.supported_rlimit_names",
            lambda: frozenset(
                {"RLIMIT_CPU", "RLIMIT_AS", "RLIMIT_FSIZE", "RLIMIT_NPROC"}
            ),
        )
        with pytest.raises(ResourceLimitError, match="RLIMIT_NOFILE"):
            assert_production_resource_primitives(platform="linux")


class TestApplyResourceLimitsUnit:
    def test_fail_closed_raises_when_setrlimit_fails(self, monkeypatch):
        def _boom(*_a, **_k):
            raise OSError("simulated setrlimit denial")

        monkeypatch.setattr(resource, "setrlimit", _boom)
        with pytest.raises(ResourceLimitError, match="could not be applied"):
            apply_resource_limits(
                max_file_size_mb=1,
                max_open_files=32,
                fail_closed=True,
                new_session=False,
            )

    def test_best_effort_swallows_when_not_fail_closed(self, monkeypatch):
        def _boom(*_a, **_k):
            raise OSError("simulated setrlimit denial")

        monkeypatch.setattr(resource, "setrlimit", _boom)
        apply_resource_limits(
            max_file_size_mb=1,
            max_open_files=32,
            fail_closed=False,
            new_session=False,
        )  # no raise

    def test_zero_means_skip_limit(self, monkeypatch):
        calls: list[tuple] = []

        def _spy(res, lim):
            calls.append((res, lim))

        monkeypatch.setattr(resource, "setrlimit", _spy)
        apply_resource_limits(
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            max_file_size_mb=0,
            max_open_files=0,
            fail_closed=True,
            new_session=False,
        )
        assert calls == []

    def test_units_mb_to_bytes_for_as_and_fsize(self, monkeypatch):
        calls: dict[int, tuple[int, int]] = {}

        def _spy(res, lim):
            calls[res] = lim

        monkeypatch.setattr(resource, "setrlimit", _spy)
        # Avoid NPROC getrlimit path complexity
        apply_resource_limits(
            max_memory_mb=2,
            max_file_size_mb=3,
            max_open_files=64,
            max_cpu_seconds=10,
            fail_closed=True,
            new_session=False,
        )
        assert calls[resource.RLIMIT_AS] == (2 * 1024 * 1024, 2 * 1024 * 1024)
        assert calls[resource.RLIMIT_FSIZE] == (3 * 1024 * 1024, 3 * 1024 * 1024)
        assert calls[resource.RLIMIT_NOFILE] == (64, 64)
        assert calls[resource.RLIMIT_CPU] == (10, 40)

    def test_child_resource_limit_kwargs_from_settings(self):
        class _S:
            max_process_count = 11
            max_memory_mb = 22
            max_cpu_time_seconds = 33
            max_file_size_mb = 44
            max_open_files = 55
            is_production = True

        kw = child_resource_limit_kwargs(_S())
        assert kw == {
            "max_process_count": 11,
            "max_memory_mb": 22,
            "max_cpu_seconds": 33,
            "max_file_size_mb": 44,
            "max_open_files": 55,
            "fail_closed": True,
        }


class TestHardLimitInheritance:
    """Child must inherit rlimits set in preexec before exec."""

    def test_nofile_and_fsize_inherited_by_child(self):
        parent_before = _parent_rlimit_snapshot()
        # Modest limits that still allow python to start and print.
        nofile = 64
        fsize_mb = 1
        probe = (
            "import resource, json\n"
            "out = {\n"
            f"  'nofile': resource.getrlimit(resource.RLIMIT_NOFILE),\n"
            f"  'fsize': resource.getrlimit(resource.RLIMIT_FSIZE),\n"
            "}\n"
            "print(json.dumps(out), end='')\n"
        )
        result = run_with_timeout(
            [sys.executable, "-c", probe],
            timeout=15,
            max_output_chars=4_000,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            max_file_size_mb=fsize_mb,
            max_open_files=nofile,
            fail_closed=False,
        )
        assert result["exit_code"] == 0, result["stderr_preview"]
        import json

        data = json.loads(result["stdout_preview"])
        assert data["nofile"][0] == nofile
        assert data["nofile"][1] == nofile
        expected_fsize = fsize_mb * 1024 * 1024
        assert data["fsize"][0] == expected_fsize
        assert data["fsize"][1] == expected_fsize
        # Parent service process must not be polluted.
        parent_after = _parent_rlimit_snapshot()
        for key, before in parent_before.items():
            assert parent_after.get(key) == before, f"parent {key} polluted"


class TestHardLimitOverLimit:
    """Requested limits must actually constrain child I/O when platform allows."""

    def test_fsize_blocks_oversized_write(self, tmp_path):
        # Write 2 MiB under RLIMIT_FSIZE=1 MiB → expect non-zero exit / OSError.
        target = tmp_path / "big.bin"
        child = (
            "import os, sys\n"
            f"path = {str(target)!r}\n"
            "try:\n"
            "    with open(path, 'wb') as f:\n"
            "        f.write(b'x' * (2 * 1024 * 1024))\n"
            "        f.flush()\n"
            "        os.fsync(f.fileno())\n"
            "    sys.exit(0)\n"
            "except OSError as e:\n"
            "    print(type(e).__name__, e.errno, file=sys.stderr)\n"
            "    sys.exit(42)\n"
        )
        result = run_with_timeout(
            [sys.executable, "-c", child],
            timeout=15,
            max_output_chars=4_000,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            max_file_size_mb=1,
            max_open_files=0,
            fail_closed=False,
        )
        # Kernel should deliver SIGXFSZ or OSError(EFBIG). Accept either
        # non-zero exit; never silent success with a full 2 MiB file.
        if result["exit_code"] == 0:
            # Some platforms (rare) ignore FSIZE for this write path — document
            # as soft skip only when file truly exceeded (should not happen).
            size = target.stat().st_size if target.exists() else 0
            assert size <= 1024 * 1024, (
                f"RLIMIT_FSIZE bypassed: wrote {size} bytes under 1MiB cap"
            )
        else:
            assert result["exit_code"] != 0
            if target.exists():
                assert target.stat().st_size <= 1024 * 1024 + 4096

    def test_nofile_blocks_excess_opens(self):
        # Soft limit 32; open 64 files → should fail before completing.
        child = (
            "import sys\n"
            "fds = []\n"
            "try:\n"
            "    for i in range(64):\n"
            "        fds.append(open('/dev/null', 'rb'))\n"
            "    print('opened', len(fds))\n"
            "    sys.exit(0)\n"
            "except OSError as e:\n"
            "    print('OSError', e.errno, len(fds), file=sys.stderr)\n"
            "    sys.exit(42)\n"
            "finally:\n"
            "    for f in fds:\n"
            "        try:\n"
            "            f.close()\n"
            "        except Exception:\n"
            "            pass\n"
        )
        result = run_with_timeout(
            [sys.executable, "-c", child],
            timeout=15,
            max_output_chars=4_000,
            max_process_count=0,
            max_memory_mb=0,
            max_cpu_seconds=0,
            max_file_size_mb=0,
            max_open_files=32,
            fail_closed=False,
        )
        # Must not open all 64 under NOFILE=32 (stdin/out/err + interpreter FDs
        # already consume several slots).
        if result["exit_code"] == 0:
            assert "opened 64" not in result["stdout_preview"]
        else:
            assert result["exit_code"] == 42
            assert "OSError" in result["stderr_preview"]


class TestRunWithTimeoutFailClosedSpawn:
    def test_spawn_returns_error_when_fail_closed_and_apply_fails(self, monkeypatch):
        def _boom(*_a, **_k):
            raise ResourceLimitError("forced apply failure")

        monkeypatch.setattr(
            "sandbox.utils.resource_limits.apply_resource_limits",
            _boom,
        )
        result = run_with_timeout(
            [sys.executable, "-c", "print('should-not-run')"],
            timeout=5,
            max_output_chars=100,
            max_file_size_mb=1,
            fail_closed=True,
        )
        assert result["exit_code"] == -1
        assert "should-not-run" not in result["stdout_preview"]
        assert "Resource limit" in result["stderr_preview"] or "forced" in result[
            "stderr_preview"
        ]
