"""Tests for EnterpriseToolPolicy (agent-side)."""

import pytest
from agent.tool_policy import EnterpriseToolPolicy


class TestEnterpriseToolPolicy:
    @pytest.fixture
    def policy(self):
        return EnterpriseToolPolicy()

    def test_low_risk_allowed(self, policy: EnterpriseToolPolicy):
        decision = policy.check("read_file", {})
        assert decision["allowed"] is True
        assert decision["risk_level"] == "low"

    def test_medium_risk_allowed(self, policy: EnterpriseToolPolicy):
        decision = policy.check("bash", {"command": "ls -la"})
        assert decision["allowed"] is True
        assert decision["risk_level"] == "medium"

    def test_high_risk_denied(self, policy: EnterpriseToolPolicy):
        decision = policy.check("delete_file", {})
        assert decision["allowed"] is False

    def test_blocked_command(self, policy: EnterpriseToolPolicy):
        decision = policy.check("bash", {"command": "sudo rm -rf /"})
        assert decision["allowed"] is False

    def test_long_timeout_blocked(self, policy: EnterpriseToolPolicy):
        decision = policy.check("bash", {"command": "echo hi", "timeout": 600})
        assert decision["allowed"] is False

    def test_normal_timeout_allowed(self, policy: EnterpriseToolPolicy):
        decision = policy.check("bash", {"command": "echo hi", "timeout": 30})
        assert decision["allowed"] is True

    def test_risk_levels(self, policy: EnterpriseToolPolicy):
        assert policy.get_risk_level("read_file") == "low"
        assert policy.get_risk_level("bash") == "medium"
        assert policy.get_risk_level("raw_bash") == "high"
        assert policy.get_risk_level("unknown") == "low"
