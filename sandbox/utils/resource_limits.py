"""Resource limits helper — ulimit / subprocess resource control."""

from __future__ import annotations

import os
import signal
import subprocess
import time
from typing import Any


def apply_ulimit_env(max_memory_mb: int = 512) -> dict[str, str]:
    """Return environment variables that constrain resource-heavy interpreters."""
    return {
        "PYTHON_MEM_LIMIT": str(max_memory_mb),
        "NODE_OPTIONS": f"--max-old-space-size={max_memory_mb}",
    }


def run_with_timeout(
    cmd: list[str],
    *,
    timeout: int = 120,
    max_output_chars: int = 50_000,
    env: dict[str, str] | None = None,
    cwd: str | None = None,
) -> dict[str, Any]:
    """Run a subprocess with timeout, kill-after-timeout, and output limits.

    Returns
    -------
    dict with keys: stdout_preview, stderr_preview, exit_code, duration_ms, truncated
    """
    start = time.monotonic()

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
            preexec_fn=os.setsid,  # isolate in process group for kill
        )
    except FileNotFoundError as exc:
        return {
            "stdout_preview": "",
            "stderr_preview": f"Command not found: {exc}",
            "exit_code": -1,
            "duration_ms": 0.0,
            "truncated": False,
        }

    try:
        stdout_raw, stderr_raw = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        # Kill the entire process group
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
        stdout_raw, stderr_raw = proc.communicate(timeout=5)
        duration_ms = (time.monotonic() - start) * 1000
        exit_code = -signal.SIGKILL
        truncated = False
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
