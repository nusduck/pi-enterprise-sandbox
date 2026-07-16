"""Shared execution env: allowlist + SANDBOX_EXEC_ENV_* prefix, hard denylist."""

from __future__ import annotations

import os

import pytest

from sandbox.security.safe_env import (
    EXEC_ENV_PREFIX,
    load_shared_exec_env,
    safe_env,
)


def test_shared_keys_from_process_env():
    process = {
        "SANDBOX_SHARED_ENV_KEYS": "MY_API_KEY,BASE_URL",
        "MY_API_KEY": "sk-test",
        "BASE_URL": "https://example.com",
        "UNRELATED": "nope",
    }
    shared = load_shared_exec_env(process_env=process, shared_keys=None)
    assert shared == {
        "MY_API_KEY": "sk-test",
        "BASE_URL": "https://example.com",
    }


def test_exec_env_prefix_injection():
    process = {
        f"{EXEC_ENV_PREFIX}MY_API_KEY": "from-prefix",
        f"{EXEC_ENV_PREFIX}BASE_URL": "https://prefixed.example",
        "SANDBOX_API_TOKEN": "must-not-leak",
    }
    shared = load_shared_exec_env(process_env=process, shared_keys="")
    assert shared == {
        "MY_API_KEY": "from-prefix",
        "BASE_URL": "https://prefixed.example",
    }
    assert "SANDBOX_API_TOKEN" not in shared
    assert "must-not-leak" not in shared.values()


def test_denylist_blocks_service_credentials_even_if_allowlisted():
    process = {
        "SANDBOX_SHARED_ENV_KEYS": "SANDBOX_API_TOKEN,MY_OK,DATABASE_URL",
        "SANDBOX_API_TOKEN": "secret-token",
        "MY_OK": "ok",
        "DATABASE_URL": "postgres://x",
        f"{EXEC_ENV_PREFIX}JWT_SECRET": "jwt-secret",
        f"{EXEC_ENV_PREFIX}APP_TOKEN": "app-ok",
    }
    shared = load_shared_exec_env(process_env=process)
    assert shared == {"MY_OK": "ok", "APP_TOKEN": "app-ok"}
    assert "secret-token" not in shared.values()
    assert "jwt-secret" not in shared.values()


def test_safe_env_merge_order_overrides_win():
    process = {
        "SANDBOX_SHARED_ENV_KEYS": "FOO,BAR",
        "FOO": "shared-foo",
        "BAR": "shared-bar",
        f"{EXEC_ENV_PREFIX}BAR": "prefix-bar",
    }
    env = safe_env(
        workspace_path="/tmp/ws",
        overrides={"FOO": "override-foo", "BAZ": "only-override"},
        process_env=process,
        shared_keys=["FOO", "BAR"],
    )
    assert env["FOO"] == "override-foo"
    assert env["BAR"] == "prefix-bar"  # prefix applied inside shared map after keys
    assert env["BAZ"] == "only-override"
    assert env["HOME"] == "/tmp/ws"
    assert env["PWD"] == "."
    assert "PATH" in env


def test_safe_env_include_shared_false_skips_injection():
    process = {
        "SANDBOX_SHARED_ENV_KEYS": "FOO",
        "FOO": "should-skip",
        f"{EXEC_ENV_PREFIX}BAR": "should-skip-too",
    }
    env = safe_env(
        overrides={"KEEP": "yes"},
        include_shared=False,
        process_env=process,
    )
    assert "FOO" not in env
    assert "BAR" not in env
    assert env["KEEP"] == "yes"


def test_overrides_cannot_inject_exact_service_token_name():
    env = safe_env(
        overrides={"SANDBOX_API_TOKEN": "sneaky", "APP_KEY": "ok"},
        include_shared=False,
    )
    assert "SANDBOX_API_TOKEN" not in env
    assert env["APP_KEY"] == "ok"


def test_bwrap_shared_env_reaches_setenv(tmp_path, monkeypatch):
    from sandbox.isolation import LaunchSpec
    from sandbox.isolation.bubblewrap import BubblewrapIsolationBackend
    from sandbox.services.execution_context import SandboxExecutionContext

    workspace = tmp_path / "workspaces" / "conv_a"
    temp = tmp_path / "tmp-workspaces" / "tmp_conv_a"
    workspace.mkdir(parents=True)
    temp.mkdir(parents=True)
    skills = tmp_path / "skills"
    skills.mkdir()

    monkeypatch.setenv("SANDBOX_SHARED_ENV_KEYS", "SHARED_KEY")
    monkeypatch.setenv("SHARED_KEY", "shared-value")
    monkeypatch.setenv(f"{EXEC_ENV_PREFIX}PREFIX_KEY", "prefix-value")
    monkeypatch.setenv("SANDBOX_API_TOKEN", "host-secret-that-must-not-cross")

    # Reset Settings cache if any — Settings is a singleton instance.
    # load_shared_exec_env reads os.environ when process_env is None.
    backend = BubblewrapIsolationBackend(executable="/usr/bin/bwrap", skills_root=skills)
    context = SandboxExecutionContext(
        session_id="sandbox_a",
        workspace_id="conv_a",
        temp_id="tmp_conv_a",
        physical_workspace=workspace,
        physical_temp=temp,
    )
    prepared = backend.prepare(
        LaunchSpec(
            context=context,
            argv=["bash", "-c", "echo ok"],
            env_overrides={"PER_CALL": "yes"},
            network_mode="disabled",
        )
    )

    argv = prepared.argv
    # Collect --setenv pairs
    setenv: dict[str, str] = {}
    for i, value in enumerate(argv):
        if value == "--setenv" and i + 2 < len(argv):
            setenv[argv[i + 1]] = argv[i + 2]

    assert setenv.get("SHARED_KEY") == "shared-value"
    assert setenv.get("PREFIX_KEY") == "prefix-value"
    assert setenv.get("PER_CALL") == "yes"
    assert "SANDBOX_API_TOKEN" not in setenv
    assert "host-secret-that-must-not-cross" not in argv


def test_password_substring_blocked_in_shared_but_ok_in_app_named_key():
    process = {
        "SANDBOX_SHARED_ENV_KEYS": "POSTGRES_PASSWORD,MY_OK",
        "POSTGRES_PASSWORD": "db-pass",
        "MY_OK": "fine",
        f"{EXEC_ENV_PREFIX}REDIS_CONTROL_PASSWORD": "redis-pass",
    }
    shared = load_shared_exec_env(process_env=process)
    assert shared == {"MY_OK": "fine"}
