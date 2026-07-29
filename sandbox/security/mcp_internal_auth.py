"""Authentication for the narrow ``sandbox-mcp -> Sandbox`` bridge.

This bridge is intentionally not part of the Agent HMAC control plane.  It is
only reachable by the separately deployed ``sandbox-mcp`` service, and accepts
one configured Bearer credential.  Keeping the check here makes it impossible
for an API key or end-user JWT to accidentally authorize direct execution.
"""

from __future__ import annotations

import secrets
from collections.abc import Mapping

from fastapi import HTTPException, Request

from sandbox.config import settings

_AUTH_DETAIL = "Invalid or missing MCP internal authentication"


def _authorization_values(scope: Mapping[object, object]) -> list[bytes]:
    headers = scope.get("headers")
    if not isinstance(headers, (list, tuple)):
        return []
    values: list[bytes] = []
    for entry in headers:
        if not isinstance(entry, (list, tuple)) or len(entry) != 2:
            return []
        name, value = entry
        if type(name) is bytes and type(value) is bytes and name.lower() == b"authorization":
            values.append(value)
    return values


def require_mcp_internal_auth(request: Request) -> None:
    """Require exactly one strict ``Authorization: Bearer <token>`` header."""
    expected = (settings.mcp_internal_token or "").strip()
    if not expected:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")

    values = _authorization_values(request.scope)
    if len(values) != 1:
        raise HTTPException(status_code=401, detail=_AUTH_DETAIL)
    try:
        authorization = values[0].decode("ascii")
    except UnicodeDecodeError:
        raise HTTPException(status_code=401, detail=_AUTH_DETAIL) from None
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail=_AUTH_DETAIL)
    token = authorization[len("Bearer ") :]
    if not token or token != token.strip() or any(char.isspace() for char in token):
        raise HTTPException(status_code=401, detail=_AUTH_DETAIL)
    if not secrets.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail=_AUTH_DETAIL)


__all__ = ["require_mcp_internal_auth"]
