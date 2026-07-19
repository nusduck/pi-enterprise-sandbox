"""Bubblewrap mount/user/PID/IPC isolation backend.

Hard RLIMIT_* (CPU/AS/FSIZE/NOFILE) are applied by callers in the forked
child ``preexec_fn`` before exec of ``bwrap``.  RLIMIT_NPROC is different:
applying a low absolute limit before ``bwrap`` creates its user namespace
counts unrelated processes that share the container UID and can prevent the
namespace from being created.  When requested, NPROC is therefore lowered by
an in-namespace Bash wrapper after Bubblewrap has switched to the isolated
UID.  Do not set global ``ulimit`` / ``setrlimit`` on the Sandbox service
process.
"""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path, PurePosixPath

from sandbox.isolation.base import (
    IsolationUnavailable,
    LaunchSpec,
    PreparedLaunch,
)
from sandbox.paths import AGENT_SKILL_PATH, SandboxPathScope
from sandbox.security.safe_env import safe_env

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class BubblewrapIsolationBackend:
    name = "bubblewrap"

    def __init__(
        self,
        *,
        executable: str,
        skills_root: Path,
        uid: int = 10001,
        gid: int = 10001,
    ) -> None:
        self.executable = executable
        self.skills_root = skills_root.resolve()
        self.uid = uid
        self.gid = gid

    def _logical_cwd(
        self,
        relative: PurePosixPath,
        scope: SandboxPathScope,
    ) -> str:
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError("cwd must stay within a sandbox root")
        suffix = relative.as_posix()
        root = "/tmp" if scope is SandboxPathScope.TEMP else "/home/sandbox/workspace"
        return root if suffix in ("", ".") else f"{root}/{suffix}"

    def prepare(self, spec: LaunchSpec) -> PreparedLaunch:
        if spec.network_mode not in {"disabled", "allowlist", "unrestricted"}:
            raise ValueError(f"Unsupported sandbox network mode: {spec.network_mode!r}")
        workspace = spec.context.physical_workspace.resolve(strict=True)
        temp = spec.context.physical_temp.resolve(strict=True)
        logical_cwd = self._logical_cwd(spec.relative_cwd, spec.cwd_scope)

        args = [self.executable]
        if spec.die_with_parent:
            args.append("--die-with-parent")
        args.extend(
            [
                "--new-session",
                "--unshare-user",
                "--uid",
                str(self.uid),
                "--gid",
                str(self.gid),
                "--unshare-pid",
                "--unshare-ipc",
                "--unshare-uts",
                "--cap-drop",
                "ALL",
                # Private procfs for the new PID namespace (not the outer container view).
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--dir",
                "/run",
                "--dir",
                "/home",
                "--dir",
                "/home/sandbox",
                "--dir",
                "/var",
                "--dir",
                "/var/tmp",
                "--dir",
                "/etc",
                "--dir",
                "/app",
            ]
        )

        # disabled → empty netns (--unshare-net): real fail-closed isolation.
        # allowlist/unrestricted → share the container network (command policy
        # only). There is no per-child controlled egress proxy yet, and
        # container-wide iptables is intentionally not used. Production
        # validation rejects allowlist/unrestricted so this branch is
        # development-only and must not be described as isolated egress.
        if spec.network_mode == "disabled":
            args.append("--unshare-net")

        for path in ("/usr", "/bin", "/sbin", "/lib", "/lib64", "/usr/local"):
            args.extend(["--ro-bind-try", path, path])
        args.extend(["--ro-bind-try", "/app/.venv", "/app/.venv"])

        for path in (
            "/etc/passwd",
            "/etc/group",
            "/etc/nsswitch.conf",
            "/etc/hosts",
            "/etc/resolv.conf",
            "/etc/ssl",
            "/etc/ca-certificates",
            "/etc/ld.so.cache",
            "/etc/localtime",
        ):
            args.extend(["--ro-bind-try", path, path])

        # Tool processes see the shared Skill tree only at the canonical path,
        # always read-only even when the Agent has an RW development mount.
        args.extend(["--ro-bind", str(self.skills_root), AGENT_SKILL_PATH])

        args.extend(
            [
                "--bind",
                str(workspace),
                "/home/sandbox/workspace",
                "--bind",
                str(temp),
                "/tmp",
                "--clearenv",
            ]
        )

        env = safe_env(overrides=dict(spec.env_overrides))
        env.update(
            {
                "HOME": "/home/sandbox",
                "PWD": logical_cwd,
                "TMPDIR": "/tmp",
            }
        )
        for key, value in env.items():
            if not _ENV_NAME.fullmatch(key) or "\x00" in str(value):
                raise ValueError(f"Invalid environment variable: {key!r}")
            args.extend(["--setenv", key, str(value)])

        command = list(spec.argv)
        nproc_limit_applied_inside_namespace = False
        if int(spec.max_process_count or 0) > 0:
            # Bash is part of the Sandbox image and is mounted read-only above.
            # Lower both soft and hard limits so the untrusted command cannot
            # raise the limit again after the wrapper execs it.
            command = [
                "/bin/bash",
                "-c",
                'set -eu; limit="$1"; shift; ulimit -S -u "$limit"; ulimit -H -u "$limit"; exec "$@"',
                "--",
                str(int(spec.max_process_count)),
                *command,
            ]
            nproc_limit_applied_inside_namespace = True

        args.extend(["--chdir", logical_cwd, "--", *command])
        return PreparedLaunch(
            argv=args,
            cwd=None,
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
            backend=self.name,
            nproc_limit_applied_inside_namespace=nproc_limit_applied_inside_namespace,
        )

    def preflight(self) -> None:
        if not os.path.isfile(self.executable) or not os.access(self.executable, os.X_OK):
            raise IsolationUnavailable(f"Bubblewrap executable unavailable: {self.executable}")
        cmd = [
            self.executable,
            "--die-with-parent",
            "--new-session",
            "--unshare-user",
            "--uid",
            str(self.uid),
            "--gid",
            str(self.gid),
            "--unshare-pid",
            "--unshare-ipc",
            "--unshare-uts",
            "--unshare-net",
            "--cap-drop",
            "ALL",
            # Private procfs for the new PID namespace (not the outer container view).
            "--proc",
            "/proc",
            "--dev",
            "/dev",
            "--dir",
            "/home",
            "--dir",
            "/home/sandbox",
            "--ro-bind-try",
            "/usr",
            "/usr",
            "--ro-bind-try",
            "/bin",
            "/bin",
            "--ro-bind-try",
            "/lib",
            "/lib",
            "--ro-bind-try",
            "/lib64",
            "/lib64",
            "--ro-bind-try",
            "/usr/local",
            "/usr/local",
            "--ro-bind",
            str(self.skills_root),
            AGENT_SKILL_PATH,
            "--clearenv",
            "--setenv",
            "PATH",
            "/usr/bin:/bin",
            "--setenv",
            "HOME",
            "/home/sandbox",
            "--",
            "/usr/bin/true",
        ]
        try:
            result = subprocess.run(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                timeout=10,
                check=False,
                env={"PATH": "/usr/bin:/bin"},
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise IsolationUnavailable(f"Bubblewrap preflight failed: {exc}") from exc
        if result.returncode != 0:
            detail = result.stderr.decode("utf-8", errors="replace").strip()[:500]
            raise IsolationUnavailable(
                f"Bubblewrap preflight exited {result.returncode}: {detail}"
            )
