"""MCP no longer in-process-calls the Python execution surface (Wave 6).

The facade talks to exec over HTTP (`sandbox.mcp.sandbox_client`). Direct
filesystem/process helpers lived here for the old internal bridge and are gone.
"""

from __future__ import annotations

from typing import Any


class McpSandboxRuntime:
    """Stub: in-process sandbox runtime was deleted with the Python exec plane."""

    def ensure_context(self, sandbox_session_id: str, workspace_id: str) -> dict[str, str]:
        raise RuntimeError(
            'MCP in-process sandbox runtime was removed; use exec HTTP via SandboxBridgeClient'
        )

    def execute_python(self, **kwargs: Any) -> dict[str, Any]:
        raise RuntimeError(
            'MCP in-process sandbox runtime was removed; use exec HTTP via SandboxBridgeClient'
        )
