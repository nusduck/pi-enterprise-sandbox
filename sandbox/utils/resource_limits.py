"""Resource limits helper — per-child RLIMIT / subprocess resource control.

Hard limits are applied **only** in the forked child via ``preexec_fn`` before
``exec``. Never call :func:`apply_resource_limits` on the service process —
that would pollute the Sandbox API with untrusted-workload caps.
"""

from __future__ import annotations

import os
import re
import resource
import signal
import subprocess
import sys
import time
from typing import Any

# ── Network command detection ──────────────────────────────────────

NETWORK_COMMANDS = [
    "curl",
    "wget",
    "pip install",
    "pip3 install",
    "python -m pip install",
    "python3 -m pip install",
    "npm install",
    "npm i ",
    "npm ci",
    "yarn add",
    "yarn install",
    "pnpm add",
    "pnpm install",
    "nc",
    "telnet",
    "ssh",
    "ftp",
    "sftp",
    "rsync",
    "scp",
]


def contains_network_command(command: str) -> bool:
    """Check if a command string contains network-related commands.

    Used to enforce ``default_deny_network`` at the subprocess level.
    """
    cmd_lower = command.lower().strip()

    for net_cmd in NETWORK_COMMANDS:
        if " " in net_cmd:
            if net_cmd in cmd_lower:
                return True
            continue
        # Single-word tools must be shell tokens. A raw substring check makes
        # harmless source such as ``nc=len(rows)`` look like a netcat call.
        pattern = rf"(?:^|[\s;&|()]){re.escape(net_cmd)}(?=$|[\s;&|()])"
        if re.search(pattern, cmd_lower):
            return True

    return False


# ── RLIMIT primitives ───────────────────────────────────────────────

class ResourceLimitError(RuntimeError):
    """Resource limits could not be applied (fail-closed when required)."""


# Critical primitives for production Linux child isolation. NPROC is Linux
# (and macOS) specific; Windows / exotic platforms omit it.
_CRITICAL_RLIMIT_NAMES_BASE: tuple[str, ...] = (
    "RLIMIT_CPU",
    "RLIMIT_AS",
    "RLIMIT_FSIZE",
    "RLIMIT_NOFILE",
)
_CRITICAL_RLIMIT_NAMES_LINUX: tuple[str, ...] = (
    *_CRITICAL_RLIMIT_NAMES_BASE,
    "RLIMIT_NPROC",
)


def supported_rlimit_names() -> frozenset[str]:
    """Return ``RLIMIT_*`` names available on this interpreter/platform."""
    names: list[str] = []
    for name in (
        "RLIMIT_CPU",
        "RLIMIT_AS",
        "RLIMIT_FSIZE",
        "RLIMIT_NOFILE",
        "RLIMIT_NPROC",
        "RLIMIT_CORE",
        "RLIMIT_DATA",
        "RLIMIT_STACK",
    ):
        if hasattr(resource, name):
            names.append(name)
    return frozenset(names)


def missing_linux_resource_primitives(
    platform: str | None = None,
) -> list[str]:
    """Names required on production Linux that are absent from ``resource``."""
    plat = platform if platform is not None else sys.platform
    if not str(plat).startswith("linux"):
        return []
    have = supported_rlimit_names()
    return [n for n in _CRITICAL_RLIMIT_NAMES_LINUX if n not in have]


def assert_production_resource_primitives(
    platform: str | None = None,
) -> None:
    """Refuse production Linux start when critical RLIMIT constants are missing.

    Offline macOS/unit hosts are no-ops (platform filter). Call only from
    production validation / entrypoint — not as a substitute for per-child
    ``apply_resource_limits``.
    """
    missing = missing_linux_resource_primitives(platform=platform)
    if missing:
        raise ResourceLimitError(
            "production Linux missing critical resource primitives: "
            + ", ".join(missing)
        )


def _rlimit_const(name: str) -> int | None:
    return getattr(resource, name, None)


def _set_rlimit(
    name: str,
    soft: int,
    hard: int,
    *,
    errors: list[str],
) -> None:
    """Set one rlimit; record failures into ``errors`` (never raise here)."""
    res_id = _rlimit_const(name)
    if res_id is None:
        errors.append(f"{name}: not supported on this platform")
        return
    try:
        resource.setrlimit(res_id, (int(soft), int(hard)))
    except (ValueError, OSError, resource.error) as exc:
        errors.append(f"{name}: {exc}")


