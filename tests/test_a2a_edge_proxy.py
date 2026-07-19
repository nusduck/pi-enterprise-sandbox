"""Production edge routing contract for public A2A HTTP and SSE traffic."""

from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
NGINX_CONFIG = ROOT / "nginx" / "conf.d" / "sandbox.conf"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"


def _location_block(config: str, marker: str) -> str:
    start = config.index(marker)
    brace = config.index("{", start)
    depth = 0
    for index in range(brace, len(config)):
        if config[index] == "{":
            depth += 1
        elif config[index] == "}":
            depth -= 1
            if depth == 0:
                return config[start : index + 1]
    raise AssertionError(f"unterminated nginx location: {marker}")


def test_public_agent_card_is_proxied_directly_to_agent() -> None:
    config = NGINX_CONFIG.read_text(encoding="utf-8")
    block = _location_block(config, "location = /.well-known/agent-card.json")

    assert "proxy_pass http://agent:4100;" in block
    assert "proxy_set_header Authorization $http_authorization;" in block
    assert "proxy_set_header X-Forwarded-Proto $scheme;" in block
    assert "Cache-Control \"no-store" in block


def test_a2a_proxy_preserves_auth_and_disables_sse_buffering() -> None:
    config = NGINX_CONFIG.read_text(encoding="utf-8")
    block = _location_block(config, "location ~ ^/a2a(?:/|$)")

    for directive in (
        "proxy_pass http://agent:4100;",
        "proxy_http_version 1.1;",
        "proxy_set_header Authorization $http_authorization;",
        "proxy_buffering off;",
        "proxy_cache off;",
        "proxy_request_buffering off;",
        "proxy_set_header Connection '';",
        "proxy_read_timeout 3600s;",
    ):
        assert directive in block


def test_production_nginx_waits_for_direct_agent_upstream() -> None:
    compose = COMPOSE_PROD.read_text(encoding="utf-8")
    nginx_start = compose.index("\n  nginx:\n")
    nginx_end = compose.index("\n  sandbox:\n", nginx_start)
    nginx = compose[nginx_start:nginx_end]

    assert "agent:\n        condition: service_started" in nginx
    assert "- backend_internal" in nginx
