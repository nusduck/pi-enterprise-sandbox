"""Static MySQL topology / config tests (PR-02 T5).

These tests are file- and Settings-level only: no containers, no live MySQL,
and no new runtime dependencies beyond what the existing test env provides.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox.config import (
    ProductionConfigError,
    Settings,
    _DEFAULT_MYSQL_DATABASE_URL,
    database_url_scheme,
    is_legacy_test_database_url,
    is_mysql_database_url,
    validate_production_settings,
)

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = ROOT / "docker-compose.yml"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"
ENV_EXAMPLE = ROOT / ".env.example"
PYPROJECT = ROOT / "pyproject.toml"
REQUIREMENTS = ROOT / "sandbox" / "requirements.txt"


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

    def test_scheme_and_legacy_classification(self):
        assert database_url_scheme("mysql+pymysql://x") == "mysql+pymysql"
        assert database_url_scheme("sqlite:////tmp/a.db") == "sqlite"
        assert is_legacy_test_database_url("sqlite:////tmp/a.db")
        assert is_legacy_test_database_url("postgresql://u@h/db")
        assert not is_legacy_test_database_url("mysql://u@h/db")


class TestFormalSettingsDefault:
    def test_code_default_is_mysql_not_sqlite(self):
        # Formal field default (before env / kwargs) must be MySQL.
        assert is_mysql_database_url(_DEFAULT_MYSQL_DATABASE_URL)
        assert "sqlite" not in _DEFAULT_MYSQL_DATABASE_URL.lower()
        field_default = Settings.model_fields["database_url"].default
        assert is_mysql_database_url(str(field_default))

    def test_explicit_sqlite_injection_allowed_only_outside_production(self):
        """TEMPORARY GAP: tests may inject sqlite via kwargs; not a prod fallback."""
        s = Settings(
            deployment_env="development",
            database_url="sqlite:////tmp/legacy-test.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        assert is_legacy_test_database_url(s.database_url)
        validate_production_settings(s)  # development is a no-op

        prod = Settings(
            **_production_kwargs(database_url="sqlite:////tmp/legacy-test.db")
        )
        with pytest.raises(ProductionConfigError, match="MySQL"):
            validate_production_settings(prod)


class TestComposeMysqlTopology:
    def test_dev_compose_mysql_only_formal_db(self):
        text = COMPOSE.read_text()
        assert "image: mysql:8.0" in text
        assert "  mysql:" in text
        assert "AGENT_DATABASE_URL:" in text
        assert "SANDBOX_DATABASE_URL:" in text
        assert "mysql+pymysql://sandbox:sandbox_dev_only@mysql:3306/sandbox" in text
        assert "mysql://sandbox:sandbox_dev_only@mysql:3306/sandbox" in text
        # Removed formal topologies
        assert "image: postgres" not in text
        assert "profiles: [\"postgres\"]" not in text
        assert "sqlite:////sandbox/data/sandbox.db" not in text
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
