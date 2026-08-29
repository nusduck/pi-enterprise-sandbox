"""Facade business logic: context routing, bridge calls, and artifact URLs."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import mimetypes
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import urlencode

from sandbox.mcp.ulid import new_ulid
from sandbox.mcp.context_store import ContextRecord, ContextStore, ContextStoreError
from sandbox.mcp.sandbox_client import SandboxBridgeClient, SandboxBridgeError
from sandbox.mcp.settings import McpSettings


class McpFacadeError(RuntimeError):
    """Safe message returned through the MCP protocol."""


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


class McpFacadeService:
    def __init__(
        self,
        settings: McpSettings,
        context_store: ContextStore | None = None,
        bridge: SandboxBridgeClient | None = None,
    ) -> None:
        self.settings = settings
        self.context_store = context_store or ContextStore(settings)
        self.bridge = bridge or SandboxBridgeClient(settings)

    async def start(self) -> None:
        self.settings.validate_runtime()
        await self.context_store.start()
        await self.bridge.start()

    async def close(self) -> None:
        await self.bridge.close()
        await self.context_store.close()

    @staticmethod
    def _context_payload(record: ContextRecord) -> dict[str, str]:
        return {
            "sandbox_session_id": record.sandbox_session_id,
            "workspace_id": record.workspace_id,
        }

    async def _resolve(self, context_id: str | None) -> ContextRecord:
        try:
            return await self.context_store.resolve(
                context_id,
                lambda record: self.bridge.post(
                    "/internal/mcp/v1/context/ensure", self._context_payload(record)
                ),
            )
        except (ContextStoreError, SandboxBridgeError) as exc:
            raise McpFacadeError(str(exc)) from exc

    async def _call(
        self,
        path: str,
        context_id: str | None,
        payload: dict[str, Any],
    ) -> tuple[ContextRecord, dict[str, Any]]:
        record = await self._resolve(context_id)
        try:
            data = await self.bridge.post(path, self._context_payload(record) | payload)
            await self.context_store.touch(record)
            return record, data
        except (ContextStoreError, SandboxBridgeError) as exc:
            raise McpFacadeError(str(exc)) from exc

    async def execute_python(
        self, *, context_id: str | None, code: str, timeout_seconds: int = 120
    ) -> dict[str, Any]:
        if len(code) > self.settings.max_code_length:
            raise McpFacadeError("code exceeds MCP size limit")
        if not 1 <= timeout_seconds <= self.settings.max_timeout_seconds:
            raise McpFacadeError("timeout_seconds exceeds MCP limit")
        record, data = await self._call(
            "/internal/mcp/v1/python/execute",
            context_id,
            {"code": code, "timeout_seconds": timeout_seconds},
        )
        return {"context_id": record.context_id, **data}

    async def execute_shell(
        self, *, context_id: str | None, command: str, timeout_seconds: int = 120
    ) -> dict[str, Any]:
        if len(command) > self.settings.max_command_length:
            raise McpFacadeError("command exceeds MCP size limit")
        if not 1 <= timeout_seconds <= self.settings.max_timeout_seconds:
            raise McpFacadeError("timeout_seconds exceeds MCP limit")
        record, data = await self._call(
            "/internal/mcp/v1/shell/execute",
            context_id,
            {"command": command, "timeout_seconds": timeout_seconds},
        )
        return {"context_id": record.context_id, **data}

    async def file_write(
        self,
        *,
        context_id: str | None,
        path: str,
        content: str,
        mode: str = "overwrite",
    ) -> dict[str, Any]:
        if mode not in {"overwrite", "append"}:
            raise McpFacadeError("mode must be overwrite or append")
        if len(content.encode("utf-8")) > self.settings.max_file_size_bytes:
            raise McpFacadeError("content exceeds MCP file size limit")
        record, data = await self._call(
            "/internal/mcp/v1/files/write",
            context_id,
            {"path": path, "content": content, "mode": mode},
        )
        return {"context_id": record.context_id, **data}

    async def file_read(
        self,
        *,
        context_id: str | None,
        path: str,
        offset: int | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        record, data = await self._call(
            "/internal/mcp/v1/files/read",
            context_id,
            {"path": path, "offset": offset, "limit": limit},
        )
        return {"context_id": record.context_id, **data}

    async def file_list(
        self,
        *,
        context_id: str | None,
        path: str = ".",
        depth: int = 1,
    ) -> dict[str, Any]:
        if not 0 <= depth <= 5:
            raise McpFacadeError("depth must be in 0..5")
        record, data = await self._call(
            "/internal/mcp/v1/files/list",
            context_id,
            {"path": path, "depth": depth},
        )
        return {"context_id": record.context_id, **data}

    def _sign_artifact(self, artifact_id: str, expires_at: int) -> str:
        body = _b64(json.dumps({"artifact_id": artifact_id, "exp": expires_at}, separators=(",", ":")).encode())
        signature = hmac.new(
            self.settings.download_secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256
        ).digest()
        return f"{body}.{_b64(signature)}"

    def verify_artifact_token(self, artifact_id: str, token: str) -> bool:
        try:
            body, signature = token.split(".", 1)
            expected = hmac.new(
                self.settings.download_secret.encode("utf-8"), body.encode("ascii"), hashlib.sha256
            ).digest()
            if not hmac.compare_digest(_unb64(signature), expected):
                return False
            payload = json.loads(_unb64(body))
            return (
                isinstance(payload, dict)
                and payload.get("artifact_id") == artifact_id
                and int(payload.get("exp", 0)) >= int(time.time())
            )
        except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
            return False

    async def artifact_submit(
        self,
        *,
        context_id: str | None,
        source_path: str,
        name: str | None = None,
        mime_type: str | None = None,
    ) -> dict[str, Any]:
        artifact_id = new_ulid()
        artifact_name = (name or PurePosixPath(source_path).name).strip()
        if not artifact_name or artifact_name in {".", ".."} or "/" in artifact_name or "\\" in artifact_name:
            raise McpFacadeError("name must be a filename")
        artifact_mime = mime_type or mimetypes.guess_type(artifact_name)[0] or "application/octet-stream"
        record, data = await self._call(
            "/internal/mcp/v1/artifacts/submit",
            context_id,
            {"artifact_id": artifact_id, "source_path": source_path},
        )
        expires_at = int(time.time()) + self.settings.artifact_ttl_seconds
        await self.context_store.put_artifact(
            artifact_id,
            {
                "name": artifact_name,
                "mime_type": artifact_mime,
                "size": int(data["size"]),
                "sha256": str(data["sha256"]),
                "context_id": record.context_id,
            },
        )
        token = self._sign_artifact(artifact_id, expires_at)
        query = urlencode({"token": token})
        root = self.settings.public_base_url.rstrip("/")
        url = f"{root}/artifacts/{artifact_id}?{query}" if root else f"/artifacts/{artifact_id}?{query}"
        return {
            "context_id": record.context_id,
            "artifact_id": artifact_id,
            "name": artifact_name,
            "mime_type": artifact_mime,
            "size": int(data["size"]),
            "sha256": str(data["sha256"]),
            "download_url": url,
            "expires_at": expires_at,
        }

    async def get_artifact(self, artifact_id: str, token: str) -> dict[str, Any] | None:
        if not self.verify_artifact_token(artifact_id, token):
            return None
        try:
            return await self.context_store.get_artifact(artifact_id)
        except ContextStoreError as exc:
            raise McpFacadeError(str(exc)) from exc

    @asynccontextmanager
    async def artifact_stream(self, artifact_id: str) -> AsyncIterator[Any]:
        try:
            async with self.bridge.artifact_stream(artifact_id) as response:
                yield response
        except SandboxBridgeError as exc:
            raise McpFacadeError(str(exc)) from exc


__all__ = ["McpFacadeError", "McpFacadeService"]
