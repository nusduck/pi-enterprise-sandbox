"""HTTP client for the facade's private, narrow Sandbox bridge."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from sandbox.mcp.settings import McpSettings

# Bridge ControlPlaneError codes → safe, operator/LLM-visible messages.
# Keep this list closed: never forward raw exception text from the bridge.
_BRIDGE_ERROR_MESSAGES: dict[str, str] = {
    "FILE_NOT_FOUND": (
        "Workspace file not found for artifact submit. "
        "Use the same context_id as the write/execute call, and a relative source_path "
        "that exists in that workspace."
    ),
    "TOO_LARGE": "File exceeds MCP max size for artifact submit",
    "ARTIFACT_EXISTS": "Artifact already exists",
    "NOT_REGULAR_FILE": "Artifact source must be a regular file",
    "SYMLINK_REJECTED": "Symlinks are not allowed as artifact sources",
    "PATH_INVALID": "Invalid artifact source_path",
    "SOURCE_OPEN_FAILED": "Unable to open artifact source file",
    "SIZE_MISMATCH": "Artifact snapshot failed integrity check",
}


class SandboxBridgeError(RuntimeError):
    """A safe error from the bridge; upstream transport details stay private."""

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        self.code = code


def _safe_bridge_error(response: httpx.Response) -> SandboxBridgeError:
    """Map bridge HTTP failures to stable, non-leaky client messages.

    Historically every 4xx/5xx became \"Sandbox rejected the request\", which
    low-code clients (Dify etc.) surface as an opaque internal error—especially
    when context_id mismatched or source_path was missing after a successful write.
    """
    if response.status_code == 503:
        return SandboxBridgeError("Sandbox is temporarily unavailable", code="UNAVAILABLE")

    code: str | None = None
    message: str | None = None
    try:
        body = response.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        detail = body.get("detail")
        if isinstance(detail, dict):
            raw_code = detail.get("code")
            raw_message = detail.get("message")
            if isinstance(raw_code, str) and raw_code in _BRIDGE_ERROR_MESSAGES:
                code = raw_code
                message = _BRIDGE_ERROR_MESSAGES[raw_code]
            elif isinstance(raw_code, str) and raw_code.isascii() and raw_code.isupper() and len(raw_code) <= 64:
                # Unknown but well-formed control-plane code: keep code, generic text.
                code = raw_code
                message = "Sandbox rejected the request"
            elif isinstance(raw_message, str) and raw_message in _BRIDGE_ERROR_MESSAGES.values():
                message = raw_message
        elif isinstance(detail, str) and detail in {
            "Invalid request",
            "Sandbox operation failed",
        }:
            message = detail

    if message is None:
        if response.status_code == 404:
            message = _BRIDGE_ERROR_MESSAGES["FILE_NOT_FOUND"]
            code = code or "FILE_NOT_FOUND"
        elif response.status_code == 413:
            message = _BRIDGE_ERROR_MESSAGES["TOO_LARGE"]
            code = code or "TOO_LARGE"
        elif response.status_code == 400:
            message = "Invalid request"
        else:
            message = "Sandbox rejected the request"

    return SandboxBridgeError(message, code=code)


class SandboxBridgeClient:
    def __init__(self, settings: McpSettings, client: httpx.AsyncClient | None = None) -> None:
        self._settings = settings
        self._client = client
        self._owns_client = client is None

    async def start(self) -> None:
        if self._client is None:
            self._client = httpx.AsyncClient(
                base_url=self._settings.sandbox_base_url.rstrip("/"), timeout=310.0
            )

    async def close(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
        self._client = None

    @property
    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._settings.internal_token}"}

    async def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if self._client is None:
            raise SandboxBridgeError("Sandbox bridge is unavailable")
        try:
            response = await self._client.post(path, json=payload, headers=self._headers)
        except httpx.HTTPError as exc:
            raise SandboxBridgeError("Sandbox bridge is unavailable") from exc
        if response.status_code >= 400:
            raise _safe_bridge_error(response)
        try:
            data = response.json()
        except ValueError as exc:
            raise SandboxBridgeError("Sandbox returned an invalid response") from exc
        if not isinstance(data, dict):
            raise SandboxBridgeError("Sandbox returned an invalid response")
        return data

    @asynccontextmanager
    async def artifact_stream(self, artifact_id: str) -> AsyncIterator[httpx.Response]:
        if self._client is None:
            raise SandboxBridgeError("Sandbox bridge is unavailable")
        try:
            async with self._client.stream(
                "GET",
                f"/internal/mcp/v1/artifacts/{artifact_id}/content",
                headers=self._headers,
            ) as response:
                if response.status_code >= 400:
                    raise SandboxBridgeError("Artifact is unavailable")
                yield response
        except SandboxBridgeError:
            raise
        except httpx.HTTPError as exc:
            raise SandboxBridgeError("Artifact is unavailable") from exc


__all__ = ["SandboxBridgeClient", "SandboxBridgeError"]
