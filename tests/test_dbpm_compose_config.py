"""DBPM 取密的 Compose 拓扑棘轮（ADR 0011 D10，design §7）。

纯静态检查，不起容器：
- 应用服务（agent / agent-worker / sandbox / sandbox-mcp）的连接串不带口令，
  只拿自己角色需要的 DBPM 条目；facade 拿不到 UPDRDB 条目；
- 开发挡板 dbpm-fake 只挂内部网络、不发布端口、应用服务等它健康；
- 生产 overlay 要求真实 DBPM_URL（无默认、不指向 dbpm-fake），并禁用挡板；
- 假服务端脚本在 production 下拒绝运行。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"
FAKE_DBPM = ROOT / "scripts" / "dev" / "fake-dbpm.mjs"

APP_SERVICES = ("agent", "agent-worker", "sandbox", "sandbox-mcp")
URL_KEYS = ("AGENT_DATABASE_URL", "REDIS_URL", "AGENT_REDIS_URL", "SANDBOX_DATABASE_URL", "SANDBOX_MCP_REDIS_URL")


def _service_block(compose_text: str, name: str) -> str:
    marker = f"\n  {name}:\n"
    start = compose_text.index(marker) + len(marker)
    remainder = compose_text[start:]
    next_service = re.search(r"\n  [A-Za-z][A-Za-z0-9_-]*:\n", remainder)
    return remainder if next_service is None else remainder[: next_service.start()]


def _env_value(block: str, key: str) -> str | None:
    match = re.search(rf"^\s+{re.escape(key)}:\s*(.+)$", block, re.M)
    return None if match is None else match.group(1).strip()


def _embeds_password(url_value: str) -> bool:
    # scheme://user:password@host 或 scheme://:password@host。
    # 先把 Compose 插值（如 ${MYSQL_USER:-sandbox}）换成占位符，否则 `:-` 会被误判成口令分隔符。
    flattened = re.sub(r"\$\{[^}]*\}", "X", url_value)
    return re.search(r"://[^/@\s]*:[^/@\s]*@", flattened) is not None


def test_dev_app_services_use_password_free_urls_and_dbpm() -> None:
    text = COMPOSE.read_text()
    for service in APP_SERVICES:
        block = _service_block(text, service)
        for key in URL_KEYS:
            value = _env_value(block, key)
            if value is not None:
                assert not _embeds_password(value), f"{service} {key} embeds a password"
        assert _env_value(block, "DBPM_URL") == "${DBPM_URL:-dbpm-fake:7000,dbpm-fake:7001}", service
        assert re.search(r"^\s+dbpm-fake:\s*$", block, re.M), f"{service} must wait for dbpm-fake"


def test_dev_app_services_blank_env_file_passwords() -> None:
    # env_file 会把宿主 .env 整体注入；口令只能来自 DBPM，不能躺在应用进程环境里。
    text = COMPOSE.read_text()
    for service in APP_SERVICES:
        block = _service_block(text, service)
        for key in ("MYSQL_PASSWORD", "MYSQL_ROOT_PASSWORD", "REDIS_PASSWORD"):
            assert _env_value(block, key) == '""', f"{service} must blank {key}"


def test_dev_roles_only_get_the_entries_they_consume() -> None:
    text = COMPOSE.read_text()
    for service in ("agent", "agent-worker"):
        block = _service_block(text, service)
        assert "DBPM_DB_NAME:" in block and "DBPM_REDIS_DB_NAME:" in block
    sandbox = _service_block(text, "sandbox")
    assert "DBPM_DB_NAME:" in sandbox
    assert "DBPM_REDIS_DB_NAME:" not in sandbox
    facade = _service_block(text, "sandbox-mcp")
    assert "DBPM_REDIS_DB_NAME:" in facade
    # 对外 facade 不得持有 UPDRDB 条目。
    assert "DBPM_DB_NAME:" not in facade
    assert "DBPM_DB_USER_NAME:" not in facade


def test_dev_fake_dbpm_is_internal_only_and_hardened() -> None:
    block = _service_block(COMPOSE.read_text(), "dbpm-fake")
    assert "ports:" not in block
    assert re.search(r"networks:\n\s+- backend_internal\s*$", block.rstrip() + "\n", re.M)
    assert "service_egress" not in block and "dev_ingress" not in block
    assert "read_only: true" in block
    assert "- ALL" in block
    assert "no-new-privileges:true" in block
    assert "./scripts/dev/fake-dbpm.mjs:/opt/fake-dbpm/fake-dbpm.mjs:ro" in block


def test_no_service_migrates_on_startup() -> None:
    # ADR 0011 D6：开发与生产都不再有自动迁移服务或启动迁移开关；schema 由发布包执行。
    for compose in (COMPOSE, COMPOSE_PROD):
        text = compose.read_text()
        assert re.search(r"^\s+agent-migrate:\s*$", text, re.M) is None, compose.name
        assert "AGENT_MIGRATE_ON_START" not in text, compose.name
        assert "AGENT_MIGRATE_DATABASE_URL" not in text, compose.name


def test_prod_requires_real_dbpm_and_disables_the_stub() -> None:
    text = COMPOSE_PROD.read_text()
    for service in APP_SERVICES:
        block = _service_block(text, service)
        dbpm_url = _env_value(block, "DBPM_URL")
        # `:?` 必填且没有 `:-` 默认值——生产不能悄悄落到开发挡板上。
        assert dbpm_url is not None and dbpm_url.startswith("${DBPM_URL:?"), service
        assert ":-" not in dbpm_url, service
        for key in URL_KEYS:
            value = _env_value(block, key)
            if value is not None:
                assert not _embeds_password(value), f"prod {service} {key} embeds a password"
        assert re.search(r"^\s+dbpm-fake:\s*$", block, re.M) is None, f"prod {service} must not depend on dbpm-fake"
        assert "depends_on: !override" in block, f"prod {service} must drop the base dbpm-fake dependency"

    stub = _service_block(text, "dbpm-fake")
    assert "profiles:" in stub
    assert "DEPLOYMENT_ENV: production" in stub


def test_fake_dbpm_script_refuses_production() -> None:
    source = FAKE_DBPM.read_text(encoding="utf-8")
    assert "DEPLOYMENT_ENV" in source and "production" in source
    assert "refuses to run" in source
    # 日志只报条目与长度，不打印口令本身。
    assert "len=${password.length}" in source
