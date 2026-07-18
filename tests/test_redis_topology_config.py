"""Static Redis topology / config tests (PR-03 slice C).

File- and compose-level only: no containers, no live Redis, no network.
Validates Agent-only coordination topology wiring and production secret gates.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"
ENV_EXAMPLE = ROOT / ".env.example"
README = ROOT / "README.md"
ARCHITECTURE = ROOT / "docs" / "architecture.md"
DEPLOYMENT = ROOT / "docs" / "deployment.md"
DEVELOPMENT = ROOT / "docs" / "development.md"


def _service_block(compose_text: str, name: str) -> str:
    marker = f"\n  {name}:\n"
    start = compose_text.index(marker) + len(marker)
    remainder = compose_text[start:]
    next_service = re.search(r"\n  [A-Za-z][A-Za-z0-9_-]*:\n", remainder)
    return remainder if next_service is None else remainder[: next_service.start()]


class TestComposeRedisTopology:
    def test_dev_compose_pinned_redis_7_with_healthcheck(self):
        text = COMPOSE.read_text()
        assert "image: redis:7.2" in text
        assert "  redis:" in text
        assert "requirepass" in text
        assert "appendonly" in text
        assert "redis_dev_data" in text
        redis = _service_block(text, "redis")
        assert "redis-cli" in redis
        assert "ping" in redis
        assert "healthcheck:" in redis
        assert "${REDIS_PASSWORD:-redis_dev_only}" in redis

    def test_dev_compose_agent_depends_on_healthy_redis(self):
        text = COMPOSE.read_text()
        agent = _service_block(text, "agent")
        assert "redis:" in agent
        assert "condition: service_healthy" in agent
        # Agent gets Redis authority + queue/lease/stream settings
        assert "AGENT_REDIS_URL:" in agent
        assert "REDIS_URL:" in agent
        assert "redis://:redis_dev_only@redis:6379/0" in agent
        assert "AGENT_RUNS_QUEUE_NAME:" in agent
        assert "agent-runs" in agent
        assert "AGENT_RUN_LEASE_TTL_MS:" in agent
        assert "30000" in agent
        assert "AGENT_RUN_LEASE_RENEW_INTERVAL_MS:" in agent
        assert "10000" in agent
        assert "AGENT_RUN_STREAM_MAXLEN:" in agent
        assert "10000" in agent

    def test_dev_compose_bff_lacks_redis_authority_sandbox_replay_only(self):
        text = COMPOSE.read_text()
        api = _service_block(text, "api-server")
        sandbox = _service_block(text, "sandbox")
        # BFF never holds Redis coordination authority.
        assert re.search(r"^\s+AGENT_REDIS_URL:", api, re.M) is None
        assert re.search(r"^\s+REDIS_URL:", api, re.M) is None
        assert re.search(r"^\s+TEST_REDIS_URL:", api, re.M) is None
        assert re.search(r"^\s+redis:\s*$", api, re.M) is None
        # Sandbox uses dedicated sandbox-replay-redis (independent secret), never
        # Agent REDIS_URL / AGENT_REDIS_URL / shared REDIS_PASSWORD authority.
        assert re.search(r"^\s+AGENT_REDIS_URL:", sandbox, re.M) is None
        assert re.search(r"^\s+REDIS_URL:", sandbox, re.M) is None
        assert "SANDBOX_INTERNAL_REDIS_URL" in sandbox
        assert "SANDBOX_INTERNAL_PLANE_ENABLED" in sandbox
        assert "sandbox-replay-redis:6379/0" in sandbox
        assert "REDIS_PASSWORD" not in sandbox or "SANDBOX_INTERNAL" in sandbox
        assert "sandbox-replay-redis:" in text
        assert re.search(r"^\s+sandbox-replay-redis:\s*$", sandbox, re.M) is not None

    def test_dev_compose_no_postgres_or_sqlite_formal_topology(self):
        text = COMPOSE.read_text()
        assert "image: postgres" not in text
        assert "profiles: [\"postgres\"]" not in text
        assert "sqlite:////sandbox/data/sandbox.db" not in text
        assert "POSTGRES_" not in text

    def test_prod_compose_redis_requires_password_and_agent_wiring(self):
        text = COMPOSE_PROD.read_text()
        assert "image: redis:7.2" in text
        assert "REDIS_PASSWORD:?Set REDIS_PASSWORD for production" in text
        assert "requirepass" in text
        assert "redis_data" in text
        redis = _service_block(text, "redis")
        # Compose merge may use ports: [] or ports: !reset []
        assert "ports:" in redis and ("[]" in redis or "!reset" in redis)
        assert "healthcheck:" in redis

        agent = _service_block(text, "agent")
        assert "AGENT_REDIS_URL:" in agent
        assert "REDIS_URL:" in agent
        assert "REDIS_PASSWORD:?Set REDIS_PASSWORD for production" in agent
        assert "redis:" in agent
        assert "condition: service_healthy" in agent
        assert "AGENT_RUNS_QUEUE_NAME:" in agent
        assert "AGENT_RUN_LEASE_TTL_MS:" in agent
        assert "AGENT_RUN_STREAM_MAXLEN:" in agent

        api = _service_block(text, "api-server")
        sandbox = _service_block(text, "sandbox")
        assert re.search(r"^\s+AGENT_REDIS_URL:", api, re.M) is None
        assert re.search(r"^\s+REDIS_URL:", api, re.M) is None
        assert re.search(r"^\s+AGENT_REDIS_URL:", sandbox, re.M) is None
        assert re.search(r"^\s+REDIS_URL:", sandbox, re.M) is None
        # Production Sandbox: mandatory internal plane + independent replay Redis.
        assert "SANDBOX_INTERNAL_PLANE_ENABLED" in sandbox
        assert "SANDBOX_INTERNAL_REDIS_URL" in sandbox
        assert "SANDBOX_INTERNAL_REDIS_PASSWORD" in text
        assert "sandbox-replay-redis:6379/0" in sandbox
        assert "SANDBOX_INTERNAL_HMAC_KEYRING" in sandbox
        # Must not wire Agent REDIS_PASSWORD into Sandbox internal URL.
        assert "REDIS_PASSWORD:?Set REDIS_PASSWORD for production}@redis:6379/2" not in sandbox
        assert "sandbox-replay-redis:" in text
        assert "sandbox_replay_redis_data" in text

        assert "image: postgres" not in text
        assert "POSTGRES_" not in text
        assert "sqlite:" not in text


class TestEnvRedisCatalog:
    def test_env_example_documents_redis_urls_and_settings(self):
        text = ENV_EXAMPLE.read_text()
        required = [
            "REDIS_PASSWORD=",
            "REDIS_URL=",
            "AGENT_REDIS_URL=",
            "TEST_REDIS_URL",
            "AGENT_RUNS_QUEUE_NAME=",
            "AGENT_RUN_LEASE_TTL_MS=",
            "AGENT_RUN_LEASE_RENEW_INTERVAL_MS=",
            "AGENT_RUN_STREAM_MAXLEN=",
            "agent-runs",
            "30000",
            "10000",
        ]
        for fragment in required:
            assert fragment in text, f"missing {fragment!r} in .env.example"
        assert "redis://:redis_dev_only@redis:6379/0" in text
        # Sandbox replay-only plane (independent secret; no real prod values)
        assert "SANDBOX_INTERNAL_REDIS_URL=" in text
        assert "SANDBOX_INTERNAL_REDIS_PASSWORD=" in text
        assert "SANDBOX_INTERNAL_PLANE_ENABLED=" in text
        assert "sandbox-replay-redis" in text
        # Env example must not embed a production-looking shared secret for replay.
        assert "REDIS_PASSWORD=@redis:6379/2" not in text
        # Dev placeholder only — not a production-looking secret dump
        assert "redis_dev_only" in text
        assert "POSTGRES_PASSWORD" not in text
        assert "sqlite:////sandbox/data/sandbox.db" not in text

    def test_env_example_documents_clearing_and_outbox_recovery(self):
        text = ENV_EXAMPLE.read_text().lower()
        assert "outbox" in text
        assert "mysql" in text
        # Clearing Redis loses coordination, not facts
        assert "协调" in ENV_EXAMPLE.read_text() or "coordination" in text
        assert "事实" in ENV_EXAMPLE.read_text() or "fact" in text


class TestDocsRedisRecovery:
    def test_active_docs_cover_redis_boundary_and_recovery(self):
        arch = ARCHITECTURE.read_text()
        deploy = DEPLOYMENT.read_text()
        develop = DEVELOPMENT.read_text()
        readme = README.read_text()

        for text in (arch, deploy, develop, readme):
            assert "Redis" in text or "redis" in text
            assert "AGENT_REDIS_URL" in text or "REDIS_URL" in text

        # Recovery narrative: Redis clear ≠ MySQL fact loss; Outbox/replay
        recovery_corpus = arch + deploy + develop
        assert "Outbox" in recovery_corpus or "outbox" in recovery_corpus
        assert "domain_outbox" in recovery_corpus or "run_events" in recovery_corpus
        assert "清空" in recovery_corpus or "clear" in recovery_corpus.lower()

        # Production password requirement documented
        assert "REDIS_PASSWORD" in (deploy + ENV_EXAMPLE.read_text() + readme)

        # No formal Postgres/SQLite topology reintroduced in architecture
        assert "sole formal" in arch.lower() or "唯一正式" in arch
        assert "Agent-only" in arch or "Agent 独占" in arch or "Agent-only" in deploy
