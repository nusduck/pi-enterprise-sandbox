"""Container startup parameterization tests."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENTRYPOINT = ROOT / "sandbox" / "entrypoint.sh"
COMPOSE = ROOT / "docker-compose.yml"
REQUIREMENTS = ROOT / "sandbox" / "requirements.txt"


def test_entrypoint_shell_syntax_is_valid() -> None:
    result = subprocess.run(
        ["bash", "-n", str(ENTRYPOINT)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr


def test_entrypoint_exposes_startup_network_and_uvicorn_parameters() -> None:
    text = ENTRYPOINT.read_text()
    expected_vars = [
        "SANDBOX_BIND_HOST",
        "SANDBOX_HOST",
        "SANDBOX_PORT",
        "SANDBOX_APP_MODULE",
        "SANDBOX_RUN_AS_USER",
        "SANDBOX_NETWORK_MODE",
        "SANDBOX_UVICORN_WORKERS",
        "SANDBOX_UVICORN_RELOAD",
        "SANDBOX_UVICORN_PROXY_HEADERS",
        "SANDBOX_UVICORN_FORWARDED_ALLOW_IPS",
        "SANDBOX_UVICORN_EXTRA_ARGS",
    ]
    for var in expected_vars:
        assert var in text
    # iptables / port+CIDR union allowlist removed as isolation authority.
    for removed in (
        "SANDBOX_IPTABLES_ENABLED",
        "SANDBOX_IPTABLES_DEFAULT_POLICY",
        "SANDBOX_ALLOWED_DNS_PORTS",
        "SANDBOX_ALLOWED_TCP_PORTS",
        "SANDBOX_ALLOWED_UDP_PORTS",
        "SANDBOX_ALLOWED_CIDRS",
        "apply_iptables",
    ):
        assert removed not in text


def test_compose_parameterizes_runtime_defaults() -> None:
    text = COMPOSE.read_text()
    expected_fragments = [
        "MCP_SERVERS_JSON: ${MCP_SERVERS_JSON:-[]}",
        "SANDBOX_DATABASE_URL: ${SANDBOX_COMPOSE_DATABASE_URL:-mysql+pymysql://sandbox:sandbox_dev_only@mysql:3306/sandbox}",
        "AGENT_DATABASE_URL: ${AGENT_DATABASE_URL:-mysql://sandbox:sandbox_dev_only@mysql:3306/sandbox}",
        "image: mysql:8.0",
        "image: redis:7.2",
        "AGENT_REDIS_URL: ${AGENT_REDIS_URL:-redis://:redis_dev_only@redis:6379/0}",
        "REDIS_URL: ${REDIS_URL:-redis://:redis_dev_only@redis:6379/0}",
        "AGENT_RUNS_QUEUE_NAME: ${AGENT_RUNS_QUEUE_NAME:-agent-runs}",
        "AGENT_RUN_LEASE_TTL_MS: ${AGENT_RUN_LEASE_TTL_MS:-30000}",
        "AGENT_RUN_LEASE_RENEW_INTERVAL_MS: ${AGENT_RUN_LEASE_RENEW_INTERVAL_MS:-10000}",
        "AGENT_RUN_STREAM_MAXLEN: ${AGENT_RUN_STREAM_MAXLEN:-10000}",
        "BFF_DEV_ACTING_ROLE: ${BFF_DEV_ACTING_ROLE:-user}",
        "SANDBOX_MAX_MEMORY_MB: ${SANDBOX_MAX_MEMORY_MB:-512}",
        "SANDBOX_NETWORK_MODE:",
        "SANDBOX_POLICY_PROFILE: ${SANDBOX_POLICY_PROFILE:-balanced}",
        "SANDBOX_ISOLATION_BACKEND: ${SANDBOX_ISOLATION_BACKEND:-bubblewrap}",
        "SANDBOX_ISOLATION_REQUIRED: ${SANDBOX_ISOLATION_REQUIRED:-true}",
        "SANDBOX_ALLOWED_CLIENT_CIDRS:",
        "SANDBOX_TRUSTED_PROXY_CIDRS:",
        "SANDBOX_BIND_HOST:",
        "DEPLOYMENT_ENV:",
        "127.0.0.1:${FRONTEND_PORT:-3000}:80",
        "backend_internal:",
        "service_egress:",
        "internal: true",
    ]
    for fragment in expected_fragments:
        assert fragment in text
    # A stale canonical SANDBOX_DATABASE_URL in .env must not override the
    # formal MySQL default used by the Compose service environment.
    sandbox_start = text.index("\n  sandbox:\n")
    sandbox_block = text[sandbox_start:]
    assert "SANDBOX_COMPOSE_DATABASE_URL" in sandbox_block
    assert "${SANDBOX_DATABASE_URL:-" not in sandbox_block
    # No container-wide iptables isolation knobs or granted NET caps.
    assert "SANDBOX_IPTABLES_ENABLED" not in text
    granted_caps = re.findall(
        r"^\s+-\s+(NET_ADMIN|NET_RAW)\s*$", text, re.M
    )
    assert granted_caps == []
    # PostgreSQL and SQLite are no longer formal compose defaults.
    assert "image: postgres" not in text
    assert "sqlite:////sandbox/data/sandbox.db" not in text
    assert "sandbox_data" not in text
    assert ":/sandbox/data" not in text
    # Agent depends on healthy Redis; BFF/Sandbox do not take Redis authority.
    agent_start = text.index("\n  agent:\n")
    agent_end = text.index("\n  agent-worker:\n")
    agent_block = text[agent_start:agent_end]
    assert "redis:" in agent_block
    assert "condition: service_healthy" in agent_block
    api_start = text.index("\n  api-server:\n")
    api_block = text[api_start:agent_start]
    assert "AGENT_REDIS_URL" not in api_block
    assert "REDIS_URL" not in api_block


def test_compose_projects_symmetric_policy_into_agent_and_sandbox_only() -> None:
    text = COMPOSE.read_text()

    def service_block(name: str) -> str:
        marker = f"\n  {name}:\n"
        start = text.index(marker) + len(marker)
        remainder = text[start:]
        next_service = re.search(r"\n  [A-Za-z][A-Za-z0-9_-]*:\n", remainder)
        return remainder if next_service is None else remainder[:next_service.start()]

    agent = service_block("agent")
    sandbox = service_block("sandbox")
    api_server = service_block("api-server")
    for block in (agent, sandbox):
        assert "SANDBOX_POLICY_PROFILE: ${SANDBOX_POLICY_PROFILE:-balanced}" in block
        assert "SANDBOX_ISOLATION_BACKEND: ${SANDBOX_ISOLATION_BACKEND:-bubblewrap}" in block
        assert "SANDBOX_ISOLATION_REQUIRED: ${SANDBOX_ISOLATION_REQUIRED:-true}" in block
    assert "SANDBOX_POLICY_PROFILE" not in api_server


def test_sandbox_requirements_cover_plan_dependency_buckets() -> None:
    requirements = REQUIREMENTS.read_text()
    expected_packages = [
        "pandas",
        "numpy",
        "matplotlib",
        "mammoth",
        "openpyxl",
        "PyMuPDF",
        "pdfplumber",
        "python-docx",
        "markitdown",
        "pymysql",
        "redis",
        "requests",
        "httpx",
        "beautifulsoup4",
        "Pillow",
        "python-dotenv",
        "pyyaml",
        "jinja2",
    ]
    for package in expected_packages:
        assert package in requirements
