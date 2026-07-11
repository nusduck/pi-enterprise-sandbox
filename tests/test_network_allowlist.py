"""Tests for inbound client CIDR allowlist and trusted-proxy semantics."""

from __future__ import annotations

import ipaddress

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from sandbox.main import app
from sandbox.security.network_policy import (
    DEFAULT_ALLOWED_CLIENT_CIDRS,
    NetworkPolicy,
    NetworkPolicyConfigError,
    build_network_policy_from_settings,
    get_network_policy,
    init_network_policy,
    parse_cidr_list,
    parse_ip,
    reset_network_policy,
)


# ── Pure policy library ────────────────────────────────────────────────


def test_default_allowed_cidrs_cover_loopback_and_docker_ranges():
    policy = NetworkPolicy.build(
        bind_host="0.0.0.0",
        allowed_client_cidrs=DEFAULT_ALLOWED_CLIENT_CIDRS,
        trusted_proxy_cidrs=(),
    )
    assert policy.is_client_allowed(ipaddress.ip_address("127.0.0.1"))
    assert policy.is_client_allowed(ipaddress.ip_address("::1"))
    assert policy.is_client_allowed(ipaddress.ip_address("10.1.2.3"))
    assert policy.is_client_allowed(ipaddress.ip_address("172.18.0.5"))
    assert policy.is_client_allowed(ipaddress.ip_address("192.168.1.10"))
    assert not policy.is_client_allowed(ipaddress.ip_address("8.8.8.8"))
    assert not policy.is_client_allowed(ipaddress.ip_address("1.1.1.1"))


def test_empty_allowlist_denies_all():
    policy = NetworkPolicy.build(
        bind_host="0.0.0.0",
        allowed_client_cidrs=[],
        trusted_proxy_cidrs=(),
    )
    assert policy.allowed_networks == ()
    assert not policy.is_client_allowed(ipaddress.ip_address("127.0.0.1"))
    allowed, _ip, reason = policy.evaluate("127.0.0.1")
    assert allowed is False
    assert reason == "not_allowlisted"


def test_illegal_cidr_raises_on_build():
    with pytest.raises(NetworkPolicyConfigError, match="Invalid CIDR"):
        NetworkPolicy.build(
            bind_host="0.0.0.0",
            allowed_client_cidrs=["not-a-cidr"],
            trusted_proxy_cidrs=(),
        )
    with pytest.raises(NetworkPolicyConfigError, match="trusted_proxy"):
        NetworkPolicy.build(
            bind_host="0.0.0.0",
            allowed_client_cidrs=["127.0.0.1/32"],
            trusted_proxy_cidrs=["999.0.0.0/8"],
        )


def test_empty_bind_host_raises():
    with pytest.raises(NetworkPolicyConfigError, match="bind_host"):
        NetworkPolicy.build(
            bind_host="  ",
            allowed_client_cidrs=["127.0.0.1/32"],
        )


def test_parse_cidr_list_accepts_csv_and_host_bits():
    nets = parse_cidr_list("127.0.0.1, 10.0.0.0/8", field_name="test")
    assert len(nets) == 2
    assert ipaddress.ip_address("127.0.0.1") in nets[0]


def test_ipv6_allowlist_and_parse():
    policy = NetworkPolicy.build(
        bind_host="::",
        allowed_client_cidrs=["2001:db8::/32", "::1/128"],
        trusted_proxy_cidrs=(),
    )
    assert policy.is_client_allowed(ipaddress.ip_address("2001:db8::1"))
    assert policy.is_client_allowed(ipaddress.ip_address("::1"))
    assert not policy.is_client_allowed(ipaddress.ip_address("2001:db9::1"))
    assert parse_ip("[2001:db8::1]") == ipaddress.ip_address("2001:db8::1")
    assert parse_ip("fe80::1%eth0") == ipaddress.ip_address("fe80::1")


def test_xff_ignored_when_peer_not_trusted():
    policy = NetworkPolicy.build(
        bind_host="0.0.0.0",
        allowed_client_cidrs=["10.0.0.0/8"],
        trusted_proxy_cidrs=[],  # empty trusted proxies
    )
    # Peer is external; spoofed XFF claims an allowlisted client.
    effective = policy.resolve_effective_client_ip(
        "8.8.8.8",
        x_forwarded_for="10.0.0.99, 1.2.3.4",
    )
    assert effective == ipaddress.ip_address("8.8.8.8")
    allowed, _, reason = policy.evaluate("8.8.8.8", "10.0.0.99")
    assert allowed is False
    assert reason == "not_allowlisted"


def test_trusted_proxy_multi_hop_right_to_left():
    """Strip trusted proxies from the right; first untrusted hop is client."""
    policy = NetworkPolicy.build(
        bind_host="0.0.0.0",
        allowed_client_cidrs=["203.0.113.0/24", "10.0.0.0/8"],
        trusted_proxy_cidrs=["172.16.0.0/12", "192.168.0.0/16"],
    )
    # chain: client=203.0.113.50, proxy1=192.168.1.2, peer=172.18.0.5 (trusted)
    effective = policy.resolve_effective_client_ip(
        "172.18.0.5",
        x_forwarded_for="203.0.113.50, 192.168.1.2",
    )
    assert effective == ipaddress.ip_address("203.0.113.50")
    allowed, ip, reason = policy.evaluate(
        "172.18.0.5", "203.0.113.50, 192.168.1.2"
    )
    assert allowed is True
    assert ip == ipaddress.ip_address("203.0.113.50")
    assert reason == "allowed"


