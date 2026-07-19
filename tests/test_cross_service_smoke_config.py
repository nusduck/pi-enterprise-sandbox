"""Regression checks for the formal cross-service smoke topology."""

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "smoke-cross-service.mjs"
WORKFLOW = ROOT / ".github" / "workflows" / "test.yml"


def test_cross_service_smoke_uses_formal_mysql_redis_and_worker() -> None:
    source = SMOKE.read_text(encoding="utf-8")

    assert "sqlite:///" not in source.lower()
    assert "SANDBOX_LEGACY_TEST_RUNTIME" not in source
    assert "prepareDataPlane(agentMysqlUrl, redisUrl, replayRedisUrl)" in source
    assert "migrateLatest(knex)" in source
    assert "AGENT_DATABASE_URL: agentMysqlUrl" in source
    assert "AGENT_REDIS_URL: redisUrl" in source
    assert "SMOKE_SANDBOX_REPLAY_REDIS_URL" in source
    assert "SANDBOX_INTERNAL_PLANE_ENABLED: 'true'" in source
    assert "SANDBOX_INTERNAL_HMAC_KEYRING" in source
    assert "SANDBOX_AUTH_ENABLED: 'true'" in source
    assert source.count("SANDBOX_API_TOKEN: SMOKE_SANDBOX_API_TOKEN") >= 3
    assert "['worker.js']" in source
    assert "/api/chat" not in source
    assert "/api/conversations" in source
    assert "/runs" in source


def test_cross_service_ci_provisions_mysql_and_redis_services() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    job = workflow.split("  cross-service-smoke:", 1)[1]

    assert "    services:\n" in job
    assert "      mysql:\n" in job
    assert "        image: mysql:8.0\n" in job
    assert "      redis:\n" in job
    assert "        image: redis:7.2\n" in job
    assert "      sandbox-replay-redis:\n" in job
    assert "        image: bitnamilegacy/redis:7.2\n" in job
    assert "SMOKE_MYSQL_URL: mysql://" in job
    assert "SMOKE_REDIS_URL: redis://" in job
    assert "SMOKE_SANDBOX_REPLAY_REDIS_URL: redis://" in job
    assert 'SMOKE_START_WORKER: "true"' in job
