"""HTTP client for the facade's private, narrow Sandbox bridge."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any

import httpx

from sandbox.mcp.settings import McpSettings


class SandboxBridgeError(RuntimeError):
    """A safe error from the bridge; upstream transport details stay private."""


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
            if response.status_code == 503:
                raise SandboxBridgeError("Sandbox is temporarily unavailable")
            raise SandboxBridgeError("Sandbox rejected the request")
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
