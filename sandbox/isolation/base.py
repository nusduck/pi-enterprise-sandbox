"""Isolation backend contracts."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Mapping, Protocol, Sequence

from sandbox.paths import SandboxPathScope
from sandbox.services.execution_context import SandboxExecutionContext


class IsolationUnavailable(RuntimeError):
    """Configured isolation backend cannot safely launch processes."""


@dataclass(frozen=True)
class LaunchSpec:
    context: SandboxExecutionContext
    argv: Sequence[str]
    relative_cwd: PurePosixPath = PurePosixPath(".")
    cwd_scope: SandboxPathScope = SandboxPathScope.WORKSPACE
    env_overrides: Mapping[str, str] = field(default_factory=dict)
    network_mode: str = "disabled"
    # Bubblewrap normally follows its API parent so ordinary tool execution
    # cannot outlive a cancelled request. Durable Process Handles are the one
    # exception: ProcessManager disables this flag so startup recovery can
    # observe and terminate the orphan safely after a service restart.
    die_with_parent: bool = True
    # Durable Process Handles make the command the PID-namespace init. If the
    # service restarts, killing that init causes the kernel to terminate every
    # remaining descendant in the private PID namespace.
    as_pid_1: bool = False
    # RLIMIT_NPROC cannot be installed before Bubblewrap creates its user
    # namespace: the wrapper otherwise counts every process for the shared
    # container UID and may prevent Bubblewrap itself from starting.  The
    # Bubblewrap backend applies this value after entering the private
    # namespace; direct backends keep applying it in the caller's preexec.
    max_process_count: int = 0


@dataclass(frozen=True)
class PreparedLaunch:
    argv: list[str]
    cwd: str | None
    env: dict[str, str]
    backend: str
    nproc_limit_applied_inside_namespace: bool = False


class IsolationBackend(Protocol):
    name: str

    def prepare(self, spec: LaunchSpec) -> PreparedLaunch: ...

    def preflight(self) -> None: ...
