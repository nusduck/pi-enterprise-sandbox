"""Offline config semantics for Sandbox internal-replay Redis isolation."""

from __future__ import annotations

import pytest

from sandbox.config import Settings, validate_internal_plane_config
from sandbox.security.replay_redis_config import (
    REPLAY_FIXED_DB,
    REPLAY_KEY_PATTERN,
    assert_replay_redis_isolation,
    parse_redis_authority,
    replay_acl_policy_document,
)


def _settings(**overrides):
    import base64
    import json

    key = base64.urlsafe_b64encode(b"k" * 32).decode("ascii").rstrip("=")
    base = {
        "deployment_env": "development",
        "database_url": "mysql+pymysql://u@h:3306/db",
        "allowed_client_cidrs": ["127.0.0.1/32"],
        "internal_plane_enabled": True,
        "internal_redis_url": "redis://:replay_secret@sandbox-replay-redis:6379/0",
        "internal_hmac_keyring": json.dumps({"kid-1": key}),
        "internal_hmac_active_kid": "kid-1",
        "internal_drain_timeout_seconds": 5.0,
    }
    base.update(overrides)
    return Settings(**base)


class TestParseAndPolicy:
    def test_fixed_db_and_key_pattern(self):
        v = parse_redis_authority(
            "redis://:pw@sandbox-replay-redis:6379/0"
        )
        assert v.db == REPLAY_FIXED_DB
        assert v.has_password is True
        doc = replay_acl_policy_document()
        assert doc["key_pattern"] == REPLAY_KEY_PATTERN
        assert "SET" in doc["commands"]
        assert "PING" in doc["commands"]
        assert "SELECT" not in doc["commands"]

    def test_rejects_nonzero_db_as_isolation(self):
        with pytest.raises(ValueError, match="database index|not isolation"):
            assert_replay_redis_isolation(
                "redis://:same@redis:6379/2",
                agent_redis_password="other",
            )


class TestPasswordIsolation:
    def test_rejects_password_equal_redis_password(self):
        with pytest.raises(ValueError, match="REDIS_PASSWORD|independent"):
            assert_replay_redis_isolation(
                "redis://:shared@sandbox-replay-redis:6379/0",
                agent_redis_password="shared",
            )

    def test_rejects_same_host_user_password_even_if_db_differs(self):
        with pytest.raises(ValueError, match="not isolation|independent"):
            assert_replay_redis_isolation(
                "redis://:shared@redis:6379/0",
                agent_redis_url="redis://:shared@redis:6379/0",
            )

    def test_accepts_dedicated_host_and_password(self):
        view = assert_replay_redis_isolation(
            "redis://:replay_only@sandbox-replay-redis:6379/0",
            agent_redis_url="redis://:agent_secret@redis:6379/0",
            agent_redis_password="agent_secret",
        )
        assert view.host == "sandbox-replay-redis"
        assert view.db == 0

    def test_errors_never_echo_password(self):
        secret = "SuperSecretNeverLogMe"
        with pytest.raises(ValueError) as ei:
            assert_replay_redis_isolation(
                f"redis://:{secret}@redis:6379/0",
                agent_redis_password=secret,
            )
        assert secret not in str(ei.value)


class TestPlaneConfigDrainAndIsolation:
    def test_drain_zero_rejected_when_enabled(self):
        with pytest.raises(ValueError, match="DRAIN_TIMEOUT.*> 0"):
            validate_internal_plane_config(
                _settings(internal_drain_timeout_seconds=0)
            )

    def test_db2_with_agent_password_rejected(self, monkeypatch):
        monkeypatch.setenv("REDIS_PASSWORD", "shared_pw")
        with pytest.raises(ValueError):
            validate_internal_plane_config(
                _settings(
                    internal_redis_url="redis://:shared_pw@redis:6379/2",
                ),
                agent_redis_password="shared_pw",
            )

    def test_dedicated_ok(self, monkeypatch):
        monkeypatch.setenv("REDIS_PASSWORD", "agent_pw")
        monkeypatch.setenv(
            "AGENT_REDIS_URL", "redis://:agent_pw@redis:6379/0"
        )
        validate_internal_plane_config(
            _settings(
                internal_redis_url=(
                    "redis://:replay_pw@sandbox-replay-redis:6379/0"
                ),
            )
        )
