"""Enterprise Tool Policy — risk-based decision for Pi tool routing.

Mirrors the Sandbox-side ``ToolPolicyChecker`` but runs on the Agent side
as a pre-check before even calling the Sandbox HTTP API.
"""

from __future__ import annotations

from typing import Any

# ── Risk levels ────────────────────────────────────────────────────────

LOW_RISK_TOOLS = {"read", "read_file", "list_files", "preview_file", "view_file", "grep", "find", "ls", "cat", "head", "tail"}
MEDIUM_RISK_TOOLS = {"write", "write_file", "edit", "edit_file", "bash", "command", "python", "run_python"}
HIGH_RISK_TOOLS = {"raw_bash", "delete_file", "network_request", "pip_install", "npm_install", "kill_process", "raw_shell"}

# Commands never allowed
BLOCKED_COMMANDS = [
    "sudo", "su ", "chmod 777", "chown ", "rm -rf /", "rm -rf /*",
    "dd if=", "mkfs.", "fdisk", "> /dev/", "< /dev/",
]


class EnterpriseToolPolicy:
    """Agent-side tool policy checker.

    Runs before the HTTP call to Sandbox, providing fast rejection for
    clearly disallowed operations and determining risk level for audit.
    """

    def check(self, tool_name: str, params: dict[str, Any]) -> dict[str, Any]:
        """Check if a tool call is allowed. Returns decision dict.

        Returns
        -------
        dict with keys: allowed (bool), reason (str), risk_level (str)
        """
        risk_level = self._risk_level(tool_name)

        # High risk = default deny
        if tool_name in HIGH_RISK_TOOLS:
            return {
                "allowed": False,
                "reason": f"High-risk tool '{tool_name}' requires explicit approval",
                "risk_level": "high",
            }

        # Check command content for blocked patterns
        command = params.get("command", "")
        if command and self._is_blocked(command):
            return {
                "allowed": False,
                "reason": f"Command blocked by policy: {command.split()[0]}",
                "risk_level": "high",
            }

        # Check timeout
        timeout = params.get("timeout", 120)
        if isinstance(timeout, (int, float)) and timeout > 300:
            return {
                "allowed": False,
                "reason": f"Timeout {timeout}s exceeds maximum (300s)",
                "risk_level": risk_level,
            }

        return {
            "allowed": True,
            "reason": "Allowed",
            "risk_level": risk_level,
        }

    def get_risk_level(self, tool_name: str) -> str:
        return self._risk_level(tool_name)

    @staticmethod
    def _risk_level(tool_name: str) -> str:
        if tool_name in HIGH_RISK_TOOLS:
            return "high"
        if tool_name in MEDIUM_RISK_TOOLS:
            return "medium"
        return "low"

    @staticmethod
    def _is_blocked(command: str) -> bool:
        return any(command.startswith(prefix) for prefix in BLOCKED_COMMANDS)
