"""Unified Tool Registry — Sandbox / Process / Skill / MCP / Artifact / Enterprise HTTP.

ADR 0002 §4.6: all agent tool sources are registered under one catalog so
discovery, allowlist, policy, and ledger can share a single naming scheme.

Categories (stable string ids):

- ``sandbox`` — file read/write/edit/bash/search
- ``process`` — managed long-running process tools
- ``skill`` — skill install/edit/reload (development mode)
- ``mcp`` — tools discovered from registered MCP servers
- ``artifact`` — submit / list deliverables
- ``enterprise_http`` — org-configured HTTP connectors (skeleton)

This module is the Python-side catalog. The Node agent keeps a parallel
``tool-registry.js`` that builds the pi-coding-agent tool allowlist from the
same categories; MCP tool names are namespaced as ``mcp_<server>_<tool>``.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Iterable


class ToolCategory(str, Enum):
    SANDBOX = "sandbox"
    PROCESS = "process"
    SKILL = "skill"
    MCP = "mcp"
    ARTIFACT = "artifact"
    ENTERPRISE_HTTP = "enterprise_http"


# Tool registry schema version echoed on agent sessions / audits.
TOOL_REGISTRY_VERSION = "2026-07-12.b5"


@dataclass
class RegisteredTool:
    """One entry in the unified registry."""

    name: str
    category: ToolCategory
    description: str = ""
    risk_level: str = "medium"  # low | medium | high
    input_schema: dict[str, Any] = field(default_factory=dict)
    server_id: str | None = None  # MCP only
    allowlist_required: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "category": self.category.value
            if isinstance(self.category, ToolCategory)
            else str(self.category),
            "description": self.description,
            "risk_level": self.risk_level,
            "input_schema": self.input_schema or {},
            "server_id": self.server_id,
            "allowlist_required": self.allowlist_required,
            "metadata": self.metadata or {},
        }


# Built-in catalog (static; MCP tools are added dynamically by MCPManager).
_BUILTIN: list[RegisteredTool] = [
    # Sandbox
    RegisteredTool("read", ToolCategory.SANDBOX, "Read a workspace file", "low"),
    RegisteredTool("write", ToolCategory.SANDBOX, "Write a workspace file", "medium"),
    RegisteredTool("edit", ToolCategory.SANDBOX, "Edit a workspace file", "medium"),
    RegisteredTool("apply_patch", ToolCategory.SANDBOX, "Apply unified patch", "medium"),
    RegisteredTool("bash", ToolCategory.SANDBOX, "Run short shell command", "medium"),
    RegisteredTool("ls", ToolCategory.SANDBOX, "List directory", "low"),
    RegisteredTool("find", ToolCategory.SANDBOX, "Find files by pattern", "low"),
    RegisteredTool("grep", ToolCategory.SANDBOX, "Search file contents", "low"),
    # Process
    RegisteredTool("process_start", ToolCategory.PROCESS, "Start managed process", "medium"),
    RegisteredTool("process_status", ToolCategory.PROCESS, "Process status", "low"),
    RegisteredTool("process_logs", ToolCategory.PROCESS, "Process logs", "low"),
    RegisteredTool("process_wait", ToolCategory.PROCESS, "Wait for process", "low"),
    RegisteredTool("process_write_stdin", ToolCategory.PROCESS, "Write process stdin", "medium"),
    RegisteredTool("process_signal", ToolCategory.PROCESS, "Signal process", "high"),
    RegisteredTool("process_cancel", ToolCategory.PROCESS, "Cancel process", "medium"),
    # Skill
    RegisteredTool("skill_install", ToolCategory.SKILL, "Install skill", "high"),
    RegisteredTool("skill_edit", ToolCategory.SKILL, "Edit skill file", "high"),
    RegisteredTool("skill_reload", ToolCategory.SKILL, "Reload skills", "medium"),
    # Artifact
    RegisteredTool("submit_artifact", ToolCategory.ARTIFACT, "Submit deliverable", "medium"),
]


class ToolRegistry:
    """In-process unified tool catalog.

    Built-ins are always present. MCP / enterprise HTTP tools are registered
    at runtime by their managers.
    """

    def __init__(self) -> None:
        self._tools: dict[str, RegisteredTool] = {}
        for tool in _BUILTIN:
            self._tools[tool.name] = tool
        self._dynamic_providers: list[Callable[[], Iterable[RegisteredTool]]] = []

    @property
    def version(self) -> str:
        return TOOL_REGISTRY_VERSION

    def register(self, tool: RegisteredTool) -> RegisteredTool:
        """Register or replace a tool entry."""
        if not tool.name:
            raise ValueError("tool name is required")
        self._tools[tool.name] = tool
        return tool

    def unregister(self, name: str) -> bool:
        return self._tools.pop(name, None) is not None

    def unregister_by_server(self, server_id: str) -> int:
        """Remove all MCP tools for a server. Returns count removed."""
        doomed = [
            n
            for n, t in self._tools.items()
            if t.server_id == server_id or (t.metadata or {}).get("server_id") == server_id
        ]
        for n in doomed:
            del self._tools[n]
        return len(doomed)

    def add_provider(self, provider: Callable[[], Iterable[RegisteredTool]]) -> None:
        """Register a dynamic provider (e.g. MCPManager.list_registered_tools)."""
        self._dynamic_providers.append(provider)

    def get(self, name: str) -> RegisteredTool | None:
        self._refresh_dynamic()
        return self._tools.get(name)

    def list_tools(
        self,
        *,
        category: ToolCategory | str | None = None,
        names: Iterable[str] | None = None,
    ) -> list[RegisteredTool]:
        self._refresh_dynamic()
        cat = None
        if category is not None:
            cat = (
                category
                if isinstance(category, ToolCategory)
                else ToolCategory(str(category))
            )
        name_set = set(names) if names is not None else None
        out: list[RegisteredTool] = []
        for tool in self._tools.values():
            if cat is not None and tool.category != cat:
                continue
            if name_set is not None and tool.name not in name_set:
                continue
            out.append(tool)
        out.sort(key=lambda t: (t.category.value, t.name))
        return out

    def list_by_category(self) -> dict[str, list[dict[str, Any]]]:
        grouped: dict[str, list[dict[str, Any]]] = {c.value: [] for c in ToolCategory}
        for tool in self.list_tools():
            key = (
                tool.category.value
                if isinstance(tool.category, ToolCategory)
                else str(tool.category)
            )
            grouped.setdefault(key, []).append(tool.to_dict())
        return grouped

    def allowlist(
        self,
        *,
        include_skill: bool = False,
        include_mcp: bool = True,
        include_enterprise_http: bool = True,
    ) -> list[str]:
        """Names suitable for createAgentSession tools allowlist."""
        names: list[str] = []
        for tool in self.list_tools():
            cat = tool.category
            if cat == ToolCategory.SKILL and not include_skill:
                continue
            if cat == ToolCategory.MCP and not include_mcp:
                continue
            if cat == ToolCategory.ENTERPRISE_HTTP and not include_enterprise_http:
                continue
            names.append(tool.name)
        return names

    def categories(self) -> list[str]:
        return [c.value for c in ToolCategory]

    def _refresh_dynamic(self) -> None:
        for provider in list(self._dynamic_providers):
            try:
                for tool in provider() or []:
                    if isinstance(tool, RegisteredTool) and tool.name:
                        self._tools[tool.name] = tool
            except Exception:
                # Providers must not break registry reads
                continue


# Module singleton
tool_registry = ToolRegistry()
