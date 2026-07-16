"""Safe execution environment — sanitised env for subprocesses.

Child processes never inherit the full host/service environment. They receive:

1. A fixed base of interpreter-safe defaults
2. Optional **shared exec env** (allowlisted keys + ``SANDBOX_EXEC_ENV_*`` prefix)
3. Per-call ``env_overrides`` (highest precedence)

Service credentials (API tokens, DB URLs, JWT secrets, …) are hard-denied even
if listed in the allowlist.
"""

from __future__ import annotations

import os
import re
from typing import Any, Mapping

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

# Prefix: SANDBOX_EXEC_ENV_FOO=bar → FOO=bar in every execution (incl. processes).
EXEC_ENV_PREFIX = "SANDBOX_EXEC_ENV_"

# Valid POSIX-ish env names for child processes (bwrap --setenv also validates).
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Never inject these into untrusted executions, even if allowlisted or prefixed.
_SHARED_ENV_DENYLIST = frozenset(
    {
        "SANDBOX_API_TOKEN",
        "SANDBOX_JWT_SECRET",
        "JWT_SECRET",
        "SANDBOX_DATABASE_URL",
        "DATABASE_URL",
        "MYSQL_ROOT_PASSWORD",
        "MYSQL_APP_PASSWORD",
        "MYSQL_MIGRATOR_PASSWORD",
        "POSTGRES_PASSWORD",
        "REDIS_CONTROL_PASSWORD",
        "REDIS_WORKER_PASSWORD",
        "WORKER_SERVICE_TOKEN",
        "AGENT_INTERNAL_TOKEN",
        "API_TOKEN",
    }
)

_SHARED_ENV_DENY_SUBSTRINGS = (
    "PASSWORD",
    "PRIVATE_KEY",
    "SECRET_KEY",
    "_SECRET",
    "SERVICE_TOKEN",
)


def _is_denied_shared_key(name: str) -> bool:
    upper = (name or "").strip().upper()
    if not upper:
        return True
    if upper in _SHARED_ENV_DENYLIST:
        return True
    # Prefixed form that would map to a denied name
    if upper.startswith(EXEC_ENV_PREFIX) and _is_denied_shared_key(
        upper[len(EXEC_ENV_PREFIX) :]
    ):
        return True
    return any(token in upper for token in _SHARED_ENV_DENY_SUBSTRINGS)


def _parse_shared_env_keys(raw: str | list[str] | None) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, list):
        items = raw
    else:
        text = str(raw).strip()
        if not text:
            return []
        items = re.split(r"[,;\s]+", text)
    out: list[str] = []
    seen: set[str] = set()
    for item in items:
        key = str(item or "").strip()
        if not key or key in seen:
            continue
        if not _ENV_NAME_RE.fullmatch(key):
            continue
        seen.add(key)
        out.append(key)
    return out


def load_shared_exec_env(
    *,
    process_env: Mapping[str, str] | None = None,
    shared_keys: str | list[str] | None = None,
) -> dict[str, str]:
    """Build the shared exec env map from the service process environment.

    Sources (later wins within this map only; callers merge with overrides):

    1. Keys named in ``shared_keys`` / ``SANDBOX_SHARED_ENV_KEYS`` present in
       ``process_env``
    2. Any ``SANDBOX_EXEC_ENV_<NAME>=value`` → inject as ``NAME=value``
    """
    env_map = process_env if process_env is not None else os.environ
    if shared_keys is None:
        # Prefer Settings (pydantic) when available so compose/env_file stay aligned.
        try:
            from sandbox.config import settings

            if settings.shared_env_keys:
                shared_keys = list(settings.shared_env_keys)
            else:
                shared_keys = env_map.get("SANDBOX_SHARED_ENV_KEYS", "")
        except Exception:
            shared_keys = env_map.get("SANDBOX_SHARED_ENV_KEYS", "")

    result: dict[str, str] = {}

    for key in _parse_shared_env_keys(shared_keys):
        if _is_denied_shared_key(key):
            continue
        if key not in env_map:
            continue
        value = env_map[key]
        if value is None:
            continue
        text = str(value)
        if "\x00" in text:
            continue
        result[key] = text

    for raw_key, value in env_map.items():
        if not raw_key.startswith(EXEC_ENV_PREFIX):
            continue
        child_key = raw_key[len(EXEC_ENV_PREFIX) :]
        if not child_key or not _ENV_NAME_RE.fullmatch(child_key):
            continue
        if _is_denied_shared_key(child_key) or _is_denied_shared_key(raw_key):
            continue
        if value is None:
            continue
        text = str(value)
        if "\x00" in text:
            continue
        result[child_key] = text

    return result


def safe_env(
    workspace_path: str | None = None,
    overrides: dict[str, str] | None = None,
    *,
    logical_workspace: str | None = None,
    include_shared: bool = True,
    process_env: Mapping[str, str] | None = None,
    shared_keys: str | list[str] | None = None,
) -> dict[str, str]:
    """Build a safe, minimal environment dict for subprocesses.

    Never inherits from ``os.environ`` wholesale — only explicitly set keys.

    Merge order (later wins):

    1. Base safe defaults
    2. Shared exec env (allowlist + ``SANDBOX_EXEC_ENV_*``), when ``include_shared``
    3. Per-call ``overrides`` (``env_overrides`` / process ``env``)

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

    if include_shared:
        shared = load_shared_exec_env(
            process_env=process_env,
            shared_keys=shared_keys,
        )
        env.update(shared)

    if overrides:
        for key, value in overrides.items():
            name = str(key or "")
            if not _ENV_NAME_RE.fullmatch(name):
                continue
            if value is None or "\x00" in str(value):
                continue
            # Block known service credential names only (exact denylist).
            # Broader shared-env substring rules do not apply to per-call overrides.
            if name.upper() in _SHARED_ENV_DENYLIST:
                continue
            env[name] = str(value)
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
