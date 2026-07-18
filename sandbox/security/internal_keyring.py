"""Strict parsing of the Sandbox internal HMAC keyring configuration.

Mirrors the Agent-side keyring contract (canonical unpadded base64url values,
1..32 kids, 32..4096-byte keys, required active kid).  Fail closed: invalid
input raises :class:`InternalKeyringError` and is never silently repaired.
"""

from __future__ import annotations

import base64
import hmac
import json
import re
from collections.abc import Mapping
from typing import Any

MAX_KID_LENGTH = 128
MAX_KEYRING_KEYS = 32
MIN_KEY_BYTES = 32
MAX_KEY_BYTES = 4096
MAX_KEYRING_JSON_BYTES = 64 * 1024

_BASE64URL_RE = re.compile(r"^[A-Za-z0-9_-]+$")
_KID_RE = re.compile(r"^[A-Za-z0-9._-]+$")


class InternalKeyringError(ValueError):
    """Configuration-time keyring failure (never include secrets in ``message``)."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _fail(code: str, message: str) -> None:
    raise InternalKeyringError(code, message)


def decode_canonical_base64url(value: str, *, field: str) -> bytes:
    """Decode unpadded canonical base64url; reject non-canonical encodings."""
    if (
        type(value) is not str
        or not value
        or not _BASE64URL_RE.fullmatch(value)
        or len(value) % 4 == 1
    ):
        _fail(
            "INTERNAL_TOKEN_KEYRING_INVALID",
            f"{field} must be canonical unpadded base64url",
        )
    try:
        raw = base64.b64decode(
            value + ("=" * (-len(value) % 4)),
            altchars=b"-_",
            validate=True,
        )
    except (ValueError, TypeError):
        _fail(
            "INTERNAL_TOKEN_KEYRING_INVALID",
            f"{field} must be canonical unpadded base64url",
        )
    canonical = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    if not hmac.compare_digest(canonical, value):
        _fail(
            "INTERNAL_TOKEN_KEYRING_INVALID",
            f"{field} must be canonical unpadded base64url",
        )
    return raw


def _strict_string_object(pairs: list[tuple[str, Any]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in pairs:
        if key in out:
            _fail(
                "INTERNAL_TOKEN_KEYRING_INVALID",
                f"duplicate keyring kid: {key}",
            )
        if type(key) is not str or type(value) is not str:
            _fail(
                "INTERNAL_TOKEN_KEYRING_INVALID",
                "keyring JSON keys and values must be strings",
            )
        out[key] = value
    return out


def _parse_keyring_object(object_value: Mapping[str, Any]) -> dict[str, bytes]:
    if not isinstance(object_value, Mapping):
        _fail(
            "INTERNAL_TOKEN_KEYRING_INVALID",
            "keyring must be an object or JSON object string",
        )
    entries = list(object_value.items())
    if not entries or len(entries) > MAX_KEYRING_KEYS:
        _fail(
            "INTERNAL_TOKEN_KEYRING_INVALID",
            f"keyring must contain 1..{MAX_KEYRING_KEYS} keys",
        )
    decoded: dict[str, bytes] = {}
    for kid, encoded in entries:
        if (
            type(kid) is not str
            or not kid
            or len(kid) > MAX_KID_LENGTH
            or not _KID_RE.fullmatch(kid)
        ):
            _fail(
                "INTERNAL_TOKEN_KEYRING_INVALID",
                f"kid must match {_KID_RE.pattern} and be at most "
                f"{MAX_KID_LENGTH} characters",
            )
        if type(encoded) is not str:
            _fail(
                "INTERNAL_TOKEN_KEYRING_INVALID",
                "keyring JSON keys and values must be strings",
            )
        key = decode_canonical_base64url(encoded, field=f"keyring.{kid}")
        if len(key) < MIN_KEY_BYTES or len(key) > MAX_KEY_BYTES:
            _fail(
                "INTERNAL_TOKEN_KEYRING_INVALID",
                f"keyring.{kid} must decode to {MIN_KEY_BYTES}..{MAX_KEY_BYTES} bytes",
            )
        decoded[kid] = key
    return decoded


def parse_internal_hmac_keyring(value: str | Mapping[str, Any]) -> dict[str, bytes]:
    """Parse ``kid -> key bytes`` from a JSON object string or mapping."""
    if isinstance(value, Mapping):
        return _parse_keyring_object(value)
    if type(value) is not str:
        _fail(
            "INTERNAL_TOKEN_KEYRING_INVALID",
            "keyring must be an object or JSON object string",
        )
    text = value
    if len(text.encode("utf-8")) > MAX_KEYRING_JSON_BYTES:
        _fail("INTERNAL_TOKEN_KEYRING_INVALID", "keyring JSON is too large")
    try:
        loaded = json.loads(text, object_pairs_hook=_strict_string_object)
    except InternalKeyringError:
        raise
    except (json.JSONDecodeError, TypeError, ValueError, UnicodeEncodeError):
        _fail("INTERNAL_TOKEN_KEYRING_INVALID", "invalid keyring JSON object")
    if type(loaded) is not dict:
        _fail("INTERNAL_TOKEN_KEYRING_INVALID", "keyring JSON must be an object")
    return _parse_keyring_object(loaded)


def validate_active_kid(keys: Mapping[str, bytes], active_kid: str) -> str:
    """Ensure ``active_kid`` identifies an entry in the already-parsed keyring."""
    if (
        type(active_kid) is not str
        or not active_kid
        or len(active_kid) > MAX_KID_LENGTH
        or not _KID_RE.fullmatch(active_kid)
    ):
        _fail(
            "INTERNAL_TOKEN_ACTIVE_KID_UNKNOWN",
            "activeKid must identify an existing keyring entry",
        )
    if active_kid not in keys:
        _fail(
            "INTERNAL_TOKEN_ACTIVE_KID_UNKNOWN",
            "activeKid must identify an existing keyring entry",
        )
    return active_kid


__all__ = [
    "MAX_KEY_BYTES",
    "MAX_KEYRING_JSON_BYTES",
    "MAX_KEYRING_KEYS",
    "MAX_KID_LENGTH",
    "MIN_KEY_BYTES",
    "InternalKeyringError",
    "decode_canonical_base64url",
    "parse_internal_hmac_keyring",
    "validate_active_kid",
]
