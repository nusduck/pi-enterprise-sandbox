"""Tests for ToolPolicyChecker."""

import pytest
from sandbox.models import PolicyDecision, RiskLevel, ToolCallCheck
from sandbox.services.policy_checker import (
    POLICY_VERSION,
    ToolPolicyChecker,
)


class TestToolPolicyChecker:
    @pytest.fixture
    def checker(self):
        return ToolPolicyChecker()

    def test_low_risk_allowed(self, checker: ToolPolicyChecker):
        decision = checker.check(ToolCallCheck(
            session_id="s1", tool_name="read_file",
        ))
        assert decision.allowed is True
        assert decision.decision == PolicyDecision.ALLOW.value
        assert decision.risk_level == RiskLevel.LOW
        assert decision.policy_version == POLICY_VERSION

    def test_high_risk_approval_required(self, checker: ToolPolicyChecker):
        decision = checker.check(ToolCallCheck(
            session_id="s1", tool_name="raw_bash",
        ))
        assert decision.allowed is False
        assert decision.decision == PolicyDecision.APPROVAL_REQUIRED.value
        assert decision.risk_level == RiskLevel.HIGH

    def test_medium_risk_allowed(self, checker: ToolPolicyChecker):
        decision = checker.check(ToolCallCheck(
            session_id="s1", tool_name="write_file",
        ))
        assert decision.allowed is True
        assert decision.decision == PolicyDecision.ALLOW.value
        assert decision.risk_level == RiskLevel.MEDIUM

    def test_blocked_command_is_hard_deny(self, checker: ToolPolicyChecker):
        decision = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash",
            command="sudo rm -rf /",
        ))
        assert decision.allowed is False
        assert decision.decision == PolicyDecision.HARD_DENY.value

    def test_excessive_timeout_blocked(self, checker: ToolPolicyChecker):
        decision = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash",
            command="echo hello", timeout=600,
        ))
        assert decision.allowed is False
        assert decision.decision == PolicyDecision.HARD_DENY.value

    def test_excessive_file_size_blocked(self, checker: ToolPolicyChecker):
        decision = checker.check(ToolCallCheck(
            session_id="s1", tool_name="write_file",
            file_size=100 * 1024 * 1024,  # 100MB
        ))
        assert decision.allowed is False
        assert decision.decision == PolicyDecision.HARD_DENY.value

    def test_risk_level_mapping(self, checker: ToolPolicyChecker):
        assert checker.get_risk_level("read_file") == RiskLevel.LOW
        assert checker.get_risk_level("write_file") == RiskLevel.MEDIUM
        assert checker.get_risk_level("delete_file") == RiskLevel.HIGH
        assert checker.get_risk_level("unknown_tool") == RiskLevel.MEDIUM

    def test_network_access_blocked(self, checker: ToolPolicyChecker):
        assert checker.check_network_access("169.254.169.254") is False

    def test_is_blocked_command(self, checker: ToolPolicyChecker):
        assert checker.is_blocked_command("sudo ls") is True
        assert checker.is_blocked_command("chmod 777 /etc") is True
        assert checker.is_blocked_command("ls -la") is False
        assert checker.is_blocked_command("  sudo id") is True  # strip

    def test_approval_pattern_not_hard_deny(self, checker: ToolPolicyChecker):
        decision = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash",
            command="pip install requests",
        ))
        assert decision.decision == PolicyDecision.APPROVAL_REQUIRED.value
        assert decision.allowed is False
