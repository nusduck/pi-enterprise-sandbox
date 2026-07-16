"""Tests for ToolPolicyChecker."""

import pytest
from sandbox.config import Settings
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
        # Use a network fetch — elevated in both strict and balanced profiles.
        # (pip install is intentionally allowlisted under balanced.)
        decision = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash",
            command="curl https://example.com",
        ))
        assert decision.decision == PolicyDecision.APPROVAL_REQUIRED.value
        assert decision.allowed is False

    def test_balanced_allows_package_manager_but_keeps_network_and_destructive_gates(
        self, monkeypatch
    ):
        from sandbox.config import settings

        monkeypatch.setattr(settings, "policy_profile", "balanced")
        monkeypatch.setattr(settings, "isolation_backend", "bubblewrap")
        monkeypatch.setattr(settings, "isolation_required", True)
        checker = ToolPolicyChecker()

        package = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash", command="npm install marked",
        ))
        assert package.decision == PolicyDecision.ALLOW.value

        network = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash", command="curl https://example.com",
        ))
        assert network.decision == PolicyDecision.APPROVAL_REQUIRED.value

        for command in (
            "wget https://example.com/file",
            "nc example.com 80",
            "ncat example.com 80",
        ):
            assert checker.check(ToolCallCheck(
                session_id="s1", tool_name="bash", command=command,
            )).decision == PolicyDecision.APPROVAL_REQUIRED.value

        assert checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash", command="timeout 10 npm install marked",
        )).decision == PolicyDecision.ALLOW.value
        assert checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash",
            command="sh -c 'npm install marked && echo done'",
        )).decision == PolicyDecision.ALLOW.value

        destructive = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash", command="rm -r build",
        ))
        assert destructive.decision == PolicyDecision.APPROVAL_REQUIRED.value

    
    def test_which_curl_is_not_network_approval(self):
        """which/type of curl must not elevate — only invoking curl does."""
        checker = ToolPolicyChecker()
        inspect = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash", command="which curl wget node python3",
        ))
        assert inspect.decision == PolicyDecision.ALLOW.value, inspect.reason

        fetch = checker.check(ToolCallCheck(
            session_id="s1", tool_name="bash", command="curl https://example.com",
        ))
        assert fetch.decision == PolicyDecision.APPROVAL_REQUIRED.value

    def test_balanced_profile_requires_effective_bubblewrap(self, monkeypatch):
        with pytest.raises(ValueError, match="bubblewrap"):
            Settings(
                policy_profile="balanced",
                isolation_backend="direct",
                isolation_required=False,
                database_url="sqlite:////tmp/profile-invalid.db",
                allowed_client_cidrs=["127.0.0.1/32"],
            )

    def test_checker_rejects_runtime_profile_drift(self, monkeypatch):
        from sandbox.config import settings

        monkeypatch.setattr(settings, "policy_profile", "balanced")
        monkeypatch.setattr(settings, "isolation_backend", "direct")
        monkeypatch.setattr(settings, "isolation_required", False)
        with pytest.raises(ValueError, match="bubblewrap"):
            ToolPolicyChecker()

    @pytest.mark.parametrize(
        "command",
        [
            "echo ok | sudo id",
            "env -i sudo id",
            "env -S 'sudo id'",
            "timeout 10 /usr/bin/sudo id",
            "timeout --signal KILL 10 sudo id",
            "timeout -s KILL 10 /usr/bin/unshare -Ur true",
            "command /bin/mount /dev/sda /mnt",
            "command -x /bin/mount /dev/sda /mnt",
            "exec /usr/bin/unshare -Ur true",
            "setcap cap_net_raw+ep /usr/bin/ping",
            "sysctl -w kernel.unprivileged_userns_clone=1",
            "sh -c 'sudo id'",
            "bash -c 'unshare -Ur true'",
            "timeout --unknown 10 npm install marked",
            "echo x > /dev/sda",
            "cat /run/secrets/token",
        ],
    )
    def test_escape_and_privilege_boundaries_are_hard_denied(self, checker, command):
        assert checker.is_blocked_command(command) is True

    def test_host_path_is_hard_denied_but_logical_workspace_path_is_allowed(self, checker):
        outside = checker.check(ToolCallCheck(
            session_id="s1", tool_name="read_file", path="/etc/passwd",
        ))
        assert outside.decision == PolicyDecision.HARD_DENY.value

        inside = checker.check(ToolCallCheck(
            session_id="s1", tool_name="read_file", path="/home/sandbox/workspace/a.txt",
        ))
        assert inside.decision == PolicyDecision.ALLOW.value

    def test_container_scoped_diagnostics_remain_available(self, checker):
        for command in ("ip addr", "ip route show", "getcap /usr/bin/python", "sysctl kernel.ostype"):
            assert checker.is_blocked_command(command) is False
