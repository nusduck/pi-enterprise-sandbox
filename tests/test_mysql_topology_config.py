"""Static MySQL topology / config tests (PR-02 T5).

These tests are file- and Settings-level only: no containers, no live MySQL,
and no new runtime dependencies beyond what the existing test env provides.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sandbox.config import (
    ProductionConfigError,
    Settings,
    _DEFAULT_MYSQL_DATABASE_URL,
    database_url_scheme,
    is_mysql_database_url,
    ensure_safe_to_start,
    validate_production_settings,
)

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"
ENV_EXAMPLE = ROOT / ".env.example"
PYPROJECT = ROOT / "pyproject.toml"
REQUIREMENTS = ROOT / "sandbox" / "requirements.txt"


def _service_block(text: str, name: str) -> str:
    marker = f"\n  {name}:\n"
    start = text.index(marker) + len(marker)
    remainder = text[start:]
    next_section = re.search(r"\n  [A-Za-z][A-Za-z0-9_-]*:\n", remainder)
    return remainder if next_section is None else remainder[: next_section.start()]


def _service_mapping_keys(block: str, field: str) -> set[str]:
    marker = f"    {field}:\n"
    start = block.index(marker) + len(marker)
    remainder = block[start:]
    end = re.search(r"^    \S", remainder, re.MULTILINE)
    mapping = remainder if end is None else remainder[: end.start()]
    return set(re.findall(r"^      ([A-Za-z][A-Za-z0-9_-]*):", mapping, re.MULTILINE))


def _strong_secret(seed: str = "a") -> str:
    return (seed * 64)[:64]


def _prod_hmac_keyring() -> tuple[str, str]:
    import base64
    import json

    key = base64.urlsafe_b64encode(b"k" * 32).decode("ascii").rstrip("=")
    return json.dumps({"kid-1": key}), "kid-1"


def _production_kwargs(**overrides):
    kr, kid = _prod_hmac_keyring()
    base = {
        "deployment_env": "production",
        "api_token": _strong_secret("t"),
        "auth_enabled": True,
        "jwt_secret": _strong_secret("j"),
        "jwt_issuer": "pi-enterprise-sandbox",
        "jwt_audience": "pi-enterprise-sandbox",
        "auth_allow_public_register": False,
        "network_mode": "disabled",
        "isolation_backend": "bubblewrap",
        "isolation_required": True,
        "cors_origins": ["https://app.example.com"],
        "cors_allow_credentials": True,
        "debug": False,
        "database_url": "mysql+pymysql://sandbox@mysql:3306/sandbox",
        "allowed_client_cidrs": ["127.0.0.1/32"],
        "trusted_proxy_cidrs": [],
        "internal_plane_enabled": True,
        "internal_redis_url": "redis://:prod_replay_only_secret@sandbox-replay-redis:6379/0",
        "internal_hmac_keyring": kr,
        "internal_hmac_active_kid": kid,
        "internal_drain_timeout_seconds": 30.0,
    }
    base.update(overrides)
    return base


class TestMysqlUrlHelpers:
    @pytest.mark.parametrize(
        "url,expected",
        [
            ("mysql://u@h:3306/db", True),
            ("mysql+pymysql://u@h:3306/db", True),
            ("mysql2://u@h:3306/db", True),
            ("sqlite:////tmp/x.db", False),
            ("postgresql://u@h:5432/db", False),
            ("postgres://u@h:5432/db", False),
            ("", False),
            (None, False),
        ],
    )
    def test_is_mysql_database_url(self, url, expected):
        assert is_mysql_database_url(url) is expected

    def test_scheme_classification(self):
        assert database_url_scheme("mysql+pymysql://x") == "mysql+pymysql"
        assert database_url_scheme("sqlite:////tmp/a.db") == "sqlite"


class TestFormalSettingsDefault:
    def test_code_default_is_mysql_not_sqlite(self):
        # Formal field default (before env / kwargs) must be MySQL.
        assert is_mysql_database_url(_DEFAULT_MYSQL_DATABASE_URL)
        assert "sqlite" not in _DEFAULT_MYSQL_DATABASE_URL.lower()
        field_default = Settings.model_fields["database_url"].default
        assert is_mysql_database_url(str(field_default))

    @pytest.mark.parametrize(
        "database_url",
        [
            "sqlite:////tmp/unmarked-legacy.db",
            "postgresql://sandbox@postgres:5432/sandbox",
        ],
    )
    def test_startup_rejects_non_mysql_even_in_development(self, database_url):
        settings = Settings(
            deployment_env="development",
            database_url=database_url,
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        with pytest.raises(ProductionConfigError, match="formal Sandbox runtime"):
            ensure_safe_to_start(settings)


class TestComposeMysqlTopology:
    def test_compose_uses_one_shot_migration_owner_without_dependency_cycle(self):
        text = COMPOSE.read_text()
        migrate = _service_block(text, "agent-migrate")
        assert 'restart: "no"' in migrate
        assert 'command: ["node", "src/infrastructure/mysql/cli-migrate.js", "latest"]' in migrate
        assert "mysql:" in migrate
        assert "condition: service_healthy" in migrate
        assert "backend_internal" in migrate
        assert _service_mapping_keys(migrate, "depends_on") == {"mysql"}

        for service in ("sandbox", "agent", "agent-worker"):
            block = _service_block(text, service)
            assert "agent-migrate:" in block, service
            assert "condition: service_completed_successfully" in block, service

        for service in ("agent", "agent-worker"):
            block = _service_block(text, service)
            assert 'AGENT_MIGRATE_ON_START: "false"' in block, service

    def test_prod_overlay_preserves_one_shot_owner_and_disables_runtime_migrate(self):
        text = COMPOSE_PROD.read_text()
        migrate = _service_block(text, "agent-migrate")
        assert "MYSQL_PASSWORD:?Set MYSQL_PASSWORD for production" in migrate
        assert 'restart: "no"' in migrate
        assert "ports: !reset []" in migrate
        assert "backend_internal" in migrate
        assert _service_mapping_keys(migrate, "depends_on") == {"mysql"}
        for service in ("sandbox", "agent", "agent-worker"):
            block = _service_block(text, service)
            assert "agent-migrate:" in block, service
            assert "condition: service_completed_successfully" in block, service
        for service in ("agent", "agent-worker"):
            assert 'AGENT_MIGRATE_ON_START: "false"' in _service_block(
                text, service
            )

    def test_dev_compose_mysql_only_formal_db(self):
        text = COMPOSE.read_text()
        assert "image: mysql:8.0" in text
        assert "  mysql:" in text
        assert "AGENT_DATABASE_URL:" in text
        assert "SANDBOX_DATABASE_URL:" in text
        sandbox = _service_block(text, "sandbox")
        # Compose must not interpolate the canonical variable loaded from
        # env_file may contain an obsolete or service-inappropriate DSN.
        assert "SANDBOX_COMPOSE_DATABASE_URL" in sandbox
        assert "${SANDBOX_DATABASE_URL:-" not in sandbox
        # Services that load the shared env file but do not own Sandbox
        # persistence explicitly clear this authority.
        for service in ("agent-migrate", "api-server", "agent", "agent-worker"):
            assert 'SANDBOX_DATABASE_URL: ""' in _service_block(text, service)
        assert "SANDBOX_LEGACY_TEST_RUNTIME" not in text
        assert "mysql+pymysql://sandbox:sandbox_dev_only@mysql:3306/sandbox" in text
        assert "mysql://sandbox:sandbox_dev_only@mysql:3306/sandbox" in text
        # Removed formal topologies
        assert "image: postgres" not in text
        assert "profiles: [\"postgres\"]" not in text
        assert "sqlite:////sandbox/data/sandbox.db" not in text
        assert "sandbox_data" not in text
        assert ":/sandbox/data" not in text
        # Sandbox and agent depend on healthy mysql
        assert "condition: service_healthy" in text

    def test_prod_compose_mysql_requires_secrets(self):
        text = COMPOSE_PROD.read_text()
        assert "image: mysql:8.0" in text
        assert "MYSQL_PASSWORD:?Set MYSQL_PASSWORD for production" in text
        assert "MYSQL_ROOT_PASSWORD:?Set MYSQL_ROOT_PASSWORD for production" in text
        assert "mysql+pymysql://" in text
        assert "AGENT_DATABASE_URL:" in text
        assert "image: postgres" not in text
        assert "POSTGRES_" not in text
        assert "sqlite:" not in text

    def test_compose_mysql_trusts_function_creators_without_app_super(self):
        """CREATE TRIGGER needs log_bin_trust_function_creators; never SUPER for app."""
        for path in (COMPOSE, COMPOSE_PROD):
            text = path.read_text()
            assert "--log-bin-trust-function-creators=1" in text, path.name
            # App credentials come from MYSQL_USER — no SQL SUPER grants.
            assert "GRANT SUPER ON" not in text.upper()
            assert "SYSTEM_VARIABLES_ADMIN" not in text.upper()
            # Document that external/managed is operator-owned
            if path == COMPOSE_PROD:
                assert "external/managed" in text.lower() or "managed mysql" in text.lower()

    def test_env_example_documents_mysql_urls(self):
        text = ENV_EXAMPLE.read_text()
        assert "AGENT_DATABASE_URL=" in text
        assert "SANDBOX_DATABASE_URL=" in text
        assert "MYSQL_DATABASE=" in text
        assert "MYSQL_PASSWORD=" in text
        assert "mysql+pymysql://" in text
        assert "SANDBOX_COMPOSE_DATABASE_URL" in text
        assert "SANDBOX_LEGACY_TEST_RUNTIME" not in text
        assert "sqlite:////sandbox/data/sandbox.db" not in text
        assert "POSTGRES_PASSWORD" not in text


class TestDependencyManifest:
    def test_pyproject_declares_pymysql(self):
        text = PYPROJECT.read_text()
        # Accept either PyPI spelling; do not require lock update in this task.
        assert "PyMySQL" in text or "pymysql" in text

    def test_sandbox_requirements_include_pymysql(self):
        text = REQUIREMENTS.read_text().lower()
        assert "pymysql" in text
