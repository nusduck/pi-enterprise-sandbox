"""R6: Env catalog, production unsafe matrix, effective-config redaction."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sandbox.config import (
    ProductionConfigError,
    Settings,
    effective_config,
    validate_production_settings,
)

ROOT = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = ROOT / ".env.example"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"
COMPOSE = ROOT / "docker-compose.yml"


def _strong_secret(seed: str = "a") -> str:
    # 64 hex-like chars, no weak markers
    return (seed * 64)[:64]


def _production_kwargs(**overrides):
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
        "database_url": "sqlite:////tmp/prod-test.db",
        "allowed_client_cidrs": ["127.0.0.1/32"],
        "trusted_proxy_cidrs": [],
    }
    base.update(overrides)
    return base


class TestNetworkMode:
    def test_disabled_denies_network_commands(self):
        s = Settings(
            network_mode="disabled",
            database_url="sqlite:////tmp/net-disabled.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        assert s.network_mode == "disabled"
        assert s.default_deny_network is True
        assert s.block_metadata_ips is True

    def test_unrestricted_allows_network_commands(self):
        s = Settings(
            network_mode="unrestricted",
            database_url="sqlite:////tmp/net-open.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        assert s.network_mode == "unrestricted"
        assert s.default_deny_network is False
        # Hard invariant — never disabled
        assert s.block_metadata_ips is True

    def test_allowlist_mode(self):
        s = Settings(
            network_mode="allowlist",
            database_url="sqlite:////tmp/net-allow.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        assert s.default_deny_network is False

    def test_invalid_mode_raises(self):
        with pytest.raises(ValueError, match="NETWORK_MODE"):
            Settings(
                network_mode="sometimes",
                database_url="sqlite:////tmp/net-bad.db",
                allowed_client_cidrs=["127.0.0.1/32"],
            )

    def test_policy_profile_defaults_strict(self):
        s = Settings(
            database_url="sqlite:////tmp/profile-default.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        assert s.policy_profile == "strict"

    def test_invalid_policy_profile_fails_validation(self):
        with pytest.raises(ValueError, match="SANDBOX_POLICY_PROFILE"):
            Settings(
                policy_profile="permissive",
                database_url="sqlite:////tmp/profile-invalid-name.db",
                allowed_client_cidrs=["127.0.0.1/32"],
            )

    def test_balanced_policy_is_valid_only_with_required_bubblewrap(self):
        s = Settings(
            policy_profile="balanced",
            isolation_backend="bubblewrap",
            isolation_required=True,
            database_url="sqlite:////tmp/profile-balanced.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        assert s.policy_profile == "balanced"

    def test_balanced_policy_fails_production_validation(self):
        s = Settings(**_production_kwargs(
            policy_profile="balanced",
            isolation_backend="bubblewrap",
            isolation_required=True,
        ))
        with pytest.raises(ProductionConfigError, match="POLICY_PROFILE"):
            validate_production_settings(s)


class TestProductionUnsafeMatrix:
    def test_safe_production_config_passes(self):
        s = Settings(**_production_kwargs())
        validate_production_settings(s)  # no raise

    def test_empty_api_token_fails(self):
        s = Settings(**_production_kwargs(api_token=""))
        with pytest.raises(ProductionConfigError, match="SANDBOX_API_TOKEN"):
            validate_production_settings(s)

    def test_unrestricted_network_fails(self):
        s = Settings(**_production_kwargs(network_mode="unrestricted"))
        with pytest.raises(ProductionConfigError, match="unrestricted"):
            validate_production_settings(s)

    def test_wildcard_cors_with_credentials_fails(self):
        s = Settings(
            **_production_kwargs(
                cors_origins=["*"],
                cors_allow_credentials=True,
            )
        )
        with pytest.raises(ProductionConfigError, match="wildcard|CORS"):
            validate_production_settings(s)

    def test_wildcard_cors_without_credentials_still_fails(self):
        s = Settings(
            **_production_kwargs(
                cors_origins=["*"],
                cors_allow_credentials=False,
            )
        )
        with pytest.raises(ProductionConfigError, match="wildcard|CORS"):
            validate_production_settings(s)

    def test_auth_disabled_fails(self):
        s = Settings(**_production_kwargs(auth_enabled=False))
        with pytest.raises(ProductionConfigError, match="AUTH_ENABLED"):
            validate_production_settings(s)

    def test_weak_jwt_secret_fails(self):
        s = Settings(**_production_kwargs(jwt_secret="change-me"))
        with pytest.raises(ProductionConfigError, match="JWT_SECRET"):
            validate_production_settings(s)

    def test_short_jwt_secret_fails(self):
        s = Settings(**_production_kwargs(jwt_secret="short-but-not-weak-xxx"))
        with pytest.raises(ProductionConfigError, match="JWT_SECRET"):
            validate_production_settings(s)

    def test_public_register_fails(self):
        s = Settings(**_production_kwargs(auth_allow_public_register=True))
        with pytest.raises(ProductionConfigError, match="PUBLIC_REGISTER"):
            validate_production_settings(s)

    def test_debug_fails(self):
        s = Settings(**_production_kwargs(debug=True))
        with pytest.raises(ProductionConfigError, match="DEBUG"):
            validate_production_settings(s)

    def test_development_skips_matrix(self):
        s = Settings(
            deployment_env="development",
            api_token="",
            network_mode="unrestricted",
            cors_origins=["*"],
            auth_enabled=False,
            auth_allow_public_register=True,
            database_url="sqlite:////tmp/dev-ok.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        validate_production_settings(s)  # no raise


class TestEffectiveConfigRedaction:
    def test_redacts_tokens_secrets_and_dsn(self):
        s = Settings(
            **_production_kwargs(
                api_token=_strong_secret("tok"),
                jwt_secret=_strong_secret("jwt"),
                database_url="postgresql://user:supersecret@db:5432/sandbox",
            )
        )
        snap = effective_config(s)
        assert snap["api_token"] == "***"
        assert snap["jwt_secret"] == "***"
        assert "supersecret" not in str(snap)
        assert "user:" not in str(snap.get("database_url", ""))
        assert snap["database_url"].startswith("postgresql://")
        assert "***" in snap["database_url"]
        # Non-secret fields preserved
        assert snap["deployment_env"] == "production"
        assert snap["network_mode"] == "disabled"
        assert snap["block_metadata_ips"] is True

    def test_sqlite_dsn_redacted(self):
        s = Settings(
            deployment_env="development",
            database_url="sqlite:////var/sandbox/data/sandbox.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        snap = effective_config(s)
        assert snap["database_url"] == "sqlite:///<redacted>"
        assert "/var/sandbox" not in snap["database_url"]

class TestEnvCatalogConsistency:
    """Catalog surface matches .env.example (no secrets committed)."""

    def test_env_example_documents_core_vars(self):
        text = ENV_EXAMPLE.read_text()
        required = [
            "DEPLOYMENT_ENV=",
            "SANDBOX_NETWORK_MODE=",
            "SANDBOX_POLICY_PROFILE",
            "SANDBOX_API_TOKEN=",
            "AGENT_INTERNAL_TOKEN",
            "SKILLS_MODE=",
            "AGENT_SYSTEM_PROMPT",
            "SANDBOX_CORS_ORIGINS",
            "SANDBOX_AUTH_ENABLED",
            "SANDBOX_JWT_SECRET",
            "SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER",
            "MODEL_CONTEXT_WINDOW",
            "MODEL_MAX_TOKENS",
            "LLMIO_BASE_URL=",
            "POSTGRES_PASSWORD",
        ]
        for var in required:
            assert var in text, f"missing {var} in .env.example"

    def test_env_example_has_no_real_secrets(self):
        text = ENV_EXAMPLE.read_text()
        # No long random hex secrets (allow sk-… placeholder)
        assert not re.search(r"(?i)api_token=\s*[a-f0-9]{32,}", text)
        assert "BEGIN PRIVATE KEY" not in text
        # Password lines should be commented or empty placeholders
        for line in text.splitlines():
            if "PASSWORD=" in line and not line.strip().startswith("#"):
                _, _, val = line.partition("=")
                assert val.strip() in ("", "replace-with-a-strong-secret") or val.startswith(
                    "replace"
                )

    def test_prod_compose_requires_secrets_and_hides_ports(self):
        text = COMPOSE_PROD.read_text()
        assert "SANDBOX_API_TOKEN:?Set" in text
        assert "AGENT_INTERNAL_TOKEN:?Set" in text
        assert "SANDBOX_JWT_SECRET:?Set" in text
        assert "POSTGRES_PASSWORD:?Set" in text
        assert "DEPLOYMENT_ENV: production" in text
        assert "SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER: \"false\"" in text
        assert "SANDBOX_POLICY_PROFILE: strict" in text
        assert "SANDBOX_ISOLATION_BACKEND: bubblewrap" in text
        assert 'SANDBOX_ISOLATION_REQUIRED: "true"' in text
        agent_start = text.index("\n  agent:\n")
        agent_block = text[agent_start:]
        api_start = text.index("\n  api-server:\n")
        api_block = text[api_start:agent_start]
        assert "SANDBOX_POLICY_PROFILE: strict" in agent_block
        assert "SANDBOX_ISOLATION_BACKEND: bubblewrap" in agent_block
        assert "SANDBOX_POLICY_PROFILE" not in api_block
        # Agent + api-server + sandbox must not publish host ports
        assert text.count("ports: []") >= 3

    def test_dev_compose_passes_network_mode(self):
        text = COMPOSE.read_text()
        assert "SANDBOX_NETWORK_MODE:" in text
        assert "DEPLOYMENT_ENV:" in text


class TestPublicRegisterGate:
    def test_register_disabled_when_flag_false(self, monkeypatch):
        from fastapi.testclient import TestClient

        from sandbox.config import settings
        from sandbox.main import app

        monkeypatch.setattr(settings, "auth_allow_public_register", False)
        client = TestClient(app)
        resp = client.post(
            "/auth/register",
            json={"username": "blocked_user", "password": "secret123"},
        )
        assert resp.status_code == 403
        assert "disabled" in resp.json()["detail"].lower()
