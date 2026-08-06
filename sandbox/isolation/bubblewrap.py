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

import logging
import os
import re
import shutil
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

from sandbox.isolation.base import (
    IsolationUnavailable,
    LaunchSpec,
    PreparedLaunch,
)
from sandbox.paths import (
    AGENT_SKILL_PATH,
    AGENT_USER_SKILL_PATH,
    SandboxPathScope,
)
from sandbox.security.safe_env import safe_env

logger = logging.getLogger("sandbox.isolation.bubblewrap")

_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _inherited_capabilities() -> bool:
    """Whether the trusted service has Linux capabilities to strip at exec."""
    if not os.path.exists("/proc/self/status"):
        return False
    try:
        with open("/proc/self/status", "r", encoding="ascii", errors="replace") as fh:
            for line in fh:
                if line.startswith(("CapEff:", "CapInh:", "CapAmb:")):
                    value = line.split(":", 1)[1].strip()
                    if value and int(value, 16):
                        return True
    except (OSError, ValueError):
        return False
    return False


def _capability_drop_prefix() -> list[str]:
    """Clear service capabilities before executing Bubblewrap.

    The service may retain CAP_KILL so restart recovery can signal a verified
    orphan. Bubblewrap rejects inherited capabilities before it creates its
    user namespace, and an untrusted child must never inherit that capability.
    ``setpriv`` is part of the Linux runtime image; fail closed if it is absent
    in a capability-bearing environment.
    """
    if not _inherited_capabilities():
        return []
    setpriv = shutil.which("setpriv")
    if not setpriv:
        raise IsolationUnavailable(
            "setpriv is required to drop service capabilities before Bubblewrap"
        )
    return [setpriv, "--inh-caps=-all", "--ambient-caps=-all", "--"]



def _refresh_user_skills(context: object, user_dir: Path) -> None:
    """Reconcile this replica's copy of the caller's skills before binding.

    Deliberately swallows every failure: skills enhance an execution, and a
    database hiccup should leave the previous contents bound rather than fail
    the command outright.
    """
    org_id = getattr(context, "org_id", None)
    user_id = getattr(context, "user_id", None)
    if not org_id or not user_id:
        return
    try:
        from sandbox.services.user_skill_materializer import (
            user_skill_materializer,
        )

        user_skill_materializer.ensure_current(
            org_id=str(org_id), user_id=str(user_id), skill_dir=user_dir
        )
    except Exception:  # pragma: no cover — never block an execution
        logger.debug("user skill refresh skipped", exc_info=True)


class BubblewrapIsolationBackend:
    name = "bubblewrap"

    def __init__(
        self,
        *,
        executable: str,
        skills_root: Path,
        user_skills_root: Path | None = None,
        uid: int = 10001,
        gid: int = 10001,
    ) -> None:
        self.executable = executable
        self.skills_root = skills_root.resolve()
        # Second (user) skill tier. Optional so single-tier deployments and
        # existing tests keep working; bound read-only exactly like the first.
        self.user_skills_root = (
            user_skills_root.resolve() if user_skills_root is not None else None
        )
        self.uid = uid
        self.gid = gid

    def _skill_binds(self, context: Any = None) -> list[str]:
        """Read-only binds for the skill tiers this execution may see.

        The system tier is a hard bind: a missing bundled skill root is a
        deployment fault and bwrap should fail loudly.

        The user tier binds **only the caller's own** ``<org>/<user>``
        directory, never the whole base — otherwise a bash tool could read
        every other tenant's installed skills. The bind target keeps the same
        absolute path the Agent scanned, so ``<location>`` paths the model was
        given in its prompt resolve identically inside the sandbox.
        ``--ro-bind-try`` because an absent directory is normal (nothing
        installed yet).
        """
        args = ["--ro-bind", str(self.skills_root), AGENT_SKILL_PATH]
        if self.user_skills_root is None:
            return args
        user_dir = getattr(context, "user_skill_dir", None) if context else None
        if user_dir is None:
            # Unknown identity → system tier only. Never fall back to the base.
            return args

        # Skills are installed by the Agent, on other pods. MySQL is the
        # authority and this replica keeps a local copy, so reconcile before
        # binding — otherwise the execution sees whichever skills this
        # particular pod happened to have. Best-effort by design: a database
        # problem must not stop code from running.
        _refresh_user_skills(context, Path(user_dir))

        try:
            relative = Path(user_dir).resolve().relative_to(self.user_skills_root)
        except (ValueError, OSError):
            return args
        args.extend(
            [
                "--ro-bind-try",
                str(Path(self.user_skills_root) / relative),
                f"{AGENT_USER_SKILL_PATH}/{relative.as_posix()}",
            ]
        )
        return args

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

        args = [*_capability_drop_prefix(), self.executable]
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
        if spec.as_pid_1:
            args.append("--as-pid-1")

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

        # Tool processes see the shared Skill trees only at their canonical
        # paths, always read-only even when the Agent has an RW mount.
        args.extend(self._skill_binds(spec.context))

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
            *_capability_drop_prefix(),
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
            *self._skill_binds(),  # probe: system tier only
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
