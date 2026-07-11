"""Container startup parameterization tests."""

from __future__ import annotations

from pathlib import Path
import subprocess


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
        "SANDBOX_IPTABLES_ENABLED",
        "SANDBOX_IPTABLES_DEFAULT_POLICY",
        "SANDBOX_ALLOWED_DNS_PORTS",
        "SANDBOX_ALLOWED_TCP_PORTS",
        "SANDBOX_ALLOWED_UDP_PORTS",
        "SANDBOX_ALLOWED_CIDRS",
        "SANDBOX_UVICORN_WORKERS",
        "SANDBOX_UVICORN_RELOAD",
        "SANDBOX_UVICORN_PROXY_HEADERS",
        "SANDBOX_UVICORN_FORWARDED_ALLOW_IPS",
        "SANDBOX_UVICORN_EXTRA_ARGS",
    ]
    for var in expected_vars:
        assert var in text


def test_compose_parameterizes_runtime_defaults() -> None:
    text = COMPOSE.read_text()
    expected_fragments = [
        '"${SANDBOX_MCP_HOST_PORT:-8093}:${SANDBOX_MCP_PORT:-8091}"',
        "SANDBOX_DATABASE_URL: ${SANDBOX_DATABASE_URL:-sqlite:////sandbox/data/sandbox.db}",
        "SANDBOX_MAX_MEMORY_MB: ${SANDBOX_MAX_MEMORY_MB:-512}",
        "SANDBOX_IPTABLES_ENABLED: ${SANDBOX_IPTABLES_ENABLED:-true}",
        "SANDBOX_ALLOWED_CLIENT_CIDRS:",
        "SANDBOX_TRUSTED_PROXY_CIDRS:",
        "SANDBOX_BIND_HOST:",
        "${FRONTEND_PORT:-3000}:80",
    ]
    for fragment in expected_fragments:
        assert fragment in text


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
        "psycopg2-binary",
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
