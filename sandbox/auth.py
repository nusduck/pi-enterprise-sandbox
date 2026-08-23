"""JWT + password helpers for optional multi-user auth foundation."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Any

from sandbox.config import settings


class AuthSecretMissingError(RuntimeError):
    """Auth is on but the deployment configured no signing secret."""


# Signing material for a deployment that has auth switched **off**. Tokens are
# not a trust boundary there — nothing checks them — but they are still minted
# and verified by tests and local tooling, so the value has to exist. It is
# random per process rather than a constant: a hardcoded fallback is a public
# signing key, and one left reachable with auth on lets anyone mint a token for
# any user and organization.
_EPHEMERAL_SECRET = secrets.token_hex(32)


def _secret() -> str:
    configured = (getattr(settings, "jwt_secret", None) or "").strip() or (
        settings.api_token or ""
    ).strip()
    if configured:
        return configured
    if getattr(settings, "auth_enabled", False):
        # Fail closed. Production is already refused by
        # validate_production_settings; this covers every other environment,
        # where auth_enabled=true with no secret used to silently sign with a
        # constant published in this file.
        raise AuthSecretMissingError(
            "SANDBOX_JWT_SECRET (or SANDBOX_API_TOKEN) is required when "
            "SANDBOX_AUTH_ENABLED=true; refusing to sign or verify tokens "
            "with a default secret"
        )
    return _EPHEMERAL_SECRET


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000)
    return f"pbkdf2_sha256${salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, salt, digest = stored.split("$", 2)
    except ValueError:
        return False
    if algo != "pbkdf2_sha256":
        return False
    check = hash_password(password, salt=salt)
    return hmac.compare_digest(check, stored)


def create_token(
    user_id: str,
    username: str,
    role: str = "user",
    organization_id: str | None = None,
    ttl_seconds: int = 86400,
) -> str:
    """Create a compact signed token: base.payload.sig (not full JWT lib dependency)."""
    import base64
    import json

    from sandbox.security.ownership import BOOTSTRAP_ORG_ID

    header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip("=")
    now = int(time.time())
    payload_obj = {
        "sub": user_id,
        "username": username,
        "role": role,
        "organization_id": organization_id or BOOTSTRAP_ORG_ID,
        "iat": now,
        "exp": now + ttl_seconds,
        "iss": getattr(settings, "jwt_issuer", None) or "pi-enterprise-sandbox",
        "aud": getattr(settings, "jwt_audience", None) or "pi-enterprise-sandbox",
    }
    payload = base64.urlsafe_b64encode(
        json.dumps(payload_obj, separators=(",", ":")).encode()
    ).decode().rstrip("=")
    signing_input = f"{header}.{payload}".encode()
    sig = hmac.new(_secret().encode(), signing_input, hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).decode().rstrip("=")
    return f"{header}.{payload}.{sig_b64}"


def verify_token(token: str) -> dict[str, Any] | None:
    import base64
    import json

    try:
        header_b64, payload_b64, sig_b64 = token.split(".")
    except ValueError:
        return None

    def pad(s: str) -> bytes:
        return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))

    signing_input = f"{header_b64}.{payload_b64}".encode()
    expected = hmac.new(_secret().encode(), signing_input, hashlib.sha256).digest()
    try:
        got = pad(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(expected, got):
        return None
    try:
        payload = json.loads(pad(payload_b64))
    except Exception:
        return None
    if int(payload.get("exp", 0)) < int(time.time()):
        return None
    # Enforce issuer/audience when configured (production sets both).
    expected_iss = (getattr(settings, "jwt_issuer", None) or "").strip()
    expected_aud = (getattr(settings, "jwt_audience", None) or "").strip()
    if expected_iss and payload.get("iss") not in (None, expected_iss):
        return None
    if expected_aud and payload.get("aud") not in (None, expected_aud):
        return None
    return payload