def _tighten_nproc(max_process_count: int, *, errors: list[str]) -> None:
    """Apply RLIMIT_NPROC only when we can tighten the current soft limit.

    On shared UIDs (direct backend / macOS host tests) NPROC counts all
    processes for the user. Blindly setting a low absolute limit makes
    ``fork`` fail if the account already has many processes. We only lower
    soft/hard when the current soft is higher (or unlimited).
    """
    res_id = _rlimit_const("RLIMIT_NPROC")
    if res_id is None:
        errors.append("RLIMIT_NPROC: not supported on this platform")
        return
    target = int(max_process_count)
    if target <= 0:
        return
    try:
        soft, hard = resource.getrlimit(res_id)
    except (ValueError, OSError, resource.error) as exc:
        errors.append(f"RLIMIT_NPROC: getrlimit failed: {exc}")
        return

    # Already at or below target — leave as-is (still enforced by kernel).
    if soft != resource.RLIM_INFINITY and soft <= target:
        return

    if hard != resource.RLIM_INFINITY and hard < target:
        new_soft = hard
        new_hard = hard
    else:
        new_soft = target
        new_hard = target if hard == resource.RLIM_INFINITY or hard > target else hard

    try:
        resource.setrlimit(res_id, (new_soft, new_hard))
    except (ValueError, OSError, resource.error) as exc:
        errors.append(f"RLIMIT_NPROC: {exc}")


def apply_resource_limits(
    max_process_count: int = 0,
    max_memory_mb: int = 0,
    max_cpu_seconds: int = 0,
    max_file_size_mb: int = 0,
    max_open_files: int = 0,
    *,
    fail_closed: bool = False,
    new_session: bool = True,
) -> None:
    """Apply hard RLIMIT_* to the **current** process, then optionally setsid.

    Intended **only** as a ``subprocess.Popen(..., preexec_fn=...)`` callback
    so limits are installed in the forked child **before** ``exec`` of bwrap
    or the target command. Limits inherit across exec and into Bubblewrap
    children. Do **not** call this on the Sandbox service process.

    Parameters (0 = do not set that limit)
    --------------------------------------
    max_process_count
        RLIMIT_NPROC (process count for the UID; tightened only).
    max_memory_mb
        RLIMIT_AS address-space cap in **mebibytes** → bytes.
    max_cpu_seconds
        RLIMIT_CPU soft = seconds; hard = soft + 30 grace for SIGXCPU handlers.
    max_file_size_mb
        RLIMIT_FSIZE per-file write cap in **mebibytes** → bytes.
    max_open_files
        RLIMIT_NOFILE (open file descriptors, including pipes/sockets).
    fail_closed
        When True, any failure applying a *requested* limit raises
        :class:`ResourceLimitError` (production). When False, best-effort
        for offline macOS / unsupported primitives.
    new_session
        When True (default), call ``os.setsid()`` so the child is a process-
        group leader (required for group TERM/KILL).
    """
    errors: list[str] = []

    if int(max_process_count) > 0:
        _tighten_nproc(int(max_process_count), errors=errors)

    if int(max_memory_mb) > 0:
        memory_bytes = int(max_memory_mb) * 1024 * 1024
        _set_rlimit("RLIMIT_AS", memory_bytes, memory_bytes, errors=errors)

    if int(max_cpu_seconds) > 0:
        cpu = int(max_cpu_seconds)
        _set_rlimit("RLIMIT_CPU", cpu, cpu + 30, errors=errors)

    if int(max_file_size_mb) > 0:
        fsize = int(max_file_size_mb) * 1024 * 1024
        _set_rlimit("RLIMIT_FSIZE", fsize, fsize, errors=errors)

    if int(max_open_files) > 0:
        nofile = int(max_open_files)
        _set_rlimit("RLIMIT_NOFILE", nofile, nofile, errors=errors)

    if new_session:
        try:
            os.setsid()
        except OSError as exc:
            errors.append(f"setsid: {exc}")

    if errors and fail_closed:
        raise ResourceLimitError(
            "resource limits could not be applied: " + "; ".join(errors)
        )


