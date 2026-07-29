"""The independently deployable Streamable HTTP MCP application."""

from __future__ import annotations

import json
import secrets
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlparse

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response, StreamingResponse
from starlette.routing import Mount, Route
from starlette.types import ASGIApp, Receive, Scope, Send

from sandbox.mcp.service import McpFacadeError, McpFacadeService
from sandbox.mcp.settings import settings


class McpBearerAuth:
    """Strict fixed bearer check for the MCP endpoint only."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        expected = settings.token.strip()
        values = [
            value
            for name, value in scope.get("headers", [])
            if type(name) is bytes and type(value) is bytes and name.lower() == b"authorization"
        ]
        valid = False
        if expected and len(values) == 1:
            try:
                raw = values[0].decode("ascii")
                token = raw[len("Bearer ") :] if raw.startswith("Bearer ") else ""
                valid = bool(token) and token == token.strip() and not any(c.isspace() for c in token) and secrets.compare_digest(token, expected)
            except UnicodeDecodeError:
                valid = False
        if not valid:
            status = 503 if not expected else 401
            response = JSONResponse(
                {"detail": "MCP service unavailable" if status == 503 else "Invalid or missing MCP authentication"},
                status_code=status,
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)


service = McpFacadeService(settings)


def _transport_security() -> TransportSecuritySettings:
    """Keep MCP's DNS-rebinding guard enabled for local and configured edge hosts."""
    hosts = {"localhost", "localhost:*", "127.0.0.1", "127.0.0.1:*", "sandbox-mcp", "sandbox-mcp:*"}
    origins = {"http://localhost:*", "http://127.0.0.1:*"}
    parsed = urlparse(settings.public_base_url)
    if parsed.scheme in {"http", "https"} and parsed.netloc:
        hosts.add(parsed.netloc)
        origins.add(f"{parsed.scheme}://{parsed.netloc}")
    return TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=sorted(hosts),
        allowed_origins=sorted(origins),
    )


mcp = FastMCP(
    "Enterprise Sandbox",
    instructions="Execute Python and manage files in an isolated persistent Sandbox workspace.",
    stateless_http=True,
    json_response=True,
    max_request_body_size=2 * 1024 * 1024,
    host="0.0.0.0",
    port=8082,
    transport_security=_transport_security(),
)


@mcp.tool(name="sandbox_python_execute", description="Execute Python in the context's isolated persistent workspace.")
async def sandbox_python_execute(
    code: str,
    context_id: str | None = None,
    timeout_seconds: int = 120,
) -> dict[str, Any]:
    return await service.execute_python(
        context_id=context_id, code=code, timeout_seconds=timeout_seconds
    )


@mcp.tool(name="sandbox_file_write", description="Write UTF-8 text to a file in the persistent Sandbox workspace.")
async def sandbox_file_write(
    path: str,
    content: str,
    context_id: str | None = None,
    mode: str = "overwrite",
) -> dict[str, Any]:
    return await service.file_write(
        context_id=context_id, path=path, content=content, mode=mode
    )


@mcp.tool(name="sandbox_file_read", description="Read a text file from the persistent Sandbox workspace.")
async def sandbox_file_read(
    path: str,
    context_id: str | None = None,
    offset: int | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    return await service.file_read(
        context_id=context_id, path=path, offset=offset, limit=limit
    )


@mcp.tool(name="sandbox_file_list", description="List files under a persistent Sandbox workspace path.")
async def sandbox_file_list(
    context_id: str | None = None,
    path: str = ".",
    depth: int = 1,
) -> dict[str, Any]:
    return await service.file_list(context_id=context_id, path=path, depth=depth)


@mcp.tool(name="sandbox_artifact_submit", description="Snapshot a generated workspace file and return a temporary download URL.")
async def sandbox_artifact_submit(
    source_path: str,
    context_id: str | None = None,
    name: str | None = None,
    mime_type: str | None = None,
) -> dict[str, Any]:
    return await service.artifact_submit(
        context_id=context_id,
        source_path=source_path,
        name=name,
        mime_type=mime_type,
    )


async def health(_request: Request) -> Response:
    return JSONResponse({"status": "ok", "service": "sandbox-mcp"})


async def artifact_download(request: Request) -> Response:
    artifact_id = request.path_params["artifact_id"]
    token = request.query_params.get("token", "")
    try:
        metadata = await service.get_artifact(artifact_id, token)
    except McpFacadeError:
        return JSONResponse({"detail": "Artifact unavailable"}, status_code=503)
    if metadata is None:
        return JSONResponse({"detail": "Artifact not found"}, status_code=404)

    async def body():
        try:
            async with service.artifact_stream(artifact_id) as upstream:
                async for chunk in upstream.aiter_bytes():
                    yield chunk
        except McpFacadeError:
            return

    filename = str(metadata.get("name", "artifact"))
    safe_filename = filename.replace('"', "")
    return StreamingResponse(
        body(),
        media_type=str(metadata.get("mime_type", "application/octet-stream")),
        headers={"Content-Disposition": f'attachment; filename="{safe_filename}"'},
    )


mcp_http_app = mcp.streamable_http_app()


@asynccontextmanager
async def lifespan(_app: Starlette):
    await service.start()
    try:
        # Mounted Starlette applications do not own the parent lifespan.
        async with mcp.session_manager.run():
            yield
    finally:
        await service.close()


app = Starlette(
    routes=[
        Route("/health", health, methods=["GET"]),
        Route("/artifacts/{artifact_id}", artifact_download, methods=["GET"]),
        Mount("/", app=McpBearerAuth(mcp_http_app)),
    ],
    lifespan=lifespan,
)

__all__ = ["app", "mcp", "service"]
