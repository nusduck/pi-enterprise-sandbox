"""Safe Python code materialization for the python tool (plan §13.6 / PR-08).

Rules:
- Short single-line code (no newline, UTF-8 length ≤ threshold) → ``python3 -c``.
- Multiline or over threshold → unique workspace file under
  ``.runtime/python/{execution_id}.py`` (atomic UTF-8 write).
- Never shell-quote code or args; argv is always a list (no injection surface).
- Materialized scripts are intermediate workspace files (not artifacts).
"""

from __future__ import annotations

import os
import re
import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Sequence

from sandbox.paths import AGENT_WORKSPACE_PATH
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.file_manager import workspace_size_bytes

# Plan §13.6 suggested threshold.
PYTHON_INLINE_MAX_BYTES = 2048
# Align with agent MAX_PYTHON_CODE_BYTES.
PYTHON_CODE_MAX_BYTES = 256 * 1024
PYTHON_ARGS_MAX = 32
PYTHON_ARG_MAX_LEN = 1024
_SAFE_EXEC_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")
_RUNTIME_REL = PurePosixPath(".runtime") / "python"


@dataclass(frozen=True, slots=True)
class PythonLaunchPlan:
    """Resolved argv + optional materialization metadata."""

    argv: list[str]
    materialized_path: str | None
    """Agent-visible logical path under workspace, or None for ``-c``."""
    physical_path: Path | None
    mode: str  # "inline" | "file"
    code_bytes: int


def should_materialize(code: str) -> bool:
    """True when code must be written to a file (newline or over size)."""
    if not isinstance(code, str):
        return True
    if "\n" in code or "\r" in code:
        return True
    return len(code.encode("utf-8")) > PYTHON_INLINE_MAX_BYTES


def normalize_python_args(args: Sequence[str] | None) -> list[str]:
    """Validate and bound argv-style args (no shell)."""
    if not args:
        return []
    if len(args) > PYTHON_ARGS_MAX:
        raise ValueError(f"python args exceed max count ({PYTHON_ARGS_MAX})")
    out: list[str] = []
    for i, raw in enumerate(args):
        if not isinstance(raw, str):
            raise ValueError(f"python args[{i}] must be a string")
        if "\x00" in raw:
            raise ValueError(f"python args[{i}] contains NUL")
        if len(raw) > PYTHON_ARG_MAX_LEN:
            raise ValueError(f"python args[{i}] exceeds max length ({PYTHON_ARG_MAX_LEN})")
        out.append(raw)
    return out


def _validate_execution_id(execution_id: str) -> str:
    text = (execution_id or "").strip()
    if not text or not _SAFE_EXEC_ID_RE.fullmatch(text):
        raise ValueError("invalid execution_id for python materialization")
    return text


def _atomic_write_utf8(path: Path, text: str) -> None:
    """Write UTF-8 text via temp file + os.replace (same directory)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = text.encode("utf-8")
    fd, tmp_name = tempfile.mkstemp(
        dir=str(path.parent),
        prefix=".py_mat_",
        suffix=".tmp",
    )
    try:
        with os.fdopen(fd, "wb") as tmp:
            tmp.write(data)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _enforce_workspace_quota(
    workspace: Path,
    new_bytes: int,
    *,
    quota_mb: int,
) -> None:
    if quota_mb <= 0:
        return
    quota_bytes = quota_mb * 1024 * 1024
    current = workspace_size_bytes(str(workspace))
    if current + new_bytes > quota_bytes:
        raise ValueError(
            f"Workspace quota exceeded ({quota_mb}MB); cannot materialize python"
        )


def plan_python_launch(
    *,
    code: str,
    execution_id: str,
    context: SandboxExecutionContext,
    args: Sequence[str] | None = None,
    isolation_backend: str = "direct",
    workspace_quota_mb: int = 0,
) -> PythonLaunchPlan:
    """Build a safe python3 argv for *code* in *context*.

    Raises ValueError on invalid code/args/quota (caller maps to 400).
    """
    if not isinstance(code, str):
        raise ValueError("code must be a string")
    if "\x00" in code:
        raise ValueError("code must not contain NUL")
    code_bytes = len(code.encode("utf-8"))
    if code_bytes == 0 or not code.strip():
        raise ValueError("code is required")
    if code_bytes > PYTHON_CODE_MAX_BYTES:
        raise ValueError(f"code exceeds max size ({PYTHON_CODE_MAX_BYTES} bytes)")

    exec_id = _validate_execution_id(execution_id)
    argv_args = normalize_python_args(args)

    if not should_materialize(code):
        # Inline: python3 -c <code> [args...]
        return PythonLaunchPlan(
            argv=["python3", "-c", code, *argv_args],
            materialized_path=None,
            physical_path=None,
            mode="inline",
            code_bytes=code_bytes,
        )

    # Materialize into session workspace under .runtime/python/
    rel = _RUNTIME_REL / f"{exec_id}.py"
    physical = (context.physical_workspace / rel).resolve()
    # Ownership: must stay inside physical_workspace (no escape).
    try:
        physical.relative_to(context.physical_workspace.resolve())
    except ValueError as exc:
        raise ValueError("materialized path escapes workspace") from exc

    _enforce_workspace_quota(
        context.physical_workspace,
        code_bytes,
        quota_mb=workspace_quota_mb,
    )
    _atomic_write_utf8(physical, code)

    logical = f"{AGENT_WORKSPACE_PATH}/{rel.as_posix()}"
    if isolation_backend == "bubblewrap":
        guest_path = logical
    else:
        guest_path = str(physical)

    return PythonLaunchPlan(
        argv=["python3", "-u", guest_path, *argv_args],
        materialized_path=logical,
        physical_path=physical,
        mode="file",
        code_bytes=code_bytes,
    )


def resolve_python_version() -> str | None:
    """Best-effort local python3 version string (not for security decisions)."""
    import subprocess

    try:
        proc = subprocess.run(
            ["python3", "-c", "import sys; print(sys.version.split()[0])"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if proc.returncode == 0:
            return (proc.stdout or "").strip() or None
    except Exception:
        return None
    return None
