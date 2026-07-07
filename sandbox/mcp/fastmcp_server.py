"""FastMCP Server for Sandbox — exposes sandbox tools via MCP protocol.

Run as:
    python -m sandbox.mcp.fastmcp_server

Or via uvicorn (SSE transport):
    uvicorn sandbox.mcp.fastmcp_server:mcp_app --port 8091

For Dify/Hi-Agent integration, use SSE transport endpoint.
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Any

from mcp.server.fastmcp import FastMCP

# Ensure sandbox package is importable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(__file__))))

from sandbox.config import settings
from sandbox.mcp.server import mcp_server as adapter

logger = logging.getLogger("sandbox.mcp.fastmcp")

# ── Create MCP server ─────────────────────────────────────────────

mcp_app = FastMCP(
    "Enterprise Sandbox MCP",
    instructions="Enterprise-grade secure execution sandbox MCP server",
    host=settings.mcp_host,
    port=settings.mcp_port,
)


# ── Tool: create_session ──────────────────────────────────────────

@mcp_app.tool()
async def create_session(
    agent_session_id: str | None = None,
    user_id: str | None = None,
    caller_id: str = "mcp",
    metadata: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Create a new sandbox session with an isolated workspace."""
    return await adapter.create_session(
        agent_session_id=agent_session_id,
        user_id=user_id,
        caller_id=caller_id,
        metadata=metadata,
    )


# ── Tool: close_session ───────────────────────────────────────────

@mcp_app.tool()
async def close_session(session_id: str) -> dict[str, Any]:
    """Close a sandbox session and remove its workspace."""
    return await adapter.close_session(session_id=session_id)


# ── Tool: run_python ──────────────────────────────────────────────

@mcp_app.tool()
async def run_python(
    session_id: str,
    code: str,
    timeout: int | None = None,
) -> dict[str, Any]:
    """Execute Python code inside the sandbox workspace."""
    return await adapter.run_python(
        session_id=session_id,
        code=code,
        timeout=timeout,
    )


# ── Tool: run_command_limited ─────────────────────────────────────

@mcp_app.tool()
async def run_command_limited(
    session_id: str,
    command: str,
    timeout: int | None = None,
) -> dict[str, Any]:
    """Run a limited shell command (no sudo, rm -rf, etc.)."""
    return await adapter.run_command_limited(
        session_id=session_id,
        command=command,
        timeout=timeout,
    )


# ── Tool: read_file ───────────────────────────────────────────────

@mcp_app.tool()
async def read_file(
    session_id: str,
    path: str,
    offset: int | None = None,
    limit: int | None = None,
) -> dict[str, Any]:
    """Read file contents from the sandbox workspace."""
    return await adapter.read_file(
        session_id=session_id,
        path=path,
        offset=offset,
        limit=limit,
    )


# ── Tool: write_file ──────────────────────────────────────────────

@mcp_app.tool()
async def write_file(
    session_id: str,
    path: str,
    content: str,
) -> dict[str, Any]:
    """Write content to a file in the sandbox workspace."""
    return await adapter.write_file(
        session_id=session_id,
        path=path,
        content=content,
    )


# ── Tool: preview_file ────────────────────────────────────────────

@mcp_app.tool()
async def preview_file(
    session_id: str,
    path: str,
) -> dict[str, Any]:
    """Preview the first 40 lines of a file."""
    return await adapter.preview_file(
        session_id=session_id,
        path=path,
    )


# ── Tool: list_files ──────────────────────────────────────────────

@mcp_app.tool()
async def list_files(
    session_id: str,
    path: str = ".",
) -> dict[str, Any]:
    """List files in a directory within the sandbox workspace."""
    return await adapter.list_files(
        session_id=session_id,
        path=path,
    )


# ── Tool: download_file ───────────────────────────────────────────

@mcp_app.tool()
async def download_file(
    session_id: str,
    path: str,
) -> dict[str, Any]:
    """Get file info for download from the sandbox workspace."""
    return await adapter.download_file(
        session_id=session_id,
        path=path,
    )


# ── Tool: get_artifacts ───────────────────────────────────────────

@mcp_app.tool()
async def get_artifacts(session_id: str) -> dict[str, Any]:
    """List all artifacts generated in a session."""
    return await adapter.get_artifacts(session_id=session_id)


@mcp_app.tool()
async def submit_artifact(
    session_id: str,
    path: str,
    name: str | None = None,
    mime_type: str | None = None,
) -> dict[str, Any]:
    """Explicitly submit a workspace file as a downloadable artifact.
    Only explicitly submitted files are tracked — no automatic scans."""
    return await adapter.submit_artifact(
        session_id=session_id,
        path=path,
        name=name or path.split("/")[-1],
        mime_type=mime_type or "application/octet-stream",
    )


# ── Main entry point ──────────────────────────────────────────────

if __name__ == "__main__":
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    logger.info(
        "Starting MCP server (SSE) on %s:%s",
        settings.mcp_host,
        settings.mcp_port,
    )
    mcp_app.run(transport="sse")
