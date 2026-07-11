"""Tool Policy Checker — risk-based decision before tool execution.

Three-tier decisions (immutable policy version echoed to callers):

- ``allow`` — safe / constrained medium risk; execute immediately
- ``approval_required`` — high risk; human gate when APPROVAL_ENABLED
- ``hard_deny`` — never executable; cannot be approved or bypassed by
  APPROVAL_ENABLED or approval credentials

Agent Extension may pre-filter; Sandbox always re-evaluates independently.
"""

from __future__ import annotations

from sandbox.models import (
    PolicyDecision,
    RiskLevel,
    ToolCallCheck,
    ToolCallDecision,
)

# Keep in sync with api-server/extensions/sandbox-security.js POLICY_VERSION
POLICY_VERSION = "2026-07-11.1"

# ── Built-in tool risk mapping ─────────────────────────────────────────

_TOOL_RISK_MAP: dict[str, RiskLevel] = {
    # Low risk
    "read": RiskLevel.LOW,
    "read_file": RiskLevel.LOW,
    "list_files": RiskLevel.LOW,
    "preview_file": RiskLevel.LOW,
    "view_file": RiskLevel.LOW,
    "grep": RiskLevel.LOW,
    "find": RiskLevel.LOW,
    "ls": RiskLevel.LOW,
    "cat": RiskLevel.LOW,
    "head": RiskLevel.LOW,
    "tail": RiskLevel.LOW,
    # Medium risk
    "write": RiskLevel.MEDIUM,
    "write_file": RiskLevel.MEDIUM,
    "edit": RiskLevel.MEDIUM,
    "edit_file": RiskLevel.MEDIUM,
    "submit_artifact": RiskLevel.MEDIUM,
    "run_python": RiskLevel.MEDIUM,
    "bash": RiskLevel.MEDIUM,
    "command": RiskLevel.MEDIUM,
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

# Commands that are always hard-denied (cannot be approved)
_BLOCKED_COMMAND_PREFIXES = (
    "sudo", "su ", "chmod 777", "chown ",
    "rm -rf /", "rm -rf /*",
    "dd if=", "mkfs.", "fdisk",
    "> /dev/", "< /dev/",
)

# Bash command substrings that elevate bash/command to approval_required
_APPROVAL_REQUIRED_SUBSTRINGS = (
    "rm -rf", "rm -r ", "mkfs", "dd if=",
    "curl ", "wget ", "nc ", "ncat ",
    "pip install", "pip3 install", "npm install", "npm i ",
    "yarn add", "pnpm add",
    "chmod ", "chown ", "kill ", "pkill ",
    "eval ", "base64 -d",
)

# Blocked metadata network destinations
_BLOCKED_METADATA_IPS = (
    "169.254.169.254", "169.254.169.253",
    "metadata.google.internal",
    "metadata.amazonaws.com",
    "169.254.170.2",  # ECS
)


def _decision(
    *,
    decision: PolicyDecision | str,
    risk_level: RiskLevel,
    reason: str,
) -> ToolCallDecision:
    dec = decision.value if isinstance(decision, PolicyDecision) else str(decision)
    allowed = dec == PolicyDecision.ALLOW.value
    return ToolCallDecision(
        allowed=allowed,
        decision=dec,
        risk_level=risk_level,
        reason=reason,
        policy_version=POLICY_VERSION,
    )


class ToolPolicyChecker:
    """Evaluate tool calls against enterprise policies before execution."""

    def check(self, request: ToolCallCheck) -> ToolCallDecision:
        """Check if a tool call is allowed. Returns three-tier decision."""
        risk = self._get_risk_level(request.tool_name)

        # Bash/command family: hard deny first, then approval elevation
        if request.command and request.tool_name in {"bash", "command", "raw_bash", "raw_shell"}:
            if self.is_blocked_command(request.command):
                token = (request.command or "").strip().split()[0] if request.command else "command"
                return _decision(
                    decision=PolicyDecision.HARD_DENY,
                    risk_level=RiskLevel.HIGH,
                    reason=f"blocked command: {token}",
                )
            if self.command_requires_approval(request.command):
                risk = RiskLevel.HIGH

        # ── Low risk: always allow ──────────────────────────────
        if risk == RiskLevel.LOW:
            return _decision(
                decision=PolicyDecision.ALLOW,
                risk_level=risk,
                reason="low risk tool, auto-allowed",
            )

        # ── High risk: approval required (not hard deny) ────────
        if risk == RiskLevel.HIGH:
            return _decision(
                decision=PolicyDecision.APPROVAL_REQUIRED,
                risk_level=risk,
                reason="high risk tool/command, requires human approval",
            )

        # ── Medium risk: hard constraints, else allow ───────────
        if request.command and self.is_blocked_command(request.command):
            token = (request.command or "").strip().split()[0] if request.command else "command"
            return _decision(
                decision=PolicyDecision.HARD_DENY,
                risk_level=risk,
                reason=f"blocked command prefix: {token}",
            )

        if request.timeout and request.timeout > 300:
            return _decision(
                decision=PolicyDecision.HARD_DENY,
                risk_level=risk,
                reason="timeout exceeds maximum allowed (300s)",
            )

        if request.file_size and request.file_size > 50 * 1024 * 1024:
            return _decision(
                decision=PolicyDecision.HARD_DENY,
                risk_level=risk,
                reason="file size exceeds 50MB limit",
            )

        return _decision(
            decision=PolicyDecision.ALLOW,
            risk_level=risk,
            reason="medium risk tool, allowed with constraints",
        )

    @staticmethod
    def command_requires_approval(command: str) -> bool:
        """True when a bash command body should pause for human approval."""
        cmd = (command or "").lower()
        return any(s in cmd for s in _APPROVAL_REQUIRED_SUBSTRINGS)

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
        """True for hard-deny command patterns (strip leading whitespace)."""
        cmd = (command or "").strip()
        if not cmd:
            return False
        return cmd.startswith(_BLOCKED_COMMAND_PREFIXES)

    @property
    def low_risk_tools(self) -> set[str]:
        return _LOW_TOOLS

    @property
    def medium_risk_tools(self) -> set[str]:
        return _MEDIUM_TOOLS

    @property
    def high_risk_tools(self) -> set[str]:
        return _HIGH_TOOLS

    @property
    def policy_version(self) -> str:
        return POLICY_VERSION


policy_checker = ToolPolicyChecker()
