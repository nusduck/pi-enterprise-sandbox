"""Safe execution environment — sanitised env for subprocesses."""

from __future__ import annotations

from typing import Any

# Safe environment that excludes host secrets.
# The sandbox service process may have tokens in its own environment;
# we never forward the full os.environ to subprocesses.
_BASE_SAFE_ENV: dict[str, str] = {
    "HOME": "",  # overridden per-execution
    "PATH": "/app/.venv/bin:/usr/local/bin:/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PYTHONIOENCODING": "utf-8",
    "NODE_OPTIONS": "--max-old-space-size=512",
    "DEBIAN_FRONTEND": "noninteractive",
}


def safe_env(
    workspace_path: str | None = None,
    overrides: dict[str, str] | None = None,
    *,
    logical_workspace: str | None = None,
) -> dict[str, str]:
    """Build a safe, minimal environment dict for subprocesses.

    Never inherits from ``os.environ`` — only explicitly set keys.

    ``workspace_path`` is the physical cwd used for real I/O (internal only).
    ``PWD`` is set to a non-physical token (``.`` by default, or the caller-
    supplied ``logical_workspace``) so bash ``pwd`` does not leak host layout
    when it trusts ``PWD``. True ``os.getcwd()`` still reflects the physical
    cwd unless a mount namespace is enabled (stretch / deferred).
    """
    env = dict(_BASE_SAFE_ENV)
    if workspace_path:
        # HOME points at physical tree so tools that write under $HOME land
        # inside the session workspace on disk.
        env["HOME"] = workspace_path
        # Prefer relative / redacted logical view — never a host absolute path.
        env["PWD"] = logical_workspace or "."
    if overrides:
        env.update(overrides)
    return env


def sanitize_for_log(value: str, sensitive_keys: list[str] | None = None) -> str:
    """Redact sensitive values from log output."""
    keys = sensitive_keys or [
        "password", "secret", "token", "api_key",
        "authorization", "cookie", "auth", "key",
    ]
    sanitized = value
    for key in keys:
        sanitized = sanitized.replace(key, "***")
    return sanitized