def child_resource_limit_kwargs(
    settings: Any,
    *,
    fail_closed: bool | None = None,
) -> dict[str, Any]:
    """Build kwargs for :func:`apply_resource_limits` / :func:`run_with_timeout`.

    Reads Sandbox settings; production defaults ``fail_closed=True``.
    """
    if fail_closed is None:
        try:
            fail_closed = bool(getattr(settings, "is_production", False))
        except Exception:
            fail_closed = False
    return {
        "max_process_count": int(getattr(settings, "max_process_count", 0) or 0),
        "max_memory_mb": int(getattr(settings, "max_memory_mb", 0) or 0),
        "max_cpu_seconds": int(getattr(settings, "max_cpu_time_seconds", 0) or 0),
        "max_file_size_mb": int(getattr(settings, "max_file_size_mb", 0) or 0),
        "max_open_files": int(getattr(settings, "max_open_files", 0) or 0),
        "fail_closed": bool(fail_closed),
    }


# ── Environment helpers ─────────────────────────────────────────────


def apply_ulimit_env(max_memory_mb: int = 512) -> dict[str, str]:
    """Return environment variables that constrain resource-heavy interpreters.

    Soft hints only (Node heap). Hard enforcement is RLIMIT_AS in
    :func:`apply_resource_limits` — never rely on these alone.
    """
    return {
        "PYTHON_MEM_LIMIT": str(max_memory_mb),
        "NODE_OPTIONS": f"--max-old-space-size={max_memory_mb}",
    }


# ── Subprocess runner ───────────────────────────────────────────────

# Read size for drain loops. Large enough to keep up with noisy children
# without holding a full multi-MiB pipe buffer in user space.
_DRAIN_CHUNK_BYTES = 65_536
# How long we wait for well-behaved writers to close pipes after leader exit
# or group kill, before escalating (stop readers / kill again).
_READER_JOIN_SECONDS = 2.0
# Short grace after SIGTERM before SIGKILL when reaping a stuck group.
_ORPHAN_GROUP_GRACE_SECONDS = 0.2
# Poll interval for stoppable readers. Bounds how long a reader may block
# waiting for I/O so ``request_stop`` is always observed promptly.
_READER_POLL_SECONDS = 0.05
# Hard upper bound for the final stop+join of drain threads (never bare join).
_READER_STOP_JOIN_SECONDS = 2.0


class BoundedTextCapture:
    """Prefix-retaining capture for one stream with a hard character cap.

    After the cap is reached, further text is counted as seen/truncated but
    not retained. ``feed`` returns only the portion that should be forwarded
    to ``on_output`` so a naive callback cannot re-accumulate unbounded data.
    Retained size is strictly O(max_chars).
    """

    __slots__ = (
        "max_chars",
        "_parts",
        "retained_chars",
        "total_seen_chars",
        "forwarded_chars",
        "truncated",
    )

    def __init__(self, max_chars: int) -> None:
        self.max_chars = max(0, int(max_chars))
        self._parts: list[str] = []
        self.retained_chars = 0
        self.total_seen_chars = 0
        self.forwarded_chars = 0
        self.truncated = False

    def feed(self, text: str) -> str:
        """Ingest decoded text; return only the newly retained prefix (if any)."""
        if not text:
            return ""
        self.total_seen_chars += len(text)
        if self.retained_chars >= self.max_chars:
            self.truncated = True
            return ""
        remaining = self.max_chars - self.retained_chars
        if len(text) <= remaining:
            self._parts.append(text)
            self.retained_chars += len(text)
            self.forwarded_chars += len(text)
            return text
        # Python str slices are code-point safe (no half UTF-8 sequences).
        piece = text[:remaining]
        self._parts.append(piece)
        self.retained_chars += len(piece)
        self.forwarded_chars += len(piece)
        self.truncated = True
        return piece

    def getvalue(self) -> str:
        return "".join(self._parts)

    def stats(self) -> dict[str, int | bool]:
        """Minimal counters for deterministic O(cap) tests."""
        return {
            "max_chars": self.max_chars,
            "retained_chars": self.retained_chars,
            "total_seen_chars": self.total_seen_chars,
            "forwarded_chars": self.forwarded_chars,
            "parts_count": len(self._parts),
            "truncated": self.truncated,
        }


def _is_our_process_group(pgid: int) -> bool:
    """True if ``pgid`` is the caller's own process group (must never signal)."""
    try:
        return int(pgid) == os.getpgrp()
    except (OSError, TypeError, ValueError):
        return False


