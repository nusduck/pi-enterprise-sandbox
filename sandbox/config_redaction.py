"""What configuration is allowed to appear in logs and diagnostics.

Startup logs an effective-config snapshot, and that snapshot must never carry a
token, a password, or a full DSN. Keeping the rules here — rather than inline in
:mod:`sandbox.config` — means the redaction policy can be read and tested as one
thing instead of being spread through a settings surface.

Pure functions only: no I/O, no imports from the rest of the package.
"""

from __future__ import annotations

import re
from typing import Any

#: Substrings that mark a settings *key* as carrying a secret value.
SECRET_KEY_TOKENS: tuple[str, ...] = (
    "token",
    "secret",
    "password",
    "api_key",
    "apikey",
    "authorization",
    "credential",
    "dsn",
    "database_url",
    "redis_url",
    "private",
    "keyring",
    "hmac",
)

#: Schemes whose presence in a *value* implies embedded credentials, even when
#: the key itself looks innocuous.
CREDENTIAL_URL_SCHEMES: tuple[str, ...] = ("postgres", "mysql", "mongodb", "redis")

REDACTED = "***"
EMPTY = "<empty>"
_REDACTED_TAIL = "<redacted>"


def looks_like_secret_key(name: str) -> bool:
    lower = name.lower()
    return any(token in lower for token in SECRET_KEY_TOKENS)


def looks_like_embedded_secret(value: str) -> bool:
    lower = value.lower()
    return "://" in lower and any(p in lower for p in CREDENTIAL_URL_SCHEMES)


def redact_database_url(url: str) -> str:
    """``mysql+pymysql://user:pass@host:port/db`` → scheme + host only."""
    if not url:
        return EMPTY
    m = re.match(
        r"^(?P<scheme>[a-zA-Z0-9+]+)://(?P<creds>[^@]*)@(?P<host>[^/]+)(?:/(?P<db>.*))?$",
        url,
    )
    if m:
        return f"{m.group('scheme')}://{REDACTED}@{m.group('host')}/{_REDACTED_TAIL}"
    m2 = re.match(r"^(?P<scheme>[a-zA-Z0-9+]+)://(?P<rest>.*)$", url)
    if m2:
        return f"{m2.group('scheme')}://{_REDACTED_TAIL}"
    return _REDACTED_TAIL


def redact_redis_url(url: str) -> str:
    if not url:
        return EMPTY
    m = re.match(
        r"^(?P<scheme>rediss?)://(?P<creds>[^@]*)@(?P<host>[^/]+)(?:/(?P<db>.*))?$",
        url,
        flags=re.IGNORECASE,
    )
    if m:
        scheme = m.group("scheme").lower()
        return f"{scheme}://{REDACTED}@{m.group('host')}/{_REDACTED_TAIL}"
    m2 = re.match(r"^(?P<scheme>rediss?)://(?P<rest>.*)$", url, flags=re.IGNORECASE)
    if m2:
        return f"{m2.group('scheme').lower()}://{_REDACTED_TAIL}"
    return _REDACTED_TAIL


def redact_settings_dump(data: dict[str, Any]) -> dict[str, Any]:
    """Redact a ``Settings.model_dump()`` in place of the raw values."""
    redacted: dict[str, Any] = {}
    for key, value in data.items():
        if looks_like_secret_key(key):
            if key == "database_url":
                redacted[key] = redact_database_url(str(value or ""))
            elif key.endswith("redis_url"):
                redacted[key] = redact_redis_url(str(value or ""))
            elif isinstance(value, list):
                redacted[key] = [REDACTED] if value else []
            elif value in (None, "", [], {}):
                redacted[key] = EMPTY
            else:
                redacted[key] = REDACTED
            continue
        if isinstance(value, str) and looks_like_embedded_secret(value):
            redacted[key] = REDACTED
            continue
        redacted[key] = value
    return redacted


__all__ = [
    "CREDENTIAL_URL_SCHEMES",
    "EMPTY",
    "REDACTED",
    "SECRET_KEY_TOKENS",
    "looks_like_embedded_secret",
    "looks_like_secret_key",
    "redact_database_url",
    "redact_redis_url",
    "redact_settings_dump",
]
