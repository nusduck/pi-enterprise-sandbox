"""Unified tool registry for sandbox + MCP tools."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Awaitable


ToolHandler = Callable[..., Awaitable[dict[str, Any]] | dict[str, Any]]


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any] = field(default_factory=dict)
    risk_level: str = "medium"
    source: str = "sandbox"  # sandbox | mcp
    handler: ToolHandler | None = None


class ToolRegistry:
    """Register and look up tools by name."""

    def __init__(self) -> None:
        self._tools: dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        self._tools[spec.name] = spec

    def get(self, name: str) -> ToolSpec | None:
        return self._tools.get(name)

    def list_names(self) -> list[str]:
        return sorted(self._tools.keys())

    def list_specs(self) -> list[ToolSpec]:
        return [self._tools[n] for n in self.list_names()]

    def register_defaults(self) -> None:
        """Register the core sandbox tool names used by the agent allowlist."""
        for name, desc, risk in [
            ("read", "Read file contents from the sandbox workspace.", "low"),
            ("write", "Write a private file (does not share with user).", "medium"),
            ("edit", "Edit a private workspace file.", "medium"),
            ("bash", "Run a shell command in the sandbox.", "medium"),
            ("submit_artifact", "Submit a file as a user deliverable (P7).", "low"),
        ]:
            self.register(ToolSpec(name=name, description=desc, risk_level=risk, source="sandbox"))
