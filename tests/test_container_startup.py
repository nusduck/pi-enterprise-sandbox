"""Compose topology after Wave 6: exec image replaces Python sandbox."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"


def test_compose_builds_exec_as_sandbox_service() -> None:
    text = COMPOSE.read_text()
    assert "dockerfile: exec/Dockerfile" in text
    assert "context: ./exec" not in text


def test_compose_parameterizes_runtime_defaults() -> None:
    text = COMPOSE.read_text()
    expected_fragments = [
        "MCP_SERVERS_JSON: ${MCP_SERVERS_JSON:-[]}",
        # 应用连接串不带口令（ADR 0011 D10）；口令启动时向 DBPM 取。
        "AGENT_DATABASE_URL: ${AGENT_COMPOSE_DATABASE_URL:-mysql://sandbox@mysql:3306/sandbox}",
        "image: mysql:5.7",
        "image: redis:5.0.14",
        "AGENT_REDIS_URL: ${AGENT_COMPOSE_REDIS_URL:-redis://redis:6379/0}",
        "REDIS_URL: ${AGENT_COMPOSE_REDIS_URL:-redis://redis:6379/0}",
        "DBPM_URL: ${DBPM_URL:-dbpm-fake:7000,dbpm-fake:7001}",
        "AGENT_RUNS_QUEUE_NAME: ${AGENT_RUNS_QUEUE_NAME:-agent-runs}",
    ]
    for fragment in expected_fragments:
        assert fragment in text, fragment
