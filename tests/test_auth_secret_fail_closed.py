"""A deployment with auth on must never sign tokens with a default secret.

Reproduction: with ``SANDBOX_AUTH_ENABLED=true`` and no configured secret,
``_secret()`` fell back to the constant ``dev-only-change-me`` compiled into
this repository. Anyone who has read the source could mint a token for any
user id, organization and role — including ``admin`` — and Sandbox would
accept it as a genuine end-user identity.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time

import pytest

from sandbox import auth as auth_module
from sandbox.config import ProductionConfigError, Settings, ensure_safe_to_start


PUBLISHED_FALLBACK = "dev-only-change-me"  # noqa: S105 — the value under test


def _auth_on_without_secret(monkeypatch) -> Settings:
    cfg = Settings(
        database_url="mysql+pymysql://sandbox:pw@mysql:3306/sandbox",
        auth_enabled=True,
        jwt_secret="",
        api_token="",
    )
    monkeypatch.setattr(auth_module, "settings", cfg)
    return cfg


def _forge(secret: str, *, sub: str = "attacker", role: str = "admin") -> str:
    """Mint a token the way an attacker would, knowing only the constant."""
    header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip("=")
    now = int(time.time())
    payload = (
        base64.urlsafe_b64encode(
            json.dumps(
                {
                    "sub": sub,
                    "username": sub,
                    "role": role,
                    "organization_id": "org_bootstrap",
                    "iat": now,
                    "exp": now + 3600,
                    "iss": "pi-enterprise-sandbox",
                    "aud": "pi-enterprise-sandbox",
                },
                separators=(",", ":"),
            ).encode()
        )
        .decode()
        .rstrip("=")
    )
    signing_input = f"{header}.{payload}".encode()
    sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    return f"{header}.{payload}.{base64.urlsafe_b64encode(sig).decode().rstrip('=')}"


def test_forged_token_signed_with_the_published_constant_is_refused(monkeypatch) -> None:
    _auth_on_without_secret(monkeypatch)
    forged = _forge(PUBLISHED_FALLBACK)

    with pytest.raises(auth_module.AuthSecretMissingError):
        auth_module.verify_token(forged)


def test_no_token_can_be_minted_without_a_secret(monkeypatch) -> None:
    _auth_on_without_secret(monkeypatch)

    with pytest.raises(auth_module.AuthSecretMissingError):
        auth_module.create_token("user_1", "alice", role="admin")


def test_startup_refuses_auth_without_a_secret() -> None:
    cfg = Settings(
        database_url="mysql+pymysql://sandbox:pw@mysql:3306/sandbox",
        auth_enabled=True,
        jwt_secret="",
        api_token="",
    )
    with pytest.raises(ProductionConfigError, match="SANDBOX_JWT_SECRET"):
        ensure_safe_to_start(cfg)


def test_auth_off_signs_with_a_per_process_secret(monkeypatch) -> None:
    # Tokens are not a trust boundary with auth off, but the fallback must not
    # be a value an outsider can predict.
    cfg = Settings(
        database_url="mysql+pymysql://sandbox:pw@mysql:3306/sandbox",
        auth_enabled=False,
        jwt_secret="",
        api_token="",
    )
    monkeypatch.setattr(auth_module, "settings", cfg)

    token = auth_module.create_token("user_1", "alice")
    assert auth_module.verify_token(token)["sub"] == "user_1"
    assert auth_module.verify_token(_forge(PUBLISHED_FALLBACK)) is None