def _process_group_exists(pgid: int) -> bool:
    """Return whether any process remains in ``pgid`` (signal 0 probe)."""
    if pgid <= 0 or _is_our_process_group(pgid):
        return False
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except (PermissionError, OSError):
        # Exists but not fully inspectable — treat as still present.
        return True


def authoritative_pgid(proc: subprocess.Popen[Any]) -> int:
    """Return the process-group id created by our preexec ``os.setsid()``.

    After ``setsid``, the child is session/process-group leader, so
    ``pgid == child.pid``. Prefer a live ``getpgid``; if the leader already
    exited, fall back to ``proc.pid`` (the leader we spawned — not an
    arbitrary external PID).
    """
    try:
        return os.getpgid(proc.pid)
    except (ProcessLookupError, PermissionError, OSError):
        return int(proc.pid)


def _signal_process_group(pgid: int, sig: int) -> None:
    """Deliver ``sig`` to ``pgid`` only; never our own group; ignore lookup races."""
    if pgid <= 0 or _is_our_process_group(pgid):
        return
    try:
        os.killpg(pgid, sig)
    except (ProcessLookupError, PermissionError, OSError):
        pass


def terminate_process_group(
    proc: subprocess.Popen[Any] | None = None,
    *,
    grace_seconds: float = 2.0,
    pgid: int | None = None,
) -> None:
    """SIGTERM a process group, escalate to SIGKILL, then reap the leader.

    When ``pgid`` is the authoritative id captured at spawn (post-``setsid``),
    descendants are signalled even if the leader Popen has already exited.
    Without a saved ``pgid``, a dead leader cannot safely reveal descendants
    (PID may already be reaped), so only the live leader is targeted.

    Never signals the caller's own process group.
    """
    resolved: int | None = pgid
    if resolved is None and proc is not None:
        try:
            # getpgid only works while the pid is still known to the kernel.
            resolved = os.getpgid(proc.pid)
        except (ProcessLookupError, PermissionError, OSError):
            resolved = None

    if resolved is not None and not _is_our_process_group(resolved):
        _signal_process_group(resolved, signal.SIGTERM)
    elif proc is not None and proc.poll() is None:
        try:
            proc.terminate()
        except (ProcessLookupError, OSError):
            pass

    deadline = time.monotonic() + max(0.0, float(grace_seconds))
    while time.monotonic() < deadline:
        leader_done = proc is None or proc.poll() is not None
        group_gone = True if resolved is None else not _process_group_exists(resolved)
        if leader_done and group_gone:
            break
        time.sleep(0.05)

    if resolved is not None and not _is_our_process_group(resolved):
        _signal_process_group(resolved, signal.SIGKILL)
    elif proc is not None and proc.poll() is None:
        try:
            proc.kill()
        except (ProcessLookupError, OSError):
            pass

    if proc is not None:
        try:
            proc.wait(timeout=2)
        except (subprocess.TimeoutExpired, Exception):
            pass


def _close_pipe(pipe: Any) -> None:
    if pipe is None:
        return
    try:
        pipe.close()
    except Exception:
        pass


def _join_threads(threads: list[Any], timeout: float) -> None:
    """Join threads with a hard deadline (never unbounded)."""
    deadline = time.monotonic() + max(0.0, float(timeout))
    for t in threads:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            t.join(timeout=remaining)
        except Exception:
            pass


