"""R6: Env catalog, production unsafe matrix, effective-config redaction."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from sandbox.config import (
    ProductionConfigError,
    Settings,
    effective_config,
    is_legacy_test_database_url,
    is_mysql_database_url,
    validate_production_settings,
)

ROOT = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = ROOT / ".env.example"
COMPOSE_PROD = ROOT / "docker-compose.prod.yml"
COMPOSE = ROOT / "docker-compose.yml"


def _strong_secret(seed: str = "a") -> str:
    # 64 hex-like chars, no weak markers
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
        # Production requires MySQL; never use sqlite/postgres as prod DSN.
        "database_url": "mysql+pymysql://sandbox@mysql:3306/sandbox",
        "allowed_client_cidrs": ["127.0.0.1/32"],
        "trusted_proxy_cidrs": [],
        # Production requires explicit internal plane (independent replay Redis).
        "internal_plane_enabled": True,
        "internal_redis_url": "redis://:prod_replay_only_secret@sandbox-replay-redis:6379/0",
        "internal_hmac_keyring": kr,
        "internal_hmac_active_kid": kid,
        "internal_drain_timeout_seconds": 30.0,
        # Positive default quotas require monitoring + operator hard-backend assert.
        "workspace_child_quota_enforcement": True,
        "workspace_quota_hard_backend_asserted": True,
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

    def test_invalid_approval_mode_raises(self):
        with pytest.raises(ValueError, match="APPROVAL_MODE"):
            Settings(
                approval_mode="sometimes",
                database_url="sqlite:////tmp/approval-mode-bad.db",
                allowed_client_cidrs=["127.0.0.1/32"],
            )

    def test_invalid_legacy_approval_enabled_raises(self):
        with pytest.raises(ValueError, match="APPROVAL_ENABLED"):
            Settings(
                approval_enabled="sometimes",
                database_url="sqlite:////tmp/approval-enabled-bad.db",
                allowed_client_cidrs=["127.0.0.1/32"],
            )

    def test_legacy_false_maps_to_deny_without_mode(self):
        s = Settings(
            approval_enabled=False,
            database_url="sqlite:////tmp/approval-legacy-false.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        assert s.approval_mode == "deny"
        assert s.approval_enabled is False


class TestProductionUnsafeMatrix:
    def test_safe_production_config_passes(self):
        s = Settings(**_production_kwargs())
        validate_production_settings(s)  # no raise

    @pytest.mark.parametrize("approval_mode", ["ask", "deny"])
    def test_safe_approval_modes_pass(self, approval_mode):
        s = Settings(**_production_kwargs(approval_mode=approval_mode))
        validate_production_settings(s)

    def test_auto_approve_fails(self):
        s = Settings(**_production_kwargs(approval_mode="auto_approve"))
        with pytest.raises(ProductionConfigError, match="auto_approve"):
            validate_production_settings(s)

    def test_empty_api_token_fails(self):
        s = Settings(**_production_kwargs(api_token=""))
        with pytest.raises(ProductionConfigError, match="SANDBOX_API_TOKEN"):
            validate_production_settings(s)

    def test_unrestricted_network_fails(self):
        s = Settings(**_production_kwargs(network_mode="unrestricted"))
        with pytest.raises(ProductionConfigError, match="unrestricted"):
            validate_production_settings(s)

    def test_allowlist_network_fails_without_egress_proxy(self):
        """Production must not treat port/CIDR allowlist as isolation."""
        s = Settings(**_production_kwargs(network_mode="allowlist"))
        with pytest.raises(ProductionConfigError, match="allowlist"):
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

    def test_sqlite_database_url_fails_in_production(self):
        s = Settings(**_production_kwargs(database_url="sqlite:////tmp/prod-forbidden.db"))
        with pytest.raises(ProductionConfigError, match="MySQL|SANDBOX_DATABASE_URL"):
            validate_production_settings(s)

    def test_postgres_database_url_fails_in_production(self):
        s = Settings(
            **_production_kwargs(
                database_url="postgresql://sandbox@postgres:5432/sandbox",
            )
        )
        with pytest.raises(ProductionConfigError, match="MySQL|SANDBOX_DATABASE_URL"):
            validate_production_settings(s)

    def test_mysql_database_url_passes_in_production(self):
        s = Settings(
            **_production_kwargs(
                database_url="mysql+pymysql://app@mysql:3306/sandbox",
            )
        )
        validate_production_settings(s)
        assert is_mysql_database_url(s.database_url)

    def test_development_skips_matrix(self):
        s = Settings(
            deployment_env="development",
            api_token="",
            network_mode="unrestricted",
            cors_origins=["*"],
            auth_enabled=False,
            auth_allow_public_register=True,
            # TEMPORARY GAP: unit tests may still inject sqlite outside production.
            database_url="sqlite:////tmp/dev-ok.db",
            allowed_client_cidrs=["127.0.0.1/32"],
        )
        validate_production_settings(s)  # no raise
        assert is_legacy_test_database_url(s.database_url)

    def test_process_timeout_zero_fails_production(self):
        s = Settings(**_production_kwargs(process_timeout_seconds=0))
        with pytest.raises(ProductionConfigError, match="PROCESS_TIMEOUT"):
            validate_production_settings(s)

    def test_process_timeout_above_max_fails_production(self):
        s = Settings(
            **_production_kwargs(
                process_timeout_seconds=100,
                max_process_timeout_seconds=50,
            )
        )
        with pytest.raises(ProductionConfigError, match="PROCESS_TIMEOUT"):
            validate_production_settings(s)

    def test_managed_process_quota_zero_fails_production(self):
        s = Settings(**_production_kwargs(max_managed_processes=0))
        with pytest.raises(ProductionConfigError, match="MAX_MANAGED_PROCESSES"):
            validate_production_settings(s)

    def test_terminal_retention_zero_fails_production(self):
        s = Settings(**_production_kwargs(max_retained_terminal_processes=0))
        with pytest.raises(
            ProductionConfigError, match="RETAINED_TERMINAL_PROCESSES"
        ):
            validate_production_settings(s)

    def test_resource_limit_zero_fails_production(self):
        """0 means unlimited rlimit — forbidden in production (fail closed)."""
        s = Settings(**_production_kwargs(max_memory_mb=0))
        with pytest.raises(ProductionConfigError, match="MAX_MEMORY_MB"):
            validate_production_settings(s)

    def test_max_open_files_zero_fails_production(self):
        s = Settings(**_production_kwargs(max_open_files=0))
        with pytest.raises(ProductionConfigError, match="MAX_OPEN_FILES"):
            validate_production_settings(s)

    def test_max_file_size_zero_fails_production(self):
        s = Settings(**_production_kwargs(max_file_size_mb=0))
        with pytest.raises(ProductionConfigError, match="MAX_FILE_SIZE_MB"):
            validate_production_settings(s)

    def test_max_process_count_zero_fails_production(self):
        s = Settings(**_production_kwargs(max_process_count=0))
        with pytest.raises(ProductionConfigError, match="MAX_PROCESS_COUNT"):
            validate_production_settings(s)

    def test_resource_limit_above_safe_range_fails_production(self):
        s = Settings(**_production_kwargs(max_open_files=200_000))
        with pytest.raises(ProductionConfigError, match="MAX_OPEN_FILES"):
            validate_production_settings(s)

    def test_resource_limit_illegal_config_rejected_at_settings(self):
        """Hard misconfiguration (negative / over absolute max) fails at parse."""
        with pytest.raises(ValueError, match="MAX_MEMORY_MB"):
            Settings(
                max_memory_mb=-1,
                database_url="sqlite:////tmp/bad-mem.db",
                allowed_client_cidrs=["127.0.0.1/32"],
            )
        with pytest.raises(ValueError, match="MAX_OPEN_FILES"):
            Settings(
                max_open_files=9_999_999,
                database_url="sqlite:////tmp/bad-nofile.db",
                allowed_client_cidrs=["127.0.0.1/32"],
            )

    def test_default_resource_limits_pass_production(self):
        # Explicit resource knobs so host .env cannot skew the matrix.
        s = Settings(
            **_production_kwargs(
                max_open_files=256,
                max_file_size_mb=50,
                max_process_count=20,
                max_memory_mb=512,
                max_cpu_time_seconds=300,
                max_output_chars=50_000,
                execution_timeout_seconds=120,
            )
        )
        validate_production_settings(s)
        assert s.max_open_files == 256
        assert s.max_file_size_mb == 50
        assert s.max_process_count == 20
        assert s.max_memory_mb == 512

    def test_production_linux_missing_primitive_fails(self, monkeypatch):
        from sandbox.utils.resource_limits import ResourceLimitError

        def _boom(platform=None):
            raise ResourceLimitError(
                "production Linux missing critical resource primitives: RLIMIT_FSIZE"
            )

        monkeypatch.setattr(
            "sandbox.utils.resource_limits.assert_production_resource_primitives",
            _boom,
        )
        s = Settings(**_production_kwargs())
        with pytest.raises(ProductionConfigError, match="RLIMIT_FSIZE|resource"):
            validate_production_settings(s)


class TestEffectiveConfigRedaction:
    def test_redacts_tokens_secrets_and_dsn(self):
        s = Settings(
            **_production_kwargs(
                api_token=_strong_secret("tok"),
                jwt_secret=_strong_secret("jwt"),
                database_url="mysql+pymysql://user:supersecret@db:3306/sandbox",
            )
        )
        snap = effective_config(s)
        assert snap["api_token"] == "***"
        assert snap["jwt_secret"] == "***"
        assert "supersecret" not in str(snap)
        assert "user:" not in str(snap.get("database_url", ""))
        assert snap["database_url"].startswith("mysql+pymysql://")
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
            "MYSQL_PASSWORD",
            "MYSQL_ROOT_PASSWORD",
            "AGENT_DATABASE_URL=",
            "SANDBOX_DATABASE_URL=",
            "REDIS_PASSWORD=",
            "REDIS_URL=",
            "AGENT_REDIS_URL=",
            "TEST_REDIS_URL",
            "AGENT_RUNS_QUEUE_NAME=",
            "AGENT_RUN_LEASE_TTL_MS=",
            "AGENT_RUN_STREAM_MAXLEN=",
        ]
        for var in required:
            assert var in text, f"missing {var} in .env.example"
        assert "POSTGRES_PASSWORD" not in text
        assert "sqlite:////sandbox/data/sandbox.db" not in text

    def test_env_example_has_no_real_secrets(self):
        text = ENV_EXAMPLE.read_text()
        # No long random hex secrets (allow sk-… placeholder)
        assert not re.search(r"(?i)api_token=\s*[a-f0-9]{32,}", text)
        assert "BEGIN PRIVATE KEY" not in text
        # Password lines: empty, replace-*, or explicit local-only placeholders
        allowed_password_values = {
            "",
            "replace-with-a-strong-secret",
            "sandbox_dev_only",
            "sandbox_root_dev_only",
        }
        for line in text.splitlines():
            if "PASSWORD=" in line and not line.strip().startswith("#"):
                _, _, val = line.partition("=")
                value = val.strip()
                assert (
                    value in allowed_password_values
                    or value.startswith("replace")
                    or value.endswith("_dev_only")
                ), f"unexpected password placeholder: {line!r}"

    def test_prod_compose_requires_secrets_and_hides_ports(self):
        text = COMPOSE_PROD.read_text()
        assert "SANDBOX_API_TOKEN:?Set" in text
        assert "AGENT_INTERNAL_TOKEN:?Set" in text
        assert "SANDBOX_JWT_SECRET:?Set" in text
        assert "MYSQL_PASSWORD:?Set" in text
        assert "MYSQL_ROOT_PASSWORD:?Set" in text
        assert "REDIS_PASSWORD:?Set REDIS_PASSWORD for production" in text
        assert "image: mysql:8.0" in text
        assert "image: redis:7.2" in text
        assert "mysql+pymysql://" in text
        assert "AGENT_DATABASE_URL:" in text
        assert "AGENT_REDIS_URL:" in text
        assert "POSTGRES_PASSWORD" not in text
        assert "image: postgres" not in text
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
        assert "AGENT_DATABASE_URL:" in agent_block
        assert "AGENT_REDIS_URL:" in agent_block
        assert "REDIS_URL:" in agent_block
        assert "redis:" in agent_block
        assert "SANDBOX_POLICY_PROFILE" not in api_block
        assert "AGENT_REDIS_URL" not in api_block
        assert "REDIS_URL" not in api_block
        # Internal services must !reset base publishes (plain ports: [] is unsafe).
        assert text.count("ports: !reset []") >= 6
        assert not re.search(r"^\s+ports:\s*\[\s*\]\s*$", text, re.M)

    def test_dev_compose_passes_network_mode(self):
        text = COMPOSE.read_text()
        assert "SANDBOX_NETWORK_MODE:" in text
        assert "DEPLOYMENT_ENV:" in text
        assert "image: redis:7.2" in text
        assert "AGENT_REDIS_URL:" in text


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
