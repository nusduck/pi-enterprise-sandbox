"""JWT + password helpers for optional multi-user auth foundation."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import time
from typing import Any

from sandbox.config import settings


def _secret() -> str:
    # Prefer dedicated JWT secret; fall back to API token; else dev default
    return (
        getattr(settings, "jwt_secret", None)
        or settings.api_token
        or "dev-only-change-me"
    )


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


def create_token(user_id: str, username: str, role: str = "user", ttl_seconds: int = 86400) -> str:
    """Create a compact signed token: base.payload.sig (not full JWT lib dependency)."""
    import base64
    import json

    header = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip("=")
    now = int(time.time())
    payload_obj = {
        "sub": user_id,
        "username": username,
        "role": role,
        "iat": now,
        "exp": now + ttl_seconds,
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
    return payload
