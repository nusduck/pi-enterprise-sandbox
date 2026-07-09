"""MCP integration for the Python agent module (scaffold + thin adapter).

Existing MCP HTTP adapter lives under ``sandbox/mcp/``. This manager is the
agent-facing façade that will own config, discovery, invocation, audit, and
trace propagation once the Python agent runtime is active.
"""

from __future__ import annotations

from typing import Any

from sandbox.agent.tool_registry import ToolRegistry, ToolSpec


class MCPManager:
    """Discover MCP tools and register them into a ToolRegistry."""

    def __init__(self, registry: ToolRegistry | None = None) -> None:
        self.registry = registry or ToolRegistry()
        self._servers: list[dict[str, Any]] = []

    def load_config(self, servers: list[dict[str, Any]]) -> None:
        self._servers = list(servers)

    def list_configured_servers(self) -> list[dict[str, Any]]:
        return list(self._servers)

    def register_placeholder_tools(self) -> None:
        """Register MCP surface markers until full discovery is wired."""
        self.registry.register(
            ToolSpec(
                name="mcp_list_tools",
                description="List tools from configured MCP servers (scaffold).",
                risk_level="low",
                source="mcp",
            )
        )

    async def invoke(self, tool_name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        raise NotImplementedError(
            "MCPManager.invoke will call sandbox MCP adapter with auth + trace_id"
        )