def drain_pipe_until_stop(
    pipe: Any,
    *,
    stop_event: Any,
    on_text: Any | None = None,
    chunk_size: int = _DRAIN_CHUNK_BYTES,
    poll_seconds: float = _READER_POLL_SECONDS,
) -> None:
    """Read ``pipe`` until EOF or ``stop_event`` is set.

    Uses non-blocking I/O + ``select`` with a short poll interval so the loop
    never blocks longer than ``poll_seconds``. Cross-thread pipe close is **not**
    relied upon to interrupt a blocking ``read`` (it is not portable). A
    descendant that ``setsid()`` and keeps the write end open cannot hang the
    caller forever once ``stop_event`` is set.

    ``on_text`` receives decoded UTF-8 text chunks (errors=replace, incremental).
    """
    import codecs
    import select
    import threading as _threading

    if pipe is None:
        return
    if not isinstance(stop_event, _threading.Event):
        # Duck-typed Event (is_set); still safe if missing → treat as never stop
        # until EOF — but callers always pass a real Event.
        pass

    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    fd: int | None = None
    try:
        try:
            fd = int(pipe.fileno())
        except Exception:
            fd = None

        if fd is not None:
            try:
                os.set_blocking(fd, False)
            except (OSError, AttributeError, ValueError):
                pass

        def _stopped() -> bool:
            try:
                return bool(stop_event.is_set())
            except Exception:
                return False

        def _emit(raw: bytes) -> None:
            if not raw:
                return
            text = decoder.decode(raw, final=False)
            if text and on_text is not None:
                try:
                    on_text(text)
                except Exception:
                    pass

        if fd is None:
            # No fileno: fall back to short timed-ish reads via non-blocking
            # attempt; if the pipe object only supports blocking read, exit on
            # stop is best-effort only. Prefer fileno path on Unix.
            while not _stopped():
                try:
                    chunk = pipe.read(chunk_size)
                except Exception:
                    break
                if not chunk:
                    break
                if isinstance(chunk, str):
                    chunk = chunk.encode("utf-8", errors="replace")
                _emit(chunk)
        else:
            poll = max(0.001, float(poll_seconds))
            while not _stopped():
                try:
                    ready, _, _ = select.select([fd], [], [], poll)
                except (ValueError, OSError, InterruptedError):
                    # fd closed / invalid → treat as EOF
                    break
                if _stopped():
                    break
                if not ready:
                    continue
                try:
                    chunk = os.read(fd, chunk_size)
                except BlockingIOError:
                    continue
                except OSError:
                    break
                if not chunk:
                    break  # EOF — all writers closed
                _emit(chunk)

            # Best-effort non-blocking drain of already-available bytes so a
            # normal exit does not drop a tiny tail that raced with stop/EOF.
            # Hard-capped iterations → finite time even with a flooder.
            for _ in range(64):
                try:
                    more, _, _ = select.select([fd], [], [], 0.0)
                except (ValueError, OSError):
                    break
                if not more:
                    break
                try:
                    chunk = os.read(fd, chunk_size)
                except (BlockingIOError, OSError):
                    break
                if not chunk:
                    break
                _emit(chunk)

        try:
            tail = decoder.decode(b"", final=True)
        except Exception:
            tail = ""
        if tail and on_text is not None:
            try:
                on_text(tail)
            except Exception:
                pass
    finally:
        _close_pipe(pipe)


class StoppableStreamReader:
    """Explicitly stoppable, poll-based stdout/stderr reader thread.

    * Normal children: reads until EOF (full tail drain).
    * Same-group orphans: group kill closes writers → EOF.
    * Escaped ``setsid`` writers: ``request_stop()`` exits within one poll
      interval; join always has a hard timeout (never bare ``join()``).
    """

    __slots__ = (
        "name",
        "_pipe",
        "_on_text",
        "_stop",
        "_done",
        "_thread",
        "_chunk_size",
        "_poll_seconds",
    )

    def __init__(
        self,
        pipe: Any,
        *,
        name: str,
        on_text: Any | None = None,
        chunk_size: int = _DRAIN_CHUNK_BYTES,
        poll_seconds: float = _READER_POLL_SECONDS,
        daemon: bool = True,
    ) -> None:
        import threading

        self.name = name
        self._pipe = pipe
        self._on_text = on_text
        self._stop = threading.Event()
        self._done = threading.Event()
        self._chunk_size = chunk_size
        self._poll_seconds = poll_seconds
        self._thread = threading.Thread(
            target=self._run,
            name=f"stream-reader-{name}",
            daemon=daemon,
        )

    @property
    def stop_event(self) -> Any:
        return self._stop

    @property
    def done_event(self) -> Any:
        return self._done

    def start(self) -> None:
        self._thread.start()

    def request_stop(self) -> None:
        """Ask the reader to exit at the next poll (does not wait)."""
        self._stop.set()

    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def join(self, timeout: float | None = None) -> bool:
        """Join with optional hard timeout. Returns True if the thread exited."""
        # Always pass a finite timeout to Thread.join when given; never hang.
        if timeout is None:
            timeout = _READER_STOP_JOIN_SECONDS
        try:
            self._thread.join(timeout=max(0.0, float(timeout)))
        except Exception:
            pass
        return not self._thread.is_alive()

    def stop_and_join(self, timeout: float = _READER_STOP_JOIN_SECONDS) -> bool:
        """Signal stop then join with a hard bound. Never waits forever."""
        self.request_stop()
        return self.join(timeout=timeout)

    def _run(self) -> None:
        try:
            drain_pipe_until_stop(
                self._pipe,
                stop_event=self._stop,
                on_text=self._on_text,
                chunk_size=self._chunk_size,
                poll_seconds=self._poll_seconds,
            )
        finally:
            self._done.set()


