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


@dataclass(frozen=True)
class PreparedLaunch:
    argv: list[str]
    cwd: str | None
    env: dict[str, str]
    backend: str


class IsolationBackend(Protocol):
    name: str

    def prepare(self, spec: LaunchSpec) -> PreparedLaunch: ...

    def preflight(self) -> None: ...