def test_trusted_proxy_all_hops_trusted_uses_leftmost():
    policy = NetworkPolicy.build(
        bind_host="0.0.0.0",
        allowed_client_cidrs=["172.16.0.0/12"],
        trusted_proxy_cidrs=["172.16.0.0/12"],
    )
    effective = policy.resolve_effective_client_ip(
        "172.18.0.5",
        x_forwarded_for="172.16.0.1, 172.18.0.2",
    )
    assert effective == ipaddress.ip_address("172.16.0.1")


def test_spoofed_xff_cannot_bypass_when_peer_untrusted():
    policy = NetworkPolicy.build(
        bind_host="0.0.0.0",
        allowed_client_cidrs=["127.0.0.1/32"],
        trusted_proxy_cidrs=["10.0.0.0/8"],
    )
    # Attacker at 8.8.8.8 forges XFF claiming loopback.
    allowed, effective, reason = policy.evaluate(
        "8.8.8.8", "127.0.0.1, 10.0.0.1"
    )
    assert allowed is False
    assert effective == ipaddress.ip_address("8.8.8.8")
    assert reason == "not_allowlisted"


def test_invalid_peer_reason():
    policy = NetworkPolicy.build(
        bind_host="0.0.0.0",
        allowed_client_cidrs=["0.0.0.0/0"],
    )
    allowed, effective, reason = policy.evaluate("not-an-ip")
    assert allowed is False
    assert effective is None
    assert reason == "invalid_peer"


def test_settings_illegal_cidr_fails_init(monkeypatch):
    monkeypatch.setenv("SANDBOX_ALLOWED_CLIENT_CIDRS", "totally-invalid")
    monkeypatch.setenv("SANDBOX_DATABASE_URL", "sqlite:////tmp/sandbox-net-test.db")
    from sandbox.config import Settings

    with pytest.raises((ValidationError, ValueError)):
        Settings()


def test_settings_empty_allowlist_is_valid_deny_all(monkeypatch):
    monkeypatch.setenv("SANDBOX_ALLOWED_CLIENT_CIDRS", "")
    monkeypatch.setenv("SANDBOX_TRUSTED_PROXY_CIDRS", "")
    monkeypatch.setenv("SANDBOX_DATABASE_URL", "sqlite:////tmp/sandbox-net-test2.db")
    from sandbox.config import Settings

    s = Settings()
    assert s.allowed_client_cidrs == []
    policy = build_network_policy_from_settings(s)
    assert policy.allowed_networks == ()
    assert not policy.is_client_allowed(ipaddress.ip_address("127.0.0.1"))


# ── Middleware integration ─────────────────────────────────────────────


@pytest.fixture
def allowlist_policy():
    """Install a tight policy for middleware tests; restore after."""
    previous = get_network_policy()
    policy = NetworkPolicy.build(
        bind_host="0.0.0.0",
        allowed_client_cidrs=["127.0.0.1/32", "::1/128", "10.0.0.0/8"],
        trusted_proxy_cidrs=["172.16.0.0/12"],
    )
    reset_network_policy(policy)
    yield policy
    reset_network_policy(previous)


def test_middleware_allows_loopback_peer(allowlist_policy):
    client = TestClient(app, client=("127.0.0.1", 50000))
    resp = client.get("/health")
    assert resp.status_code == 200


def test_middleware_denies_external_peer_before_auth(allowlist_policy, monkeypatch):
    from sandbox.config import settings

    # Even with no API token, external peer is 403 (not 401).
    monkeypatch.setattr(settings, "api_token", "secret-token")
    client = TestClient(app, client=("8.8.8.8", 50000))
    resp = client.get("/sessions")
    assert resp.status_code == 403
    assert "allowlist" in resp.json()["detail"].lower()
    # Spoofed XFF must not help when peer is untrusted.
    resp2 = client.get(
        "/sessions",
        headers={
            "X-Forwarded-For": "127.0.0.1",
            "X-API-Key": "secret-token",
        },
    )
    assert resp2.status_code == 403


def test_middleware_trusted_proxy_uses_xff(allowlist_policy):
    # Peer is trusted proxy; XFF client is in allowlist (10/8).
    client = TestClient(app, client=("172.18.0.5", 50000))
    resp = client.get(
        "/health",
        headers={"X-Forwarded-For": "10.0.0.42, 172.18.0.5"},
    )
    assert resp.status_code == 200

    # Peer trusted but resolved client is external → 403
    resp2 = client.get(
        "/sessions",
        headers={"X-Forwarded-For": "8.8.8.8"},
    )
    assert resp2.status_code == 403


def test_middleware_ipv6_peer(allowlist_policy):
    client = TestClient(app, client=("::1", 50000))
    resp = client.get("/health")
    assert resp.status_code == 200

    client_ext = TestClient(app, client=("2001:db8::1", 50000))
    resp2 = client_ext.get("/health")
    assert resp2.status_code == 403


def test_mcp_route_respects_allowlist(allowlist_policy):
    client = TestClient(app, client=("8.8.8.8", 50000))
    resp = client.get("/mcp/tools")
    assert resp.status_code == 403

    client_ok = TestClient(app, client=("10.0.0.9", 50000))
    resp_ok = client_ok.get("/mcp/tools")
    assert resp_ok.status_code == 200
    assert "tools" in resp_ok.json()


def test_mcp_adapter_reuses_policy(allowlist_policy):
    import asyncio

    from sandbox.mcp.server import mcp_server

    denied = asyncio.run(
        mcp_server.call_tool(
            tool_name="list_files",
            caller_id="t",
            client_ip="8.8.8.8",
            session_id="x",
        )
    )
    assert denied.get("status") == "denied"
    assert "allowlist" in denied.get("error", "").lower()


def test_init_network_policy_from_live_settings():
    """Smoke: process policy can be (re)built from the live settings singleton."""
    from sandbox.config import settings

    policy = init_network_policy(settings)
    assert policy.bind_host
    assert isinstance(policy.allowed_networks, tuple)
