"""Resource limits helper — ulimit / subprocess resource control."""

from __future__ import annotations

import os
import re
import resource
import signal
import subprocess
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


def apply_resource_limits(max_process_count: int = 0, max_memory_mb: int = 0, max_cpu_seconds: int = 0) -> None:
    """Apply RLIMIT_NPROC, RLIMIT_AS, and RLIMIT_CPU to the current process.

    Intended for use as a ``preexec_fn`` callback so limits are inherited
    by the forked child before it exec()s the target command.
    """
    if max_process_count > 0:
        try:
            resource.setrlimit(
                resource.RLIMIT_NPROC,
                (max_process_count, max_process_count),
            )
        except (ValueError, resource.error):
            pass

    if max_memory_mb > 0:
        try:
            memory_bytes = max_memory_mb * 1024 * 1024
            resource.setrlimit(
                resource.RLIMIT_AS,
                (memory_bytes, memory_bytes),
            )
        except (ValueError, resource.error):
            pass

    if max_cpu_seconds > 0:
        try:
            resource.setrlimit(
                resource.RLIMIT_CPU,
                (max_cpu_seconds, max_cpu_seconds + 30),
            )
        except (ValueError, resource.error):
            pass

    # Also set process group isolation (original behaviour)
    os.setsid()


# ── Environment helpers ─────────────────────────────────────────────


def apply_ulimit_env(max_memory_mb: int = 512) -> dict[str, str]:
    """Return environment variables that constrain resource-heavy interpreters."""
    return {
        "PYTHON_MEM_LIMIT": str(max_memory_mb),
        "NODE_OPTIONS": f"--max-old-space-size={max_memory_mb}",
    }


# ── Subprocess runner ───────────────────────────────────────────────


def terminate_process_group(
    proc: subprocess.Popen[Any],
    *,
    grace_seconds: float = 2.0,
) -> None:
    """SIGTERM the process group, escalate to SIGKILL, then reap.

    Safe to call if the process has already exited.
    """
    if proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except (ProcessLookupError, PermissionError, OSError):
        try:
            proc.terminate()
        except (ProcessLookupError, OSError):
            pass
    deadline = time.monotonic() + grace_seconds
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            return
        time.sleep(0.05)
    if proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except (ProcessLookupError, OSError):
                pass
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            pass


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
    on_started: Any | None = None,
    on_output: Any | None = None,
) -> dict[str, Any]:
    """Run a subprocess with timeout, kill-after-timeout, and output limits.

    Parameters
    ----------
    max_process_count : int
        RLIMIT_NPROC applied in the child process (0 = no limit).
    max_memory_mb : int
        RLIMIT_AS applied in the child process (0 = no limit).
    max_cpu_seconds : int
        RLIMIT_CPU applied in the child process (0 = no limit).
    on_started :
        Optional callback ``(proc: subprocess.Popen) -> None`` invoked after
        the child is spawned so callers can track / cancel the process group.
    on_output :
        Optional callback ``(stream: str, text: str) -> None`` invoked for each
        stdout/stderr chunk as it arrives (B3 streaming). When provided, uses
        threaded readers instead of ``communicate``.

    Returns
    -------
    dict with keys: stdout_preview, stderr_preview, exit_code, duration_ms, truncated
    """
    import threading

    start = time.monotonic()

    # Build a preexec closure that applies resource limits + setsid
    def _preexec() -> None:
        apply_resource_limits(
            max_process_count=max_process_count,
            max_memory_mb=max_memory_mb,
            max_cpu_seconds=max_cpu_seconds,
        )

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
            preexec_fn=_preexec,
            bufsize=0 if on_output is not None else -1,
        )
    except FileNotFoundError as exc:
        return {
            "stdout_preview": "",
            "stderr_preview": f"Command not found: {exc}",
            "exit_code": -1,
            "duration_ms": 0.0,
            "truncated": False,
        }

    if on_started is not None:
        try:
            on_started(proc)
        except Exception:
            # Registration failure must not leave an orphan process
            terminate_process_group(proc, grace_seconds=0.5)
            raise

    # ── Streaming path (B3): live stdout/stderr deltas ───────────────
    if on_output is not None:
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        lock = threading.Lock()
        total_chars = 0
        truncated_flag = False

        def _reader(pipe: Any, name: str, bucket: list[str]) -> None:
            nonlocal total_chars, truncated_flag
            try:
                while True:
                    chunk = pipe.read(4096)
                    if not chunk:
                        break
                    text = chunk.decode("utf-8", errors="replace")
                    with lock:
                        bucket.append(text)
                        total_chars += len(text)
                        if total_chars > max_output_chars * 4:
                            # Soft cap on accumulation; still forward delta.
                            truncated_flag = True
                    try:
                        on_output(name, text)
                    except Exception:
                        pass
            except Exception:
                pass
            finally:
                try:
                    pipe.close()
                except Exception:
                    pass

        t_out = threading.Thread(
            target=_reader, args=(proc.stdout, "stdout", stdout_parts), daemon=True
        )
        t_err = threading.Thread(
            target=_reader, args=(proc.stderr, "stderr", stderr_parts), daemon=True
        )
        t_out.start()
        t_err.start()

        timed_out = False
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            terminate_process_group(proc, grace_seconds=0.1)
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                proc.wait(timeout=5)
            except Exception:
                pass

        t_out.join(timeout=2.0)
        t_err.join(timeout=2.0)

        duration_ms = (time.monotonic() - start) * 1000
        stdout_str = "".join(stdout_parts)
        stderr_str = "".join(stderr_parts)
        exit_code = -signal.SIGKILL if timed_out else proc.returncode
        truncated = (
            truncated_flag
            or len(stdout_str) > max_output_chars
            or len(stderr_str) > max_output_chars
        )
        return {
            "stdout_preview": stdout_str[:max_output_chars],
            "stderr_preview": stderr_str[:max_output_chars],
            "exit_code": exit_code,
            "duration_ms": round(duration_ms, 1),
            "truncated": truncated,
        }

    # ── Buffered path (legacy short-command) ─────────────────────────
    try:
        stdout_raw, stderr_raw = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Kill the entire process group
        terminate_process_group(proc, grace_seconds=0.1)
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            stdout_raw, stderr_raw = proc.communicate(timeout=5)
        except Exception:
            stdout_raw, stderr_raw = b"", b""
        duration_ms = (time.monotonic() - start) * 1000
        exit_code = -signal.SIGKILL
        stdout_str = stdout_raw.decode("utf-8", errors="replace") if stdout_raw else ""
        stderr_str = stderr_raw.decode("utf-8", errors="replace") if stderr_raw else ""

        return {
            "stdout_preview": stdout_str[:max_output_chars],
            "stderr_preview": stderr_str[:max_output_chars],
            "exit_code": exit_code,
            "duration_ms": round(duration_ms, 1),
            "truncated": len(stdout_str) > max_output_chars or len(stderr_str) > max_output_chars,
        }

    duration_ms = (time.monotonic() - start) * 1000
    stdout_str = stdout_raw.decode("utf-8", errors="replace") if stdout_raw else ""
    stderr_str = stderr_raw.decode("utf-8", errors="replace") if stderr_raw else ""

    return {
        "stdout_preview": stdout_str[:max_output_chars],
        "stderr_preview": stderr_str[:max_output_chars],
        "exit_code": proc.returncode,
        "duration_ms": round(duration_ms, 1),
        "truncated": len(stdout_str) > max_output_chars or len(stderr_str) > max_output_chars,
    }