def stop_and_join_readers(
    readers: list[StoppableStreamReader],
    *,
    timeout: float = _READER_STOP_JOIN_SECONDS,
) -> bool:
    """Request stop on all readers and join each with a shared hard deadline.

    Returns True when every reader has exited.
    """
    for r in readers:
        try:
            r.request_stop()
        except Exception:
            pass
    deadline = time.monotonic() + max(0.0, float(timeout))
    for r in readers:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            # Still attempt a zero-timeout poll so is_alive is updated.
            r.join(timeout=0.0)
            continue
        r.join(timeout=remaining)
    return not any(r.is_alive() for r in readers)


def run_with_timeout(
    cmd: list[str],
    *,
    timeout: int = 120,
    max_output_chars: int = 50_000,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
    max_process_count: int = 0,
    max_memory_mb: int = 0,
    max_cpu_seconds: int = 0,
    max_file_size_mb: int = 0,
    max_open_files: int = 0,
    fail_closed: bool = False,
    on_started: Any | None = None,
    on_output: Any | None = None,
    capture_stats: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run a subprocess with timeout, kill-after-timeout, and output limits.

    Both stdout and stderr are drained on stoppable poll-based reader threads
    so a chatty child cannot deadlock on a full pipe, and a descendant that
    escapes the process group via ``setsid()`` cannot hang the parent forever.
    Each stream retains only a hard-capped **prefix** of at most
    ``max_output_chars`` characters; data beyond the cap is discarded after
    read (still drained while the reader runs). ``on_output`` is invoked only
    for retained prefix text.

    Hard RLIMIT_* (NPROC/AS/CPU/FSIZE/NOFILE) and ``os.setsid()`` run in the
    child ``preexec_fn`` **before** exec — never on the parent service process.
    The authoritative pgid is captured at spawn. After the leader exits:

    1. bounded wait for natural EOF (full tail for well-behaved children);
    2. TERM→KILL the **saved** process group (same-group orphans);
    3. if readers still alive (escaped writers), ``request_stop`` + hard join.

    All joins have hard upper bounds — never bare ``Thread.join()``.

    Parameters
    ----------
    max_process_count : int
        RLIMIT_NPROC applied in the child process (0 = no limit).
    max_memory_mb : int
        RLIMIT_AS applied in the child process (0 = no limit), mebibytes.
    max_cpu_seconds : int
        RLIMIT_CPU applied in the child process (0 = no limit).
    max_file_size_mb : int
        RLIMIT_FSIZE applied in the child process (0 = no limit), mebibytes.
    max_open_files : int
        RLIMIT_NOFILE applied in the child process (0 = no limit).
    fail_closed : bool
        When True, inability to apply requested limits fails the spawn
        (production). When False, best-effort for offline platforms.
    on_started :
        Optional callback ``(proc: subprocess.Popen) -> None`` invoked after
        the child is spawned so callers can track / cancel the process group.
    on_output :
        Optional callback ``(stream: str, text: str) -> None`` invoked for each
        retained stdout/stderr chunk as it arrives (B3 streaming). After the
        per-stream cap, further pipe data is drained without calling back.
    capture_stats :
        Optional dict filled with per-stream retention counters for tests
        (``stdout`` / ``stderr`` maps from :meth:`BoundedTextCapture.stats`),
        plus ``pgid`` and ``readers_alive``.

    Returns
    -------
    dict with keys: stdout_preview, stderr_preview, exit_code, duration_ms, truncated
    """
    start = time.monotonic()
    cap = max(0, int(max_output_chars))

    # Build a preexec closure that applies resource limits + setsid in the
    # forked child only (never mutates parent service rlimits).
    def _preexec() -> None:
        apply_resource_limits(
            max_process_count=max_process_count,
            max_memory_mb=max_memory_mb,
            max_cpu_seconds=max_cpu_seconds,
            max_file_size_mb=max_file_size_mb,
            max_open_files=max_open_files,
            fail_closed=fail_closed,
        )

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
            preexec_fn=_preexec,
            # Unbuffered pipes so drain threads see data promptly.
            bufsize=0,
        )
    except FileNotFoundError as exc:
        return {
            "stdout_preview": "",
            "stderr_preview": f"Command not found: {exc}",
            "exit_code": -1,
            "duration_ms": 0.0,
            "truncated": False,
        }
    except (ResourceLimitError, subprocess.SubprocessError, OSError) as exc:
        # preexec_fn failures (including fail-closed ResourceLimitError) surface
        # here — child never ran with missing limits.
        return {
            "stdout_preview": "",
            "stderr_preview": f"Resource limit / spawn failed: {exc}",
            "exit_code": -1,
            "duration_ms": round((time.monotonic() - start) * 1000, 1),
            "truncated": False,
        }

    # Capture pgid immediately after spawn while the leader pid is still valid.
    # setsid ⇒ child is the new session/process-group leader (pgid == pid).
    pgid = authoritative_pgid(proc)

    if on_started is not None:
        try:
            on_started(proc)
        except Exception:
            # Registration failure must not leave an orphan process group
            terminate_process_group(proc, grace_seconds=0.5, pgid=pgid)
            raise

    stdout_cap = BoundedTextCapture(cap)
    stderr_cap = BoundedTextCapture(cap)

    def _make_on_text(stream_name: str, capture: BoundedTextCapture) -> Any:
        def _on_text(text: str) -> None:
            forward = capture.feed(text)
            if forward and on_output is not None:
                try:
                    on_output(stream_name, forward)
                except Exception:
                    pass

        return _on_text

    r_out = StoppableStreamReader(
        proc.stdout,
        name="stdout",
        on_text=_make_on_text("stdout", stdout_cap),
    )
    r_err = StoppableStreamReader(
        proc.stderr,
        name="stderr",
        on_text=_make_on_text("stderr", stderr_cap),
    )
    r_out.start()
    r_err.start()
    readers = [r_out, r_err]

    timed_out = False
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        timed_out = True
        # Kill the whole original group (descendants included), then reap leader.
        terminate_process_group(
            proc, grace_seconds=_ORPHAN_GROUP_GRACE_SECONDS, pgid=pgid
        )
        try:
            proc.wait(timeout=5)
        except Exception:
            pass

    def _bounded_join_readers(window: float) -> None:
        deadline = time.monotonic() + max(0.0, float(window))
        for r in readers:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                r.join(timeout=0.0)
                continue
            r.join(timeout=remaining)

    # 1) Natural drain window — well-behaved children close pipes on exit.
    _bounded_join_readers(_READER_JOIN_SECONDS)

    if any(r.is_alive() for r in readers):
        # 2) Same-group orphans still holding pipes: kill saved process group.
        terminate_process_group(
            proc, grace_seconds=_ORPHAN_GROUP_GRACE_SECONDS, pgid=pgid
        )
        _bounded_join_readers(_READER_JOIN_SECONDS)

    if any(r.is_alive() for r in readers):
        # Group kill may have raced; hard-kill once more then re-wait briefly.
        _signal_process_group(pgid, signal.SIGKILL)
        _bounded_join_readers(_READER_JOIN_SECONDS)

    if any(r.is_alive() for r in readers):
        # 3) Escaped writers (setsid outside original pgid): stop readers
        # explicitly. Poll loop exits within one poll interval; join is bounded.
        # Do NOT bare-join — that hangs forever when pipes stay open.
        stop_and_join_readers(readers, timeout=_READER_STOP_JOIN_SECONDS)

    duration_ms = (time.monotonic() - start) * 1000
    stdout_str = stdout_cap.getvalue()
    stderr_str = stderr_cap.getvalue()
    exit_code = -signal.SIGKILL if timed_out else proc.returncode
    truncated = bool(stdout_cap.truncated or stderr_cap.truncated)
    readers_alive = any(r.is_alive() for r in readers)

    if capture_stats is not None:
        capture_stats["stdout"] = stdout_cap.stats()
        capture_stats["stderr"] = stderr_cap.stats()
        capture_stats["pgid"] = pgid
        capture_stats["readers_alive"] = readers_alive

    return {
        "stdout_preview": stdout_str,
        "stderr_preview": stderr_str,
        "exit_code": exit_code,
        "duration_ms": round(duration_ms, 1),
        "truncated": truncated,
    }
