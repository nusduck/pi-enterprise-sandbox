"""MCP Router — exposes MCP tools as REST API for external platforms.

This is simpler than running a separate MCP server. It provides:
- GET /mcp/tools  — list available MCP tools with their schemas
- POST /mcp/call  — call an MCP tool

For Dify compatibility, this implements the MCP-over-HTTP pattern.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from sandbox.mcp.server import mcp_server

logger = logging.getLogger("sandbox.mcp.router")
router = APIRouter(prefix="/mcp", tags=["mcp"])


class ToolCallRequest(BaseModel):
    tool_name: str
    caller_id: str = "mcp-client"
    kwargs: dict[str, Any] = {}


@router.get("/tools")
async def list_tools():
    """List all available MCP tools."""
    return {
        "tools": mcp_server.available_tools,
        "total": len(mcp_server.available_tools),
    }


@router.post("/call")
async def call_tool(req: ToolCallRequest, request: Request):
    """Call an MCP tool by name with keyword arguments."""
    logger.info(
        "MCP call: tool=%s caller=%s",
        req.tool_name,
        req.caller_id,
    )
    # Extract auth token from header for MCP-level auth check
    auth_token = request.headers.get("X-Auth-Token")
    # caller_id is an MCP-level param, don't pass it in kwargs
    if "caller_id" in req.kwargs:
        del req.kwargs["caller_id"]
    # Middleware already enforced allowlist; pass resolved IP for shared policy reuse.
    client_ip = getattr(request.state, "client_ip", None)
    result = await mcp_server.call_tool(
        tool_name=req.tool_name,
        caller_id=req.caller_id,
        auth_token=auth_token,
        client_ip=client_ip,
        **req.kwargs,
    )
    if result.get("status") == "denied" and "rate_limited" in result.get("error", ""):
        raise HTTPException(status_code=429, detail=result["error"])
    if result.get("status") == "denied":
        raise HTTPException(status_code=403, detail=result.get("error", "Denied"))
    if result.get("status") == "error" and "Unknown MCP tool" in result.get("error", ""):
        raise HTTPException(status_code=404, detail=result["error"])
    return result
