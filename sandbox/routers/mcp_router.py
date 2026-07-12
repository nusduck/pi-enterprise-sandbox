"""MCP Router — external MCP adapter + registry / discovery / invoke.

Two surfaces share the ``/mcp`` prefix:

1. **External adapter** (existing):
   - ``GET  /mcp/tools`` — list built-in sandbox MCP tool names
   - ``POST /mcp/call``  — call a built-in sandbox MCP tool

2. **Registry / agent path** (B5):
   - ``GET    /mcp/registry`` — unified tool registry tree
   - ``GET    /mcp/servers`` — list registered MCP servers
   - ``POST   /mcp/servers`` — register / replace a server
   - ``DELETE /mcp/servers/{server_id}``
   - ``GET    /mcp/discover`` — discover tools (authz-aware)
   - ``POST   /mcp/invoke`` — invoke with authz / approval / ledger
   - ``GET    /mcp/policy`` — approval policy for a tool name
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from sandbox.mcp.server import mcp_server
from sandbox.models import MCPServerRegister, MCPToolInvoke
from sandbox.services.mcp_manager import (
    mcp_manager,
    seed_builtin_sandbox_mcp_server,
)
from sandbox.services.tool_registry import tool_registry

logger = logging.getLogger("sandbox.mcp.router")
router = APIRouter(prefix="/mcp", tags=["mcp"])

# Ensure built-in sandbox MCP tools are discoverable via the registry on import.
try:
    if mcp_manager.get_server("sandbox") is None:
        seed_builtin_sandbox_mcp_server(mcp_manager)
except Exception:  # pragma: no cover — import-time best effort
    logger.exception("Failed to seed built-in sandbox MCP server")


class ToolCallRequest(BaseModel):
    tool_name: str
    caller_id: str = "mcp-client"
    kwargs: dict[str, Any] = {}


# ── External adapter (legacy) ───────────────────────────────────────────


@router.get("/tools")
async def list_tools():
    """List all available built-in MCP tools (external adapter)."""
    return {
        "tools": mcp_server.available_tools,
        "total": len(mcp_server.available_tools),
    }


@router.post("/call")
async def call_tool(req: ToolCallRequest, request: Request):
    """Call a built-in MCP tool by name with keyword arguments."""
    logger.info(
        "MCP call: tool=%s caller=%s",
        req.tool_name,
        req.caller_id,
    )
    auth_token = request.headers.get("X-Auth-Token")
    if "caller_id" in req.kwargs:
        del req.kwargs["caller_id"]
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


# ── Unified registry ────────────────────────────────────────────────────


@router.get("/registry")
async def get_tool_registry():
    """Return the unified ToolRegistry tree (all categories)."""
    return {
        "version": tool_registry.version,
        "categories": tool_registry.categories(),
        "tools": tool_registry.list_by_category(),
        "allowlist": tool_registry.allowlist(include_skill=True, include_mcp=True),
    }


# ── MCP server management ───────────────────────────────────────────────


@router.get("/servers")
async def list_mcp_servers(enabled_only: bool = False):
    servers = mcp_manager.list_servers(enabled_only=enabled_only)
    return {
        "servers": [s.to_public_dict() for s in servers],
        "total": len(servers),
    }


@router.post("/servers", status_code=201)
async def register_mcp_server(body: MCPServerRegister):
    try:
        rec = mcp_manager.register_server(
            body.server_id,
            name=body.name,
            transport=body.transport,
            url=body.url,
            enabled=body.enabled,
            allowlist=body.allowlist,
            allowed_orgs=body.allowed_orgs,
            allowed_users=body.allowed_users,
            risk_overrides=body.risk_overrides,
            high_risk_tools=body.high_risk_tools,
            auth_token=body.auth_token,
            timeout_seconds=body.timeout_seconds,
            max_retries=body.max_retries,
            tools=body.tools,
            metadata=body.metadata,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return rec.to_public_dict()


@router.get("/servers/{server_id}")
async def get_mcp_server(server_id: str):
    rec = mcp_manager.get_server(server_id)
    if rec is None:
        raise HTTPException(status_code=404, detail="MCP server not found")
    return rec.to_public_dict()


@router.delete("/servers/{server_id}")
async def delete_mcp_server(server_id: str):
    if server_id == "sandbox":
        raise HTTPException(
            status_code=400,
            detail="Cannot delete built-in sandbox MCP server",
        )
    if not mcp_manager.unregister_server(server_id):
        raise HTTPException(status_code=404, detail="MCP server not found")
    return {"status": "deleted", "server_id": server_id}


# ── Discovery / policy / invoke ─────────────────────────────────────────


@router.get("/discover")
async def discover_mcp_tools(
    server_id: str | None = None,
    user_id: str | None = Query(default=None),
    organization_id: str | None = Query(default=None),
    apply_authz: bool = True,
):
    """Discover registered MCP tools (optionally filtered by actor authz)."""
    tools = mcp_manager.discover_tools(
        server_id,
        user_id=user_id,
        organization_id=organization_id,
        apply_authz=apply_authz,
    )
    return {"tools": tools, "total": len(tools)}


@router.get("/policy")
async def mcp_tool_policy(
    tool_name: str,
    server_id: str | None = None,
):
    """Return approval policy decision for an MCP tool (no side effects)."""
    return mcp_manager.approval_decision(tool_name, server_id=server_id)


@router.post("/invoke")
async def invoke_mcp_tool(body: MCPToolInvoke, request: Request):
    """Invoke an MCP tool with authz, approval, ledger, timeout/retry."""
    # Prefer acting headers when present (service→sandbox with user context)
    user_id = body.user_id or request.headers.get("X-Acting-User-Id")
    org_id = body.organization_id or request.headers.get(
        "X-Acting-Organization-Id"
    )
    result = await mcp_manager.invoke(
        body.tool_name,
        body.arguments,
        server_id=body.server_id,
        user_id=user_id,
        organization_id=org_id,
        run_id=body.run_id,
        session_id=body.session_id,
        conversation_id=body.conversation_id,
        workspace_id=body.workspace_id,
        tool_call_id=body.tool_call_id,
        idempotency_key=body.idempotency_key,
        skip_approval=body.skip_approval,
        approval_id=body.approval_id,
    )
    if result.get("status") == "denied":
        raise HTTPException(status_code=403, detail=result.get("error") or "Denied")
    return result
