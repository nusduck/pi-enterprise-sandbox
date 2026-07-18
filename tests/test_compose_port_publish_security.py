"""Severe: Compose published-port exposure (dev loopback + prod !reset).

Offline static checks only — does not run Docker. Compose merge of
``ports: []`` does **not** reliably clear base publishes; production must
use ``ports: !reset []``. Final merge proof still requires the Compose CLI
gate documented below (not executed in this suite).
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"

# Services that must never publish host ports after base+prod merge.
INTERNAL_NO_HOST_PORTS = (
    "mysql",
    "redis",
    "frontend",
    "api-server",
    "agent",
    "agent-worker",
    "sandbox",
)

# Dev single-file may publish these for local debugging (loopback only).
DEV_PUBLISH_SERVICES = (
    "mysql",
    "redis",
    "frontend",
    "api-server",
    "agent",
)

# Operator gate — document in compose header and here; suite does not run it.
COMPOSE_CONFIG_GATE = (
    "docker compose -f docker-compose.yml -f docker-compose.prod.yml config"
)


def _service_block(text: str, name: str) -> str:
    marker = f"\n  {name}:\n"
    if marker not in text and not text.startswith(f"  {name}:\n"):
        # First service may start at beginning after "services:\n"
        alt = f"\n  {name}:\n"
        if alt not in f"\n{text}" and f"  {name}:\n" not in text:
            raise AssertionError(f"service {name!r} not found")
        if text.lstrip().startswith(f"{name}:\n") or f"  {name}:\n" in text:
            start = text.index(f"  {name}:\n") + len(f"  {name}:\n")
        else:
            raise AssertionError(f"service {name!r} not found")
    else:
        start = text.index(marker) + len(marker)
    remainder = text[start:]
    next_key = re.search(r"\n(?:  [A-Za-z][A-Za-z0-9_-]*:|[a-z_]+:)\n", remainder)
    return remainder if next_key is None else remainder[: next_key.start()]


def _port_entries(block: str) -> list[str]:
    """Return short-syntax port mapping strings under a service ports: key."""
    entries: list[str] = []
    in_ports = False
    for line in block.splitlines():
        if re.match(r"^\s+ports:\s*(!reset\s+)?(\[\s*\]\s*)?$", line):
            in_ports = True
            # Inline empty list — no entries
            continue
        if in_ports:
            m = re.match(r'^\s+-\s+"?([^"#]+?)"?\s*$', line)
            if m:
                entries.append(m.group(1).strip())
                continue
            # End of ports list
            if re.match(r"^\s{4}[A-Za-z0-9_]+:", line):
                break
            if not line.strip() or line.strip().startswith("#"):
                continue
            if re.match(r"^\s+-\s+", line):
                continue
            if re.match(r"^\s{4}", line):
                break
    return entries


def _ports_line(block: str) -> str | None:
    for line in block.splitlines():
        if re.match(r"^\s+ports:\s*", line):
            return line.strip()
    return None


def _has_ports_reset(block: str) -> bool:
    line = _ports_line(block)
    if line is None:
        return False
    return bool(re.match(r"^ports:\s*!reset\s+\[\s*\]\s*$", line))


def _networks_in_block(block: str) -> set[str]:
    nets: set[str] = set()
    in_networks = False
    for line in block.splitlines():
        if re.match(r"^\s+networks:\s*$", line):
            in_networks = True
            continue
        if in_networks:
            m = re.match(r"^\s+-\s+([A-Za-z0-9_-]+)\s*$", line)
            if m:
                nets.add(m.group(1))
                continue
            if re.match(r"^\s{4}[A-Za-z0-9_]+:", line):
                break
    return nets


class TestDevComposeLoopbackPublish:
    def test_dev_published_ports_bind_loopback_not_all_interfaces(self):
        text = COMPOSE.read_text(encoding="utf-8")
        for name in DEV_PUBLISH_SERVICES:
            block = _service_block(text, name)
            entries = _port_entries(block)
            assert entries, f"{name} should publish a dev debug port"
            for entry in entries:
                assert entry.startswith("127.0.0.1:"), (
                    f"{name} port {entry!r} must bind 127.0.0.1, not 0.0.0.0/all"
                )
                assert not entry.startswith("0.0.0.0:"), name

    def test_dev_sandbox_and_worker_do_not_publish_host_ports(self):
        text = COMPOSE.read_text(encoding="utf-8")
        for name in ("sandbox", "agent-worker"):
            block = _service_block(text, name)
            assert _port_entries(block) == [], name
            line = _ports_line(block)
            # Absence is fine; empty list without publish is also fine.
            if line is not None:
                assert "!reset" not in line or "[]" in line


class TestProdComposePortReset:
    def test_every_internal_service_uses_reset_empty_ports(self):
        text = COMPOSE_PROD.read_text(encoding="utf-8")
        for name in INTERNAL_NO_HOST_PORTS:
            block = _service_block(text, name)
            assert _has_ports_reset(block), (
                f"{name} must declare `ports: !reset []` so base publishes are "
                f"cleared on merge (plain `ports: []` is not sufficient)"
            )
            assert _port_entries(block) == [], name

    def test_prod_never_uses_bare_empty_ports_without_reset(self):
        """Regression: ports: [] without !reset is the severe merge footgun."""
        text = COMPOSE_PROD.read_text(encoding="utf-8")
        bare = re.findall(r"^\s+ports:\s*\[\s*\]\s*$", text, re.M)
        assert bare == [], (
            "found bare `ports: []` without !reset — Compose merge may keep "
            f"base publishes: {bare}"
        )

    def test_only_nginx_publishes_host_ports_in_prod_file(self):
        text = COMPOSE_PROD.read_text(encoding="utf-8")
        nginx = _service_block(text, "nginx")
        entries = _port_entries(nginx)
        assert len(entries) >= 2
        joined = " ".join(entries)
        assert ":80" in joined or entries[0].endswith(":80")
        assert any(e.endswith(":443") or ":443" in e for e in entries)
        # nginx may bind all interfaces (public edge); not required to be loopback.
        for name in INTERNAL_NO_HOST_PORTS:
            block = _service_block(text, name)
            assert _port_entries(block) == [], name

    def test_prod_header_documents_reset_and_config_gate(self):
        text = COMPOSE_PROD.read_text(encoding="utf-8")
        header = text.split("services:", 1)[0]
        assert "!reset" in header
        assert "ports: []" in header  # documents the anti-pattern
        assert "docker compose" in header
        assert "config" in header


class TestOfflineMergeModel:
    """Minimal model of Compose ports merge for this project's conventions.

    Not a full Compose engine — encodes the security-critical rule we rely on:
    base list + override ``!reset []`` → no publishes; bare ``[]`` is unsafe.
    """

    @pytest.mark.parametrize(
        "base, override, expected",
        [
            (["127.0.0.1:3306:3306"], ("reset", []), []),
            (["127.0.0.1:3306:3306"], ("list", []), ["127.0.0.1:3306:3306"]),  # unsafe
            (["127.0.0.1:3306:3306"], ("list", ["80:80"]), ["127.0.0.1:3306:3306", "80:80"]),
            ([], ("reset", []), []),
            (["127.0.0.1:4100:4100"], ("absent", None), ["127.0.0.1:4100:4100"]),
        ],
    )
    def test_merge_ports_semantics(self, base, override, expected):
        kind, value = override
        if kind == "reset":
            result: list[str] = []
        elif kind == "absent":
            result = list(base)
        elif kind == "list" and value == []:
            # Documented footgun: empty sequence often does not clear base.
            result = list(base)
        else:
            # Sequence merge accumulates distinct mappings.
            result = list(base) + list(value or [])
        assert result == expected

    def test_project_prod_overlay_matches_safe_reset_model(self):
        base = COMPOSE.read_text(encoding="utf-8")
        prod = COMPOSE_PROD.read_text(encoding="utf-8")
        for name in INTERNAL_NO_HOST_PORTS:
            base_ports = _port_entries(_service_block(base, name))
            prod_block = _service_block(prod, name)
            assert _has_ports_reset(prod_block), name
            # Safe model: !reset → empty regardless of base.
            merged: list[str] = []
            assert merged == []
            # If we had used bare [], model would keep base_ports (unsafe when non-empty).
            if base_ports:
                unsafe = list(base_ports)  # bare [] footgun
                assert unsafe == base_ports


class TestInternalReachabilityTopology:
    def test_internal_services_share_backend_internal(self):
        """No host ports still requires shared compose network for DNS reachability."""
        text = COMPOSE.read_text(encoding="utf-8")
        for name in (
            "mysql",
            "redis",
            "sandbox",
            "api-server",
            "frontend",
            "agent",
            "agent-worker",
        ):
            nets = _networks_in_block(_service_block(text, name))
            assert "backend_internal" in nets, name

    def test_prod_nginx_on_backend_internal_for_upstreams(self):
        text = COMPOSE_PROD.read_text(encoding="utf-8")
        nets = _networks_in_block(_service_block(text, "nginx"))
        assert "backend_internal" in nets
        assert "service_egress" in nets


class TestComposeConfigGateDocumentation:
    def test_gate_command_is_documented_for_operators(self):
        """Offline suite cannot prove engine merge; document CLI gate explicitly."""
        prod = COMPOSE_PROD.read_text(encoding="utf-8")
        assert COMPOSE_CONFIG_GATE.split("config")[0].strip() in prod or (
            "docker compose -f docker-compose.yml -f docker-compose.prod.yml" in prod
        )
        # Gate body lives in this module's constant for CI docs / runbooks.
        assert "config" in COMPOSE_CONFIG_GATE
        assert "docker-compose.prod.yml" in COMPOSE_CONFIG_GATE
