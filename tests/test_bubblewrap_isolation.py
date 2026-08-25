"""Bubblewrap launch-policy tests without requiring host user namespaces."""

from __future__ import annotations

import subprocess
from pathlib import PurePosixPath

import pytest

from sandbox.isolation import LaunchSpec
from sandbox.isolation.bubblewrap import BubblewrapIsolationBackend
from sandbox.isolation import bubblewrap as bubblewrap_module
from sandbox.paths import SandboxPathScope
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.process_handle_store import (
    FakeFormalProcessRepository,
    FormalProcessDualWriter,
)
from dataclasses import replace

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


def test_bwrap_durable_process_can_make_command_pid_namespace_init(tmp_path):
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
            as_pid_1=True,
        )
    )

    assert "--as-pid-1" in prepared.argv


def test_bwrap_drops_trusted_service_capabilities_before_exec(tmp_path, monkeypatch):
    context = _context(tmp_path)
    skills = tmp_path / "skills"
    skills.mkdir()
    backend = BubblewrapIsolationBackend(
        executable="/usr/bin/bwrap",
        skills_root=skills,
    )
    monkeypatch.setattr(bubblewrap_module, "_inherited_capabilities", lambda: True)
    monkeypatch.setattr(bubblewrap_module.shutil, "which", lambda name: "/usr/bin/setpriv")

    prepared = backend.prepare(
        LaunchSpec(context=context, argv=["true"], network_mode="disabled")
    )

    assert prepared.argv[:5] == [
        "/usr/bin/setpriv",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        "/usr/bin/bwrap",
    ]


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
    assert isolation.spec.as_pid_1 is True


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


def test_bwrap_binds_only_the_callers_own_user_skill_dir(tmp_path, monkeypatch):
    """Installed skills are executable, read-only, and never cross-tenant."""
    from sandbox.config import settings

    context = _context(tmp_path)
    skills = tmp_path / "skills"
    skills.mkdir()
    user_base = tmp_path / "skills-user"
    org, user, other_user = "org1", "user1", "user2"
    mine = user_base / org / user
    mine.mkdir(parents=True)
    (user_base / org / other_user).mkdir(parents=True)

    monkeypatch.setattr(settings, "user_skills_root", str(user_base))
    owned = replace(context, org_id=org, user_id=user)

    backend = BubblewrapIsolationBackend(
        executable="/usr/bin/bwrap",
        skills_root=skills,
        user_skills_root=user_base,
    )
    prepared = backend.prepare(
        LaunchSpec(
            context=owned,
            argv=["bash", "-c", "pwd"],
            env_overrides={},
            network_mode="disabled",
        )
    )

    # System tier: hard bind at its canonical path.
    assert (str(skills.resolve()), "/home/sandbox/skill") in _pairs(
        prepared.argv, "--ro-bind"
    )
    # User tier: only this caller's directory, at the same absolute path the
    # Agent scanned, so prompt <location> paths resolve identically.
    assert (
        str(mine.resolve()),
        f"/home/sandbox/skill-user/{org}/{user}",
    ) in _pairs(prepared.argv, "--ro-bind-try")

    # The shared base and the sibling user are never bound.
    argv = " ".join(prepared.argv)
    assert str(user_base.resolve()) + " " not in argv
    assert other_user not in argv

    # Neither tier is ever writable.
    writable = _pairs(prepared.argv, "--bind")
    assert (str(mine.resolve()), f"/home/sandbox/skill-user/{org}/{user}") not in writable
    assert (str(skills.resolve()), "/home/sandbox/skill") not in writable


def test_bwrap_omits_user_skill_tier_without_identity(tmp_path):
    """Unknown owner falls back to the system tier, never the shared base."""
    context = _context(tmp_path)
    skills = tmp_path / "skills"
    skills.mkdir()
    user_base = tmp_path / "skills-user"
    user_base.mkdir()

    backend = BubblewrapIsolationBackend(
        executable="/usr/bin/bwrap",
        skills_root=skills,
        user_skills_root=user_base,
    )
    prepared = backend.prepare(
        LaunchSpec(
            context=context,  # no org_id / user_id
            argv=["bash", "-c", "pwd"],
            env_overrides={},
            network_mode="disabled",
        )
    )

    assert (str(skills.resolve()), "/home/sandbox/skill") in _pairs(
        prepared.argv, "--ro-bind"
    )
    assert "/home/sandbox/skill-user" not in " ".join(prepared.argv)


def test_bwrap_names_the_missing_skill_root_instead_of_failing_at_launch(
    tmp_path,
):
    """A missing system skill root must be diagnosable.

    The system tier is a hard ``--ro-bind``, so an absent root used to surface
    only once bwrap ran, as ``bwrap: can't find source path ...``. Every
    sandboxed command failed at once — bash, python, even ``pwd`` — which reads
    as "the tools are broken" rather than "a mount is missing". Fail before
    launch, naming the path and the mount to check.
    """
    context = _context(tmp_path)
    missing = tmp_path / "skills-that-were-never-mounted"
    backend = BubblewrapIsolationBackend(
        executable="/usr/bin/bwrap",
        skills_root=missing,
    )

    with pytest.raises(ValueError) as excinfo:
        backend.prepare(
            LaunchSpec(
                context=context,
                argv=["bash", "-c", "pwd"],
                env_overrides={},
                network_mode="disabled",
                relative_cwd=PurePosixPath("."),
                cwd_scope=SandboxPathScope.WORKSPACE,
            )
        )

    message = str(excinfo.value)
    assert "skill root is missing" in message
    assert str(missing) in message
    assert "SKILLS_ROOT" in message


def test_bwrap_still_launches_when_only_the_user_skill_tier_is_absent(tmp_path):
    """A user with nothing installed must not lose bash/python."""
    context = _context(tmp_path)
    skills = tmp_path / "skills"
    skills.mkdir()
    user_base = tmp_path / "skill-user"
    user_base.mkdir()
    backend = BubblewrapIsolationBackend(
        executable="/usr/bin/bwrap",
        skills_root=skills,
        user_skills_root=user_base,
    )

    prepared = backend.prepare(
        LaunchSpec(
            context=replace(context, org_id="org_a", user_id="user_a"),
            argv=["bash", "-c", "pwd"],
            env_overrides={},
            network_mode="disabled",
            relative_cwd=PurePosixPath("."),
            cwd_scope=SandboxPathScope.WORKSPACE,
        )
    )

    # Tolerant bind for the tier that is legitimately empty.
    assert "--ro-bind-try" in prepared.argv
    assert prepared.argv[-1] == "pwd"
