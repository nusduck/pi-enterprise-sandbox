"""Bubblewrap launch-policy tests without requiring host user namespaces."""

from __future__ import annotations

import subprocess
from pathlib import PurePosixPath

import pytest

from sandbox.isolation import LaunchSpec
from sandbox.isolation.bubblewrap import BubblewrapIsolationBackend
from sandbox.paths import SandboxPathScope
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.process_handle_store import (
    FakeFormalProcessRepository,
    FormalProcessDualWriter,
)
from sandbox.services.process_manager import ProcessManager


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
    assert readonly == [(str(skills.resolve()), "/home/sandbox/skill")]
    assert (str(skills.resolve()), "/home/sandbox/skill") not in _pairs(
        prepared.argv, "--bind"
    )
    for flag in (
        "--die-with-parent",
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--clearenv",
    ):
        assert flag in prepared.argv
    # Private procfs (not outer --bind /proc /proc).
    assert "--proc" in prepared.argv
    proc_idx = prepared.argv.index("--proc")
    assert prepared.argv[proc_idx + 1] == "/proc"
    # Must not bind the outer container /proc view.
    bind_pairs = _pairs(prepared.argv, "--bind")
    assert ("/proc", "/proc") not in bind_pairs
    assert "VISIBLE" in prepared.argv
    assert prepared.env == {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}


def test_bwrap_durable_process_can_outlive_api_parent(tmp_path):
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
            argv=["bash", "-c", "sleep 120"],
            network_mode="disabled",
            die_with_parent=False,
        )
    )

    assert "--die-with-parent" not in prepared.argv
    assert "--new-session" in prepared.argv


def test_process_manager_disables_die_with_parent_for_durable_handle(
    tmp_path, monkeypatch
):
    class CapturingIsolation:
        name = "capturing"

        def __init__(self):
            self.spec = None

        def prepare(self, spec):
            self.spec = spec
            raise ValueError("stop after policy capture")

    context = _context(tmp_path)
    context = SandboxExecutionContext(
        session_id=context.session_id,
        workspace_id=context.workspace_id,
        temp_id=context.temp_id,
        physical_workspace=context.physical_workspace,
        physical_temp=context.physical_temp,
        user_id="01ARZ3NDEKTSV4RRFFQ69G5FB1",
    )
    isolation = CapturingIsolation()
    manager = ProcessManager(
        isolation_backend=isolation,
        formal_dual_writer=FormalProcessDualWriter(
            FakeFormalProcessRepository(), authoritative=True
        ),
    )

    result = manager.start(
        session_id=context.session_id,
        command="sleep 120",
        context=context,
        org_id="01ARZ3NDEKTSV4RRFFQ69G5FAV",
        sandbox_session_id="01ARZ3NDEKTSV4RRFFQ69G5FAV",
        run_id="01ARZ3NDEKTSV4RRFFQ69G5FAV",
        execution_id="01ARZ3NDEKTSV4RRFFQ69G5FAV",
    )

    assert result["status"] == "failed"
    assert isolation.spec is not None
    assert isolation.spec.die_with_parent is False


def test_bwrap_defers_nproc_until_after_user_namespace(tmp_path):
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
            argv=["bash", "-c", "printf ok"],
            network_mode="disabled",
            max_process_count=20,
        )
    )

    assert prepared.nproc_limit_applied_inside_namespace is True
    command = prepared.argv[prepared.argv.index("--") + 1 :]
    assert command[:2] == ["/bin/bash", "-c"]
    assert "ulimit -S -u" in command[2]
    assert "ulimit -H -u" in command[2]
    assert command[4] == "20"
    assert command[5:] == ["bash", "-c", "printf ok"]


def test_bwrap_does_not_add_nproc_wrapper_when_unrequested(tmp_path):
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
            argv=["bash", "-c", "printf ok"],
            network_mode="disabled",
        )
    )

    assert prepared.nproc_limit_applied_inside_namespace is False
    assert prepared.argv[prepared.argv.index("--") + 1 :] == [
        "bash",
        "-c",
        "printf ok",
    ]


def test_bwrap_preflight_uses_private_proc():
    """Preflight argv must also use private --proc (static contract)."""
    from pathlib import Path

    source = Path("sandbox/isolation/bubblewrap.py").read_text(encoding="utf-8")
    assert '"--proc"' in source or "'--proc'" in source
    # Outer-container proc bind is forbidden in both prepare and preflight.
    assert '"--bind",\n            "/proc"' not in source
    assert "'--bind', '/proc'" not in source
    # Do not claim real process isolation from argv-only unit tests.
    assert "--unshare-cgroup" not in source  # deferred unless container-proven
    # RLIMIT is applied by callers' preexec before exec of bwrap — not here.
    assert "import resource" not in source
    assert "resource.setrlimit" not in source
    assert "RLIMIT" in source  # documented inheritance contract


def test_bwrap_preflight_exercises_launch_namespace_policy(tmp_path, monkeypatch):
    executable = tmp_path / "bwrap"
    executable.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    executable.chmod(0o755)
    skills = tmp_path / "skills"
    skills.mkdir()
    captured: dict[str, object] = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["kwargs"] = kwargs
        return subprocess.CompletedProcess(cmd, 0, b"", b"")

    monkeypatch.setattr(subprocess, "run", fake_run)
    backend = BubblewrapIsolationBackend(
        executable=str(executable),
        skills_root=skills,
        uid=12345,
        gid=12346,
    )

    backend.preflight()

    cmd = captured["cmd"]
    assert isinstance(cmd, list)
    for flag in (
        "--unshare-user",
        "--unshare-pid",
        "--unshare-ipc",
        "--unshare-uts",
        "--unshare-net",
        "--cap-drop",
        "--proc",
        "--clearenv",
    ):
        assert flag in cmd
    assert cmd[cmd.index("--uid") + 1] == "12345"
    assert cmd[cmd.index("--gid") + 1] == "12346"
    assert cmd[cmd.index("--cap-drop") + 1] == "ALL"
    assert (str(skills.resolve()), "/home/sandbox/skill") in _pairs(
        cmd, "--ro-bind"
    )


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
