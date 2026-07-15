"""Bubblewrap launch-policy tests without requiring host user namespaces."""

from __future__ import annotations

from pathlib import PurePosixPath

import pytest

from sandbox.isolation import LaunchSpec
from sandbox.isolation.bubblewrap import BubblewrapIsolationBackend
from sandbox.paths import SandboxPathScope
from sandbox.services.execution_context import SandboxExecutionContext


def _context(tmp_path) -> SandboxExecutionContext:
    workspace = tmp_path / "workspaces" / "conv_a"
    temp = tmp_path / "tmp-workspaces" / "tmp_conv_a"
    workspace.mkdir(parents=True)
    temp.mkdir(parents=True)
    return SandboxExecutionContext(
        session_id="sandbox_a",
        workspace_id="conv_a",
        temp_id="tmp_conv_a",
        physical_workspace=workspace,
        physical_temp=temp,
    )


def _pairs(argv: list[str], flag: str) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for index, value in enumerate(argv):
        if value == flag:
            pairs.append((argv[index + 1], argv[index + 2]))
    return pairs


def test_bwrap_maps_workspace_temp_and_readonly_skills(tmp_path):
    context = _context(tmp_path)
    skills = tmp_path / "skills"
    skills.mkdir()
    backend = BubblewrapIsolationBackend(
        executable="/usr/bin/bwrap",
        skills_root=skills,
    )

    prepared = backend.prepare(
        LaunchSpec(
            context=context,
            argv=["bash", "-c", "pwd"],
            env_overrides={"VISIBLE": "yes"},
            network_mode="disabled",
        )
    )

    assert (str(context.physical_workspace), "/home/sandbox/workspace") in _pairs(
        prepared.argv, "--bind"
    )
    assert (str(context.physical_temp), "/tmp") in _pairs(prepared.argv, "--bind")
    readonly = _pairs(prepared.argv, "--ro-bind")
    for destination in (
        "/home/sandbox/skill",
        "/sandbox/skills",
        "/app/.pi/skills",
    ):
        assert (str(skills.resolve()), destination) in readonly
        assert (str(skills.resolve()), destination) not in _pairs(
            prepared.argv, "--bind"
        )
    for flag in (
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--clearenv",
    ):
        assert flag in prepared.argv
    assert "VISIBLE" in prepared.argv
    assert prepared.env == {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}


def test_bwrap_can_start_process_in_persistent_temp(tmp_path):
    context = _context(tmp_path)
    skills = tmp_path / "skills"
    skills.mkdir()
    backend = BubblewrapIsolationBackend(
        executable="/usr/bin/bwrap",
        skills_root=skills,
    )
    prepared = backend.prepare(
        LaunchSpec(
            context=context,
            argv=["bash", "-c", "pwd"],
            relative_cwd=PurePosixPath("service"),
            cwd_scope=SandboxPathScope.TEMP,
        )
    )
    chdir_index = prepared.argv.index("--chdir")
    assert prepared.argv[chdir_index + 1] == "/tmp/service"


def test_bwrap_rejects_unknown_network_mode(tmp_path):
    context = _context(tmp_path)
    skills = tmp_path / "skills"
    skills.mkdir()
    backend = BubblewrapIsolationBackend(executable="/usr/bin/bwrap", skills_root=skills)

    with pytest.raises(ValueError, match="network mode"):
        backend.prepare(
            LaunchSpec(
                context=context,
                argv=["bash", "-c", "echo ok"],
                network_mode="open-everything",
            )
        )


def test_bwrap_never_inherits_host_secret_environment(tmp_path, monkeypatch):
    context = _context(tmp_path)
    skills = tmp_path / "skills"
    skills.mkdir()
    monkeypatch.setenv("SANDBOX_API_TOKEN", "host-secret-that-must-not-cross")
    backend = BubblewrapIsolationBackend(executable="/usr/bin/bwrap", skills_root=skills)

    prepared = backend.prepare(
        LaunchSpec(
            context=context,
            argv=["bash", "-c", "echo ok"],
            network_mode="disabled",
        )
    )

    assert "host-secret-that-must-not-cross" not in prepared.argv
    assert "SANDBOX_API_TOKEN" not in prepared.argv
