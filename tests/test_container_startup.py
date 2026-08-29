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
        "AGENT_DATABASE_URL: ${AGENT_DATABASE_URL:-mysql://sandbox:sandbox_dev_only@mysql:3306/sandbox}",
        "image: mysql:8.0",
        "image: redis:7.2",
        "AGENT_REDIS_URL: ${AGENT_REDIS_URL:-redis://:redis_dev_only@redis:6379/0}",
        "REDIS_URL: ${REDIS_URL:-redis://:redis_dev_only@redis:6379/0}",
        "AGENT_RUNS_QUEUE_NAME: ${AGENT_RUNS_QUEUE_NAME:-agent-runs}",
    ]
    for fragment in expected_fragments:
        assert fragment in text, fragment
