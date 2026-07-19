"""PR-07 Network Policy: fail-closed execution isolation (static + unit).

Covers Compose topology, capability drops, no iptables fail-open authority,
production rejection of unsafe network modes, and Bubblewrap --unshare-net
for disabled mode. Offline — does not run Docker.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sandbox.config import ProductionConfigError, Settings, validate_production_settings
from sandbox.isolation import LaunchSpec
from sandbox.isolation.bubblewrap import BubblewrapIsolationBackend
from sandbox.paths import SandboxPathScope
from sandbox.services.execution_context import SandboxExecutionContext

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"
ENTRYPOINT = ROOT / "sandbox" / "entrypoint.sh"
DOCKERFILE = ROOT / "sandbox" / "Dockerfile"
BWRAP = ROOT / "sandbox" / "isolation" / "bubblewrap.py"


def _strong_secret(seed: str = "a") -> str:
    return (seed * 64)[:64]


def _prod_hmac_keyring() -> tuple[str, str]:
    import base64
    import json

    key = base64.urlsafe_b64encode(b"k" * 32).decode("ascii").rstrip("=")
    return json.dumps({"kid-1": key}), "kid-1"


def _production_kwargs(**overrides):
    kr, kid = _prod_hmac_keyring()
    base = {
        "deployment_env": "production",
        "api_token": _strong_secret("t"),
        "auth_enabled": True,
        "jwt_secret": _strong_secret("j"),
        "jwt_issuer": "pi-enterprise-sandbox",
        "jwt_audience": "pi-enterprise-sandbox",
        "auth_allow_public_register": False,
        "network_mode": "disabled",
        "isolation_backend": "bubblewrap",
        "isolation_required": True,
        "cors_origins": ["https://app.example.com"],
        "cors_allow_credentials": True,
        "debug": False,
        "database_url": "mysql+pymysql://sandbox@mysql:3306/sandbox",
        "allowed_client_cidrs": ["127.0.0.1/32"],
        "trusted_proxy_cidrs": [],
        "internal_plane_enabled": True,
        "internal_redis_url": "redis://:prod_replay_only_secret@sandbox-replay-redis:6379/0",
        "internal_hmac_keyring": kr,
        "internal_hmac_active_kid": kid,
        "internal_drain_timeout_seconds": 30.0,
        "workspace_child_quota_enforcement": True,
        "workspace_quota_hard_backend_asserted": True,
    }
    base.update(overrides)
    return base


def _service_block(text: str, name: str) -> str:
    marker = f"\n  {name}:\n"
    start = text.index(marker) + len(marker)
    remainder = text[start:]
    # Next top-level service or top-level key (networks/volumes).
    next_key = re.search(r"\n(?:  [A-Za-z][A-Za-z0-9_-]*:|[a-z_]+:)\n", remainder)
    return remainder if next_key is None else remainder[: next_key.start()]


def _networks_in_block(block: str) -> set[str]:
    """Parse compose service networks list items under a service block."""
    # Match either list form or mapping form after "networks:".
    nets: set[str] = set()
    in_networks = False
    for line in block.splitlines():
        if re.match(r"^\s+networks:\s*(?:!override\s*)?$", line):
            in_networks = True
            continue
        if in_networks:
            m = re.match(r"^\s+-\s+([A-Za-z0-9_-]+)\s*$", line)
            if m:
                nets.add(m.group(1))
                continue
            # End of networks list when indentation drops to another key at same level
            if re.match(r"^\s{2,4}[A-Za-z0-9_]+:", line) and not line.strip().startswith("-"):
                # Still under service if indented more than service name
                if re.match(r"^\s{4}[A-Za-z]", line) or re.match(r"^\s{2}[A-Za-z]", line):
                    # Another service-level key — stop if indent is 4 spaces key not list
                    if re.match(r"^\s{4}[A-Za-z0-9_]+:", line):
                        break
            if not line.strip():
                continue
            if re.match(r"^\s+-\s+", line):
                continue
            # Non-list line under networks mapping form: "    name: true"
            m2 = re.match(r"^\s{6}([A-Za-z0-9_-]+):\s*", line)
            if m2:
                nets.add(m2.group(1))
                continue
            if re.match(r"^\s{4}[A-Za-z0-9_]+:", line):
                break
    return nets


class TestComposeNetworkTopology:
    def test_defines_backend_internal_and_service_egress(self):
        text = COMPOSE.read_text(encoding="utf-8")
        assert "backend_internal:" in text
        assert "service_egress:" in text
        assert re.search(r"backend_internal:.*?internal:\s*true", text, re.S)

    def test_sandbox_only_on_backend_internal(self):
        text = COMPOSE.read_text(encoding="utf-8")
        block = _service_block(text, "sandbox")
        nets = _networks_in_block(block)
        assert nets == {"backend_internal"}
        assert "service_egress" not in nets

    def test_mysql_redis_use_dev_ingress_only_in_base_compose(self):
        text = COMPOSE.read_text(encoding="utf-8")
        for name in ("mysql", "redis"):
            nets = _networks_in_block(_service_block(text, name))
            assert nets == {"backend_internal", "dev_ingress"}, name

        prod = COMPOSE_PROD.read_text(encoding="utf-8")
        for name in ("mysql", "redis"):
            block = _service_block(prod, name)
            assert "networks: !override" in block, name
            assert _networks_in_block(block) == {"backend_internal"}, name

    def test_agent_and_worker_on_internal_and_egress(self):
        text = COMPOSE.read_text(encoding="utf-8")
        for name in ("agent", "agent-worker"):
            nets = _networks_in_block(_service_block(text, name))
            assert nets == {"backend_internal", "service_egress"}, name

    def test_api_and_frontend_on_backend_internal(self):
        text = COMPOSE.read_text(encoding="utf-8")
        for name in ("api-server", "frontend"):
            nets = _networks_in_block(_service_block(text, name))
            assert "backend_internal" in nets, name
            # BFF/SPA do not need public egress for the core call chain.
            assert "service_egress" not in nets, name

    def test_prod_nginx_on_both_networks(self):
        text = COMPOSE_PROD.read_text(encoding="utf-8")
        block = _service_block(text, "nginx")
        nets = _networks_in_block(block)
        assert nets == {"backend_internal", "service_egress"}

    def test_prod_sandbox_forces_disabled_and_internal_only(self):
        text = COMPOSE_PROD.read_text(encoding="utf-8")
        block = _service_block(text, "sandbox")
        assert "SANDBOX_NETWORK_MODE: disabled" in block
        # Must not allow operator override back to allowlist/unrestricted via ${...}.
        assert "SANDBOX_NETWORK_MODE: ${" not in block
        nets = _networks_in_block(block)
        assert "backend_internal" in nets
        assert "service_egress" not in nets


class TestSandboxCapabilitiesAndNoIptables:
    def test_compose_sandbox_drops_all_and_no_net_admin_raw(self):
        text = COMPOSE.read_text(encoding="utf-8")
        block = _service_block(text, "sandbox")
        # Granted capabilities must not include NET_ADMIN / NET_RAW.
        granted = re.findall(r"^\s+-\s+(NET_ADMIN|NET_RAW|ALL|CHOWN|FOWNER|SETUID|SETGID)\s*$", block, re.M)
        assert "NET_ADMIN" not in granted
        assert "NET_RAW" not in granted
        assert "ALL" in granted  # cap_drop: - ALL
        for cap in ("CHOWN", "FOWNER", "SETUID", "SETGID"):
            assert cap in granted
        assert "cap_drop:" in block
        assert "cap_add:" in block

    def test_compose_has_no_iptables_env_authority(self):
        text = COMPOSE.read_text(encoding="utf-8")
        for needle in (
            "SANDBOX_IPTABLES_ENABLED",
            "SANDBOX_IPTABLES_DEFAULT_POLICY",
            "SANDBOX_ALLOWED_TCP_PORTS",
            "SANDBOX_ALLOWED_UDP_PORTS",
            "SANDBOX_ALLOWED_CIDRS:",
        ):
            assert needle not in text, needle

    def test_dockerfile_does_not_install_iptables(self):
        text = DOCKERFILE.read_text(encoding="utf-8")
        # Package install lines must not list iptables; comments may mention removal.
        install_lines = [
            line
            for line in text.splitlines()
            if "apt-get install" in line or re.match(r"^\s+(curl|iptables|gosu|git)\s*\\?\s*$", line)
        ]
        joined = "\n".join(install_lines)
        assert "iptables" not in joined
        assert not re.search(r"^\s*iptables\s*\\?\s*$", text, re.M)

    def test_entrypoint_has_no_iptables_fail_open_path(self):
        text = ENTRYPOINT.read_text(encoding="utf-8")
        # Stronger: no apply path / missing-tool skip / env knobs.
        assert "apply_iptables" not in text
        assert "iptables not found" not in text
        assert "SANDBOX_IPTABLES" not in text
        assert "command -v iptables" not in text
        assert "iptables -" not in text
        # Privilege drop + storage init remain.
        assert "SANDBOX_RUN_AS_USER" in text
        assert "gosu" in text
        assert "chown" in text
        assert "chmod 0700" in text

    def test_entrypoint_does_not_reference_port_cidr_union_allowlist(self):
        text = ENTRYPOINT.read_text(encoding="utf-8")
        for var in (
            "SANDBOX_ALLOWED_TCP_PORTS",
            "SANDBOX_ALLOWED_UDP_PORTS",
            "SANDBOX_ALLOWED_CIDRS",
            "SANDBOX_ALLOWED_DNS_PORTS",
        ):
            assert var not in text


class TestProductionNetworkModeFailClosed:
    def test_disabled_passes(self):
        s = Settings(**_production_kwargs(network_mode="disabled"))
        validate_production_settings(s)

    def test_unrestricted_rejected(self):
        s = Settings(**_production_kwargs(network_mode="unrestricted"))
        with pytest.raises(ProductionConfigError, match="unrestricted"):
            validate_production_settings(s)

    def test_allowlist_rejected_without_egress_proxy(self):
        s = Settings(**_production_kwargs(network_mode="allowlist"))
        with pytest.raises(ProductionConfigError, match="allowlist"):
            validate_production_settings(s)

    def test_dev_unrestricted_still_allowed_outside_production(self):
        s = Settings(
            deployment_env="development",
            network_mode="unrestricted",
            database_url="sqlite:////tmp/dev-unrestricted-net.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        validate_production_settings(s)  # no-op for non-production
        assert s.network_mode == "unrestricted"
        assert s.default_deny_network is False


class TestBubblewrapDisabledNetns:
    def _context(self, tmp_path) -> SandboxExecutionContext:
        workspace = tmp_path / "workspaces" / "conv_net"
        temp = tmp_path / "tmp-workspaces" / "tmp_conv_net"
        workspace.mkdir(parents=True)
        temp.mkdir(parents=True)
        return SandboxExecutionContext(
            session_id="sandbox_net",
            workspace_id="conv_net",
            temp_id="tmp_conv_net",
            physical_workspace=workspace,
            physical_temp=temp,
        )

    def test_disabled_adds_unshare_net(self, tmp_path):
        skills = tmp_path / "skills"
        skills.mkdir()
        backend = BubblewrapIsolationBackend(
            executable="/usr/bin/bwrap", skills_root=skills
        )
        prepared = backend.prepare(
            LaunchSpec(
                context=self._context(tmp_path),
                argv=["true"],
                network_mode="disabled",
            )
        )
        assert "--unshare-net" in prepared.argv

    def test_allowlist_does_not_pretend_isolated_netns(self, tmp_path):
        """Without per-child egress proxy, allowlist must not use fake isolation.

        Dev allowlist shares container network; production rejects the mode.
        """
        skills = tmp_path / "skills"
        skills.mkdir()
        backend = BubblewrapIsolationBackend(
            executable="/usr/bin/bwrap", skills_root=skills
        )
        prepared = backend.prepare(
            LaunchSpec(
                context=self._context(tmp_path),
                argv=["true"],
                network_mode="allowlist",
                cwd_scope=SandboxPathScope.WORKSPACE,
            )
        )
        assert "--unshare-net" not in prepared.argv

    def test_source_does_not_claim_iptables_authority(self):
        text = BWRAP.read_text(encoding="utf-8")
        assert "iptables policy is the network authority" not in text
        assert "--unshare-net" in text


class TestInboundVsOutboundNaming:
    def test_inbound_client_cidrs_independent_of_execution_mode(self):
        s = Settings(
            network_mode="disabled",
            allowed_client_cidrs=["10.0.0.0/8"],
            database_url="sqlite:////tmp/inbound-vs-out.db",
        )
        assert s.network_mode == "disabled"
        assert s.default_deny_network is True
        assert s.allowed_client_cidrs == ["10.0.0.0/8"]

    def test_network_policy_module_is_inbound_only(self):
        text = (ROOT / "sandbox" / "security" / "network_policy.py").read_text(
            encoding="utf-8"
        )
        assert "Inbound client CIDR" in text
        assert "iptables" not in text.lower()
