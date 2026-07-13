"""Explicit development-only direct subprocess backend."""

from __future__ import annotations

from sandbox.isolation.base import LaunchSpec, PreparedLaunch
from sandbox.paths import SandboxPathScope
from sandbox.security.safe_env import safe_env


class DirectIsolationBackend:
    name = "direct"

    def prepare(self, spec: LaunchSpec) -> PreparedLaunch:
        relative = spec.relative_cwd.as_posix()
        if spec.relative_cwd.is_absolute() or ".." in spec.relative_cwd.parts:
            raise ValueError("cwd must stay within the workspace")
        root = (
            spec.context.physical_temp
            if spec.cwd_scope is SandboxPathScope.TEMP
            else spec.context.physical_workspace
        )
        physical_cwd = (root / relative).resolve()
        if not physical_cwd.is_relative_to(root):
            raise ValueError("cwd escapes sandbox root")
        physical_cwd.mkdir(parents=True, exist_ok=True)
        env = safe_env(
            workspace_path=str(spec.context.physical_workspace),
            overrides=dict(spec.env_overrides),
            logical_workspace=".",
        )
        # Direct mode cannot remap /tmp, but libraries honoring TMPDIR still use
        # the conversation-owned persistent temp tree.
        env["TMPDIR"] = str(spec.context.physical_temp)
        return PreparedLaunch(
            argv=list(spec.argv),
            cwd=str(physical_cwd),
            env=env,
            backend=self.name,
        )

    def preflight(self) -> None:
        return None
