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
    # 服务进程与生产一致：无口令连接串 + 经 DBPM 取密（ADR 0011 D10）。
    assert "startDbpmForUrls({ mysqlUrl: agentMysqlUrl, redisUrl })" in source
    assert "AGENT_DATABASE_URL: appMysqlUrl" in source
    assert "AGENT_REDIS_URL: appRedisUrl" in source
    assert "SANDBOX_DATABASE_URL: appSandboxMysqlUrl" in source
    assert source.count("...dbpmHandle.env") >= 3
    assert "AGENT_DATABASE_URL: agentMysqlUrl" not in source
    assert "SMOKE_SANDBOX_REPLAY_REDIS_URL" in source
    assert "SANDBOX_INTERNAL_HMAC_KEYRING" in source
    assert source.count("SANDBOX_API_TOKEN: SMOKE_SANDBOX_API_TOKEN") >= 3
    assert "['dist/main.js']" in source
    assert "['dist/server.js']" in source
    assert "['dist/worker.js']" in source
    assert "uvicorn" not in source
    assert "sandbox.main:app" not in source
    assert "/api/chat" not in source
    assert "/api/conversations" in source
    assert "/runs" in source


def test_cross_service_ci_provisions_mysql_and_redis_services() -> None:
    workflow = WORKFLOW.read_text(encoding="utf-8")
    job = workflow.split("  cross-service-smoke:", 1)[1]

    assert "    services:\n" in job
    assert "      mysql:\n" in job
    assert "        image: mysql:5.7\n" in job
    assert "      redis:\n" in job
    assert "        image: redis:5.0.14\n" in job
    assert "      sandbox-replay-redis:\n" in job
    assert "        image: bitnamilegacy/redis:7.2\n" in job
    assert "SMOKE_MYSQL_URL: mysql://" in job
    assert "SMOKE_REDIS_URL: redis://" in job
    assert "SMOKE_SANDBOX_REPLAY_REDIS_URL: redis://" in job
    assert 'SMOKE_START_WORKER: "true"' in job
    assert "npm ci --prefix exec" in job
    assert "npm run build --prefix exec" in job
