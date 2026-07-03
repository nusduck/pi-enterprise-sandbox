"""Safe execution environment — sanitised env for subprocesses."""

from __future__ import annotations

import os
from typing import Any

# Safe environment that excludes host secrets.
# The sandbox service process may have tokens in its own environment;
# we never forward the full os.environ to subprocesses.
_BASE_SAFE_ENV: dict[str, str] = {
    "HOME": "",  # overridden per-execution
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "LANG": "C.UTF-8",
    "LC_ALL": "C.UTF-8",
    "PYTHONIOENCODING": "utf-8",
    "NODE_OPTIONS": "--max-old-space-size=512",
    "DEBIAN_FRONTEND": "noninteractive",
}


def safe_env(
    workspace_path: str | None = None,
    overrides: dict[str, str] | None = None,
) -> dict[str, str]:
    """Build a safe, minimal environment dict for subprocesses.

    Never inherits from ``os.environ`` — only explicitly set keys.
    """
    env = dict(_BASE_SAFE_ENV)
    if workspace_path:
        env["HOME"] = workspace_path
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
