"""Tool Policy Checker — risk-based decision before tool execution."""

from __future__ import annotations

from sandbox.models import (
    RiskLevel,
    ToolCallCheck,
    ToolCallDecision,
)

# ── Built-in tool risk mapping ─────────────────────────────────────────

_TOOL_RISK_MAP: dict[str, RiskLevel] = {
    # Low risk
    "read_file": RiskLevel.LOW,
    "list_files": RiskLevel.LOW,
    "preview_file": RiskLevel.LOW,
    "view_file": RiskLevel.LOW,
    # Medium risk
    "write_file": RiskLevel.MEDIUM,
    "edit_file": RiskLevel.MEDIUM,
    "run_python": RiskLevel.MEDIUM,
    "bash": RiskLevel.MEDIUM,
    "command": RiskLevel.MEDIUM,
    "grep": RiskLevel.LOW,
    "find": RiskLevel.LOW,
    "ls": RiskLevel.LOW,
    "cat": RiskLevel.LOW,
    "head": RiskLevel.LOW,
    "tail": RiskLevel.LOW,
    # High risk
    "raw_bash": RiskLevel.HIGH,
    "delete_file": RiskLevel.HIGH,
    "network_request": RiskLevel.HIGH,
    "package_install": RiskLevel.HIGH,
    "pip_install": RiskLevel.HIGH,
    "npm_install": RiskLevel.HIGH,
    "kill_process": RiskLevel.HIGH,
    "raw_shell": RiskLevel.HIGH,
}

_HIGH_TOOLS = {t for t, r in _TOOL_RISK_MAP.items() if r == RiskLevel.HIGH}
_MEDIUM_TOOLS = {t for t, r in _TOOL_RISK_MAP.items() if r == RiskLevel.MEDIUM}
_LOW_TOOLS = {t for t, r in _TOOL_RISK_MAP.items() if r == RiskLevel.LOW}

# Commands that are always blocked
_BLOCKED_COMMAND_PREFIXES = (
    "sudo", "su ", "chmod 777", "chown ",
    "rm -rf /", "rm -rf /*",
    "dd if=", "mkfs.", "fdisk",
    "> /dev/", "< /dev/",
)

# Blocked metadata network destinations
_BLOCKED_METADATA_IPS = (
    "169.254.169.254", "169.254.169.253",
    "metadata.google.internal",
    "metadata.amazonaws.com",
    "169.254.170.2",  # ECS
)


class ToolPolicyChecker:
    """Evaluate tool calls against enterprise policies before execution."""

    def check(self, request: ToolCallCheck) -> ToolCallDecision:
        """Check if a tool call is allowed. Returns decision with reason."""
        risk = self._get_risk_level(request.tool_name)

        # ── Low risk: always allow ──────────────────────────────
        if risk == RiskLevel.LOW:
            return ToolCallDecision(
                allowed=True, risk_level=risk,
                reason="low risk tool, auto-allowed",
            )

        # ── High risk: default deny ─────────────────────────────
        if risk == RiskLevel.HIGH:
            return ToolCallDecision(
                allowed=False, risk_level=risk,
                reason="high risk tool, requires approval or whitelist",
            )

        # ── Medium risk: check specific constraints ─────────────
        if request.command and request.command.startswith(_BLOCKED_COMMAND_PREFIXES):
            return ToolCallDecision(
                allowed=False, risk_level=risk,
                reason=f"blocked command prefix: {request.command.split()[0]}",
            )

        if request.timeout and request.timeout > 300:
            return ToolCallDecision(
                allowed=False, risk_level=risk,
                reason="timeout exceeds maximum allowed (300s)",
            )

        if request.file_size and request.file_size > 50 * 1024 * 1024:
            return ToolCallDecision(
                allowed=False, risk_level=risk,
                reason="file size exceeds 50MB limit",
            )

        return ToolCallDecision(
            allowed=True, risk_level=risk,
            reason="medium risk tool, allowed with constraints",
        )

    def check_network_access(self, host: str) -> bool:
        """Check if outbound network access is permitted for a given host."""
        from sandbox.config import settings
        if settings.default_deny_network:
            return False
        if settings.block_metadata_ips and host in _BLOCKED_METADATA_IPS:
            return False
        return True

    def get_risk_level(self, tool_name: str) -> RiskLevel:
        return self._get_risk_level(tool_name)

    @staticmethod
    def _get_risk_level(tool_name: str) -> RiskLevel:
        return _TOOL_RISK_MAP.get(tool_name, RiskLevel.MEDIUM)

    @staticmethod
    def is_blocked_command(command: str) -> bool:
        return command.startswith(_BLOCKED_COMMAND_PREFIXES)

    @property
    def low_risk_tools(self) -> set[str]:
        return _LOW_TOOLS

    @property
    def medium_risk_tools(self) -> set[str]:
        return _MEDIUM_TOOLS

    @property
    def high_risk_tools(self) -> set[str]:
        return _HIGH_TOOLS


policy_checker = ToolPolicyChecker()
