"""MCP Manager — server register, discovery, authz, approval, ledger, invoke.

ADR 0002 §4.6 / §12.5:

* MCP Server registration
* Tool discovery + schema adapt
* Tool allowlist
* Org / user authorization
* Approval policy for high-risk tools
* Tool execution ledger (reuses B4 AgentRunManager / ToolExecutionRepository)
* Timeout + retry (idempotent; no double side-effects on terminal ledger rows)
* Result normalization

Transports:

* ``local`` — in-process handlers (tests + built-in sandbox MCP tools)
* ``http``  — POST to external MCP-over-HTTP endpoint (best-effort)

Tool names exposed to the agent are namespaced: ``mcp_{server_id}_{tool}``.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Iterable

from sandbox.models import RiskLevel, ToolExecutionStatus
from sandbox.services.agent_run_manager import AgentRunManager, agent_run_manager
from sandbox.services.approval_manager import ApprovalManager, approval_manager
from sandbox.services.policy_checker import POLICY_VERSION, policy_checker
from sandbox.services.tool_registry import (
    RegisteredTool,
    ToolCategory,
    ToolRegistry,
    tool_registry,
)

logger = logging.getLogger("sandbox.mcp.manager")

# Async handler: kwargs → result dict
LocalHandler = Callable[..., Awaitable[dict[str, Any]] | dict[str, Any]]

_SAFE_ID = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")
_DEFAULT_TIMEOUT_S = 30.0
_DEFAULT_MAX_RETRIES = 1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _namespace(server_id: str, tool_name: str) -> str:
    """Stable agent-facing tool name."""
    safe_server = re.sub(r"[^a-zA-Z0-9_-]", "_", server_id)[:48]
    safe_tool = re.sub(r"[^a-zA-Z0-9_-]", "_", tool_name)[:64]
    return f"mcp_{safe_server}_{safe_tool}"


def _parse_namespaced(name: str) -> tuple[str, str] | None:
    """Inverse of _namespace when server_id has no underscores ambiguity.

    Format: mcp_{server_id}_{tool} where server_id is known at lookup time.
    Callers should prefer looking up by full name in the registry.
    """
    if not name.startswith("mcp_"):
        return None
    rest = name[4:]
    if "_" not in rest:
        return None
    # Prefer longest matching registered server prefix — handled in manager.
    return rest, ""  # placeholder; manager resolves


@dataclass
class MCPToolDef:
    """Discovered tool schema (pre-namespace)."""

    name: str
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)
    risk_level: str = "medium"
    # When True, always requires approval regardless of risk map
    requires_approval: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": self.input_schema or {},
            "risk_level": self.risk_level,
            "requires_approval": self.requires_approval,
        }


@dataclass
class MCPServerRecord:
    """Registered MCP server configuration."""

    server_id: str
    name: str
    transport: str = "local"  # local | http
    url: str | None = None
    enabled: bool = True
    # Tool-name allowlist (raw MCP names). None / empty = all discovered tools.
    allowlist: list[str] | None = None
    # Authorization: None = unrestricted; empty list = deny all.
    allowed_orgs: list[str] | None = None
    allowed_users: list[str] | None = None
    # Per-tool risk overrides (raw tool name → low|medium|high)
    risk_overrides: dict[str, str] = field(default_factory=dict)
    # Tools that always require approval (raw names)
    high_risk_tools: list[str] = field(default_factory=list)
    auth_token: str | None = None
    timeout_seconds: float = _DEFAULT_TIMEOUT_S
    max_retries: int = _DEFAULT_MAX_RETRIES
    # Static tool defs for local transport (or cached discovery)
    tools: list[MCPToolDef] = field(default_factory=list)
    # Local handlers keyed by raw tool name
    handlers: dict[str, LocalHandler] = field(default_factory=dict, repr=False)
    metadata: dict[str, Any] = field(default_factory=dict)
    registered_at: str = field(default_factory=_now_iso)

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "server_id": self.server_id,
            "name": self.name,
            "transport": self.transport,
            "url": self.url,
            "enabled": self.enabled,
            "allowlist": list(self.allowlist) if self.allowlist is not None else None,
            "allowed_orgs": list(self.allowed_orgs)
            if self.allowed_orgs is not None
            else None,
            "allowed_users": list(self.allowed_users)
            if self.allowed_users is not None
            else None,
            "risk_overrides": dict(self.risk_overrides or {}),
            "high_risk_tools": list(self.high_risk_tools or []),
            "timeout_seconds": self.timeout_seconds,
            "max_retries": self.max_retries,
            "tool_count": len(self.tools),
            "metadata": dict(self.metadata or {}),
            "registered_at": self.registered_at,
            # Never expose auth_token
        }


def normalize_mcp_result(
    raw: Any,
    *,
    status: str = "ok",
    tool_name: str | None = None,
    server_id: str | None = None,
    duration_ms: float | None = None,
    error: str | None = None,
) -> dict[str, Any]:
    """Normalize heterogeneous MCP/local results into a stable envelope."""
    content: Any
    details: dict[str, Any] = {}

    if isinstance(raw, dict):
        # Pass through structured payloads; surface common error keys.
        if raw.get("status") == "denied" or raw.get("error"):
            status = "error" if status == "ok" else status
            error = error or str(raw.get("error") or raw.get("reason") or "denied")
        content = raw
        # Prefer explicit content/details when present
        if "content" in raw and "details" in raw:
            content = raw.get("content")
            details = dict(raw.get("details") or {})
        elif "result" in raw and len(raw) <= 3:
            content = raw.get("result")
            details = {k: v for k, v in raw.items() if k != "result"}
    elif isinstance(raw, list):
        content = raw
    elif raw is None:
        content = None
    else:
        content = {"text": str(raw)}

    envelope: dict[str, Any] = {
        "status": status if not error else ("error" if status == "ok" else status),
        "tool_name": tool_name,
        "server_id": server_id,
        "content": content,
        "details": details,
        "error": error,
        "duration_ms": duration_ms,
        "normalized": True,
    }
    return envelope


class MCPManager:
    """Register MCP servers, discover tools, authorize, approve, ledger, invoke."""

    def __init__(
        self,
        *,
        registry: ToolRegistry | None = None,
        runs: AgentRunManager | None = None,
        approvals: ApprovalManager | None = None,
    ) -> None:
        self.registry = registry or tool_registry
        self.runs = runs or agent_run_manager
        self.approvals = approvals if approvals is not None else approval_manager
        self._servers: dict[str, MCPServerRecord] = {}
        # Wire dynamic provider once
        self.registry.add_provider(self.list_registered_tools)

    # ── Server registration ───────────────────────────────────────────

    def register_server(
        self,
        server_id: str,
        *,
        name: str | None = None,
        transport: str = "local",
        url: str | None = None,
        enabled: bool = True,
        allowlist: list[str] | None = None,
        allowed_orgs: list[str] | None = None,
        allowed_users: list[str] | None = None,
        risk_overrides: dict[str, str] | None = None,
        high_risk_tools: list[str] | None = None,
        auth_token: str | None = None,
        timeout_seconds: float | None = None,
        max_retries: int | None = None,
        tools: list[MCPToolDef | dict[str, Any]] | None = None,
        handlers: dict[str, LocalHandler] | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> MCPServerRecord:
        if not server_id or not _SAFE_ID.match(server_id):
            raise ValueError(
                "server_id must match [a-zA-Z0-9_-]{1,64}"
            )
        transport = (transport or "local").lower()
        if transport not in ("local", "http"):
            raise ValueError("transport must be local|http")
        if transport == "http" and not url:
            raise ValueError("http transport requires url")

        tool_defs = self._coerce_tools(tools or [])
        rec = MCPServerRecord(
            server_id=server_id,
            name=name or server_id,
            transport=transport,
            url=url,
            enabled=enabled,
            allowlist=list(allowlist) if allowlist is not None else None,
            allowed_orgs=list(allowed_orgs) if allowed_orgs is not None else None,
            allowed_users=list(allowed_users) if allowed_users is not None else None,
            risk_overrides=dict(risk_overrides or {}),
            high_risk_tools=list(high_risk_tools or []),
            auth_token=auth_token,
            timeout_seconds=float(
                timeout_seconds if timeout_seconds is not None else _DEFAULT_TIMEOUT_S
            ),
            max_retries=int(
                max_retries if max_retries is not None else _DEFAULT_MAX_RETRIES
            ),
            tools=tool_defs,
            handlers=dict(handlers or {}),
            metadata=dict(metadata or {}),
        )
        # Replace previous registration cleanly
        if server_id in self._servers:
            self.registry.unregister_by_server(server_id)
        self._servers[server_id] = rec
        self._sync_registry(rec)
        logger.info(
            "MCP server registered id=%s transport=%s tools=%d",
            server_id,
            transport,
            len(tool_defs),
        )
        return rec

    def unregister_server(self, server_id: str) -> bool:
        rec = self._servers.pop(server_id, None)
        if rec is None:
            return False
        self.registry.unregister_by_server(server_id)
        return True

    def get_server(self, server_id: str) -> MCPServerRecord | None:
        return self._servers.get(server_id)

    def list_servers(self, *, enabled_only: bool = False) -> list[MCPServerRecord]:
        out = list(self._servers.values())
        if enabled_only:
            out = [s for s in out if s.enabled]
        out.sort(key=lambda s: s.server_id)
        return out

    # ── Discovery ─────────────────────────────────────────────────────

    def discover_tools(
        self,
        server_id: str | None = None,
        *,
        user_id: str | None = None,
        organization_id: str | None = None,
        apply_authz: bool = True,
    ) -> list[dict[str, Any]]:
        """Return agent-facing tool descriptors for one or all servers."""
        servers = (
            [self._servers[server_id]]
            if server_id and server_id in self._servers
            else self.list_servers(enabled_only=True)
        )
        if server_id and server_id not in self._servers:
            return []

        discovered: list[dict[str, Any]] = []
        for rec in servers:
            if not rec.enabled:
                continue
            if apply_authz and not self.authorize_server(
                rec, user_id=user_id, organization_id=organization_id
            ):
                continue
            for tool in rec.tools:
                if rec.allowlist is not None and len(rec.allowlist) > 0:
                    if tool.name not in rec.allowlist:
                        continue
                namespaced = _namespace(rec.server_id, tool.name)
                risk = self._resolve_risk(rec, tool)
                discovered.append(
                    {
                        "name": namespaced,
                        "raw_name": tool.name,
                        "server_id": rec.server_id,
                        "server_name": rec.name,
                        "description": tool.description
                        or f"MCP tool {tool.name} from {rec.name}",
                        "input_schema": self.adapt_schema(tool.input_schema),
                        "risk_level": risk,
                        "requires_approval": self._requires_approval(rec, tool, risk),
                        "category": ToolCategory.MCP.value,
                    }
                )
        discovered.sort(key=lambda d: d["name"])
        return discovered

    def adapt_schema(self, schema: dict[str, Any] | None) -> dict[str, Any]:
        """Convert MCP JSON Schema fragments into a stable object schema."""
        if not schema:
            return {"type": "object", "properties": {}, "additionalProperties": True}
        if not isinstance(schema, dict):
            return {"type": "object", "properties": {}, "additionalProperties": True}
        out = dict(schema)
        out.setdefault("type", "object")
        if out.get("type") == "object":
            out.setdefault("properties", {})
        return out

    def list_registered_tools(self) -> list[RegisteredTool]:
        """Provider for ToolRegistry dynamic refresh."""
        tools: list[RegisteredTool] = []
        for rec in self.list_servers(enabled_only=True):
            for t in rec.tools:
                if rec.allowlist is not None and len(rec.allowlist) > 0:
                    if t.name not in rec.allowlist:
                        continue
                risk = self._resolve_risk(rec, t)
                tools.append(
                    RegisteredTool(
                        name=_namespace(rec.server_id, t.name),
                        category=ToolCategory.MCP,
                        description=t.description or t.name,
                        risk_level=risk,
                        input_schema=self.adapt_schema(t.input_schema),
                        server_id=rec.server_id,
                        allowlist_required=bool(rec.allowlist),
                        metadata={
                            "raw_name": t.name,
                            "server_id": rec.server_id,
                            "requires_approval": self._requires_approval(rec, t, risk),
                        },
                    )
                )
        return tools

    # ── Authorization ─────────────────────────────────────────────────

    def authorize_server(
        self,
        rec: MCPServerRecord | str,
        *,
        user_id: str | None = None,
        organization_id: str | None = None,
    ) -> bool:
        """Return True when the actor may see/call tools on this server.

        Rules:
        - ``allowed_orgs is None`` and ``allowed_users is None`` → open
        - If either list is set (including empty), actor must match at least one
        - Empty list with the other None → deny everyone for that dimension
        """
        if isinstance(rec, str):
            found = self._servers.get(rec)
            if found is None:
                return False
            rec = found
        if not rec.enabled:
            return False

        org_ok = True
        user_ok = True
        if rec.allowed_orgs is not None:
            org_ok = bool(organization_id) and organization_id in rec.allowed_orgs
        if rec.allowed_users is not None:
            user_ok = bool(user_id) and user_id in rec.allowed_users

        # If both dimensions configured, either match is enough (union).
        if rec.allowed_orgs is not None and rec.allowed_users is not None:
            return org_ok or user_ok
        if rec.allowed_orgs is not None:
            return org_ok
        if rec.allowed_users is not None:
            return user_ok
        return True

    def authorize_tool(
        self,
        namespaced_or_raw: str,
        *,
        server_id: str | None = None,
        user_id: str | None = None,
        organization_id: str | None = None,
    ) -> tuple[bool, str]:
        """Authorize a specific tool. Returns (ok, reason)."""
        resolved = self.resolve_tool(namespaced_or_raw, server_id=server_id)
        if resolved is None:
            return False, "unknown MCP tool"
        rec, tool = resolved
        if not rec.enabled:
            return False, "MCP server disabled"
        if not self.authorize_server(
            rec, user_id=user_id, organization_id=organization_id
        ):
            return False, "not authorized for this MCP server"
        if rec.allowlist is not None and len(rec.allowlist) > 0:
            if tool.name not in rec.allowlist:
                return False, "tool not on server allowlist"
        return True, "ok"

    # ── Approval policy ───────────────────────────────────────────────

    def approval_decision(
        self,
        namespaced_or_raw: str,
        *,
        server_id: str | None = None,
    ) -> dict[str, Any]:
        """Return policy decision for an MCP tool (no side effects)."""
        resolved = self.resolve_tool(namespaced_or_raw, server_id=server_id)
        if resolved is None:
            return {
                "decision": "hard_deny",
                "risk_level": "high",
                "reason": "unknown MCP tool",
                "policy_version": POLICY_VERSION,
            }
        rec, tool = resolved
        risk = self._resolve_risk(rec, tool)
        if self._requires_approval(rec, tool, risk):
            return {
                "decision": "approval_required",
                "risk_level": risk,
                "reason": f"high-risk MCP tool {tool.name}",
                "policy_version": POLICY_VERSION,
            }
        if risk == "low":
            return {
                "decision": "allow",
                "risk_level": risk,
                "reason": "low risk MCP tool",
                "policy_version": POLICY_VERSION,
            }
        return {
            "decision": "allow",
            "risk_level": risk,
            "reason": "MCP tool allowed",
            "policy_version": POLICY_VERSION,
        }

    # ── Invoke (with ledger / timeout / retry) ────────────────────────

    async def invoke(
        self,
        tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        server_id: str | None = None,
        user_id: str | None = None,
        organization_id: str | None = None,
        run_id: str | None = None,
        session_id: str | None = None,
        conversation_id: str | None = None,
        workspace_id: str | None = None,
        tool_call_id: str | None = None,
        idempotency_key: str | None = None,
        skip_approval: bool = False,
        approval_id: str | None = None,
    ) -> dict[str, Any]:
        """Invoke an MCP tool with authz, optional approval, ledger, timeout/retry."""
        arguments = dict(arguments or {})
        ok, reason = self.authorize_tool(
            tool_name,
            server_id=server_id,
            user_id=user_id,
            organization_id=organization_id,
        )
        if not ok:
            return normalize_mcp_result(
                None,
                status="denied",
                tool_name=tool_name,
                server_id=server_id,
                error=reason,
            )

        resolved = self.resolve_tool(tool_name, server_id=server_id)
        assert resolved is not None
        rec, tool = resolved
        namespaced = _namespace(rec.server_id, tool.name)
        risk = self._resolve_risk(rec, tool)

        call_id = tool_call_id or f"mcp_{uuid.uuid4().hex[:16]}"
        idem = idempotency_key or f"idem_{call_id}"
        ledger_active = False

        # Ledger prepare (B4) — best-effort when run_id present
        if run_id:
            try:
                prepared = self.runs.prepare_tool(
                    tool_call_id=call_id,
                    run_id=run_id,
                    idempotency_key=idem,
                    tool_name=namespaced,
                    arguments=arguments,
                    session_id=session_id,
                    conversation_id=conversation_id,
                    workspace_id=workspace_id,
                    summary=f"mcp:{rec.server_id}:{tool.name}",
                )
                ledger_active = True
                # Idempotent replay of terminal rows
                if prepared.status in (
                    ToolExecutionStatus.SUCCEEDED.value,
                    ToolExecutionStatus.FAILED.value,
                    ToolExecutionStatus.CANCELLED.value,
                    ToolExecutionStatus.UNKNOWN.value,
                ):
                    cached = prepared.result_json
                    if isinstance(cached, dict) and cached.get("normalized"):
                        return cached
                    return normalize_mcp_result(
                        cached or prepared.result_summary,
                        status=(
                            "ok"
                            if prepared.status == ToolExecutionStatus.SUCCEEDED.value
                            else "error"
                        ),
                        tool_name=namespaced,
                        server_id=rec.server_id,
                        error=prepared.error,
                    )
                if prepared.status == ToolExecutionStatus.EXECUTING.value:
                    return normalize_mcp_result(
                        None,
                        status="error",
                        tool_name=namespaced,
                        server_id=rec.server_id,
                        error="tool still executing; refusing duplicate side-effect",
                    )
            except Exception as exc:
                logger.warning("MCP ledger prepare failed: %s", exc)
                ledger_active = False

        # Approval gate
        if self._requires_approval(rec, tool, risk) and not skip_approval:
            # If caller already has an approved approval_id, accept it.
            approved = False
            if approval_id and self.approvals is not None:
                entry = self.approvals.get(approval_id)
                if entry and entry.get("status") == "approved":
                    approved = True
            if not approved:
                if ledger_active:
                    try:
                        self.runs.mark_tool_waiting_approval(call_id)
                    except Exception:
                        pass
                if self.approvals is None:
                    return normalize_mcp_result(
                        None,
                        status="denied",
                        tool_name=namespaced,
                        server_id=rec.server_id,
                        error="approval required but approval manager unavailable",
                    )
                # Create pending approval and return without executing
                risk_enum = (
                    RiskLevel.HIGH
                    if risk == "high"
                    else RiskLevel.MEDIUM
                    if risk == "medium"
                    else RiskLevel.LOW
                )
                entry = self.approvals.create(
                    session_id=session_id or "mcp",
                    tool_name=namespaced,
                    risk_level=risk_enum,
                    reason=f"high-risk MCP tool {tool.name}",
                    payload={
                        "server_id": rec.server_id,
                        "raw_name": tool.name,
                        "arguments": arguments,
                        "tool_call_id": call_id,
                        "idempotency_key": idem,
                    },
                )
                return {
                    "status": "pending_approval",
                    "tool_name": namespaced,
                    "server_id": rec.server_id,
                    "approval_id": entry["approval_id"],
                    "risk_level": risk,
                    "reason": entry.get("reason"),
                    "tool_call_id": call_id,
                    "normalized": True,
                    "content": None,
                    "details": {"approval_required": True},
                    "error": None,
                    "duration_ms": None,
                }

        if ledger_active:
            try:
                self.runs.mark_tool_executing(call_id)
            except Exception:
                pass

        # Timeout + retry (no retry after success; ledger terminal prevents double effects)
        attempts = max(1, int(rec.max_retries) + 1)
        timeout = max(0.1, float(rec.timeout_seconds))
        last_error: str | None = None
        raw_result: Any = None
        t0 = time.monotonic()

        for attempt in range(attempts):
            try:
                raw_result = await asyncio.wait_for(
                    self._dispatch(rec, tool.name, arguments),
                    timeout=timeout,
                )
                last_error = None
                break
            except asyncio.TimeoutError:
                last_error = f"MCP tool timed out after {timeout}s"
                logger.warning(
                    "MCP timeout server=%s tool=%s attempt=%d",
                    rec.server_id,
                    tool.name,
                    attempt + 1,
                )
            except Exception as exc:
                last_error = str(exc) or exc.__class__.__name__
                logger.warning(
                    "MCP invoke error server=%s tool=%s attempt=%d err=%s",
                    rec.server_id,
                    tool.name,
                    attempt + 1,
                    last_error,
                )
            # Small backoff before retry
            if attempt + 1 < attempts:
                await asyncio.sleep(min(0.5 * (attempt + 1), 2.0))

        duration_ms = round((time.monotonic() - t0) * 1000, 2)

        if last_error is not None:
            envelope = normalize_mcp_result(
                None,
                status="error",
                tool_name=namespaced,
                server_id=rec.server_id,
                duration_ms=duration_ms,
                error=last_error,
            )
            if ledger_active:
                try:
                    self.runs.mark_tool_terminal(
                        call_id,
                        ToolExecutionStatus.FAILED.value,
                        summary=last_error[:500],
                        error=last_error,
                        result_json=envelope,
                    )
                except Exception:
                    pass
            return envelope

        # Detect denied/error in handler payload
        status = "ok"
        err: str | None = None
        if isinstance(raw_result, dict):
            if raw_result.get("status") == "denied":
                status = "denied"
                err = str(raw_result.get("error") or "denied")
            elif raw_result.get("error") and raw_result.get("status") == "error":
                status = "error"
                err = str(raw_result.get("error"))

        envelope = normalize_mcp_result(
            raw_result,
            status=status,
            tool_name=namespaced,
            server_id=rec.server_id,
            duration_ms=duration_ms,
            error=err,
        )
        envelope["tool_call_id"] = call_id

        if ledger_active:
            terminal = (
                ToolExecutionStatus.SUCCEEDED.value
                if status == "ok"
                else ToolExecutionStatus.FAILED.value
            )
            try:
                self.runs.mark_tool_terminal(
                    call_id,
                    terminal,
                    summary=(err or f"{tool.name} {status}")[:500],
                    error=err,
                    result_json=envelope,
                )
            except Exception:
                pass

        return envelope

    # ── Resolve helpers ───────────────────────────────────────────────

    def resolve_tool(
        self,
        namespaced_or_raw: str,
        *,
        server_id: str | None = None,
    ) -> tuple[MCPServerRecord, MCPToolDef] | None:
        """Resolve a namespaced or raw tool name to (server, tool)."""
        name = namespaced_or_raw or ""
        # Prefer exact namespaced match across servers
        for rec in self._servers.values():
            for tool in rec.tools:
                if _namespace(rec.server_id, tool.name) == name:
                    if server_id and rec.server_id != server_id:
                        continue
                    return rec, tool
        # Raw name + optional server_id
        if server_id and server_id in self._servers:
            rec = self._servers[server_id]
            for tool in rec.tools:
                if tool.name == name:
                    return rec, tool
        # Ambiguous raw match — only if unique
        matches: list[tuple[MCPServerRecord, MCPToolDef]] = []
        for rec in self._servers.values():
            for tool in rec.tools:
                if tool.name == name:
                    matches.append((rec, tool))
        if len(matches) == 1:
            return matches[0]
        return None

    # ── Internals ─────────────────────────────────────────────────────

    def _sync_registry(self, rec: MCPServerRecord) -> None:
        self.registry.unregister_by_server(rec.server_id)
        if not rec.enabled:
            return
        for t in rec.tools:
            if rec.allowlist is not None and len(rec.allowlist) > 0:
                if t.name not in rec.allowlist:
                    continue
            risk = self._resolve_risk(rec, t)
            self.registry.register(
                RegisteredTool(
                    name=_namespace(rec.server_id, t.name),
                    category=ToolCategory.MCP,
                    description=t.description or t.name,
                    risk_level=risk,
                    input_schema=self.adapt_schema(t.input_schema),
                    server_id=rec.server_id,
                    allowlist_required=bool(rec.allowlist),
                    metadata={
                        "raw_name": t.name,
                        "server_id": rec.server_id,
                        "requires_approval": self._requires_approval(rec, t, risk),
                    },
                )
            )

    def _resolve_risk(self, rec: MCPServerRecord, tool: MCPToolDef) -> str:
        if tool.name in (rec.high_risk_tools or []):
            return "high"
        if tool.name in (rec.risk_overrides or {}):
            return str(rec.risk_overrides[tool.name]).lower()
        if tool.requires_approval:
            return "high"
        # Prefer explicit tool risk when set to low/high
        explicit = (tool.risk_level or "").lower().strip()
        if explicit in ("low", "high"):
            return explicit
        # Fall back to policy_checker catalog for known sandbox tool names
        try:
            rl = policy_checker.get_risk_level(tool.name)
            mapped = rl.value if hasattr(rl, "value") else str(rl)
            if mapped and mapped != "medium":
                return mapped
        except Exception:
            pass
        return explicit or "medium"

    def _requires_approval(
        self, rec: MCPServerRecord, tool: MCPToolDef, risk: str
    ) -> bool:
        if tool.requires_approval:
            return True
        if tool.name in (rec.high_risk_tools or []):
            return True
        return risk == "high"

    def _coerce_tools(
        self, tools: Iterable[MCPToolDef | dict[str, Any]]
    ) -> list[MCPToolDef]:
        out: list[MCPToolDef] = []
        for t in tools:
            if isinstance(t, MCPToolDef):
                out.append(t)
            elif isinstance(t, dict):
                out.append(
                    MCPToolDef(
                        name=str(t.get("name") or ""),
                        description=str(t.get("description") or ""),
                        input_schema=dict(t.get("input_schema") or t.get("parameters") or {}),
                        risk_level=str(t.get("risk_level") or "medium"),
                        requires_approval=bool(t.get("requires_approval")),
                    )
                )
        return [t for t in out if t.name]

    async def _dispatch(
        self,
        rec: MCPServerRecord,
        raw_name: str,
        arguments: dict[str, Any],
    ) -> Any:
        if rec.transport == "local":
            handler = rec.handlers.get(raw_name)
            if handler is None:
                # Fall back to built-in sandbox MCP adapter for known tools
                from sandbox.mcp.server import mcp_server

                if raw_name in mcp_server.TOOL_MAP:
                    return await mcp_server.call_tool(
                        tool_name=raw_name,
                        caller_id="mcp-manager",
                        auth_token=None,
                        **arguments,
                    )
                raise KeyError(f"No local handler for MCP tool {raw_name}")
            result = handler(**arguments)
            if asyncio.iscoroutine(result):
                return await result
            return result

        if rec.transport == "http":
            return await self._dispatch_http(rec, raw_name, arguments)

        raise ValueError(f"Unsupported transport: {rec.transport}")

    async def _dispatch_http(
        self,
        rec: MCPServerRecord,
        raw_name: str,
        arguments: dict[str, Any],
    ) -> Any:
        """Best-effort HTTP MCP-over-HTTP call (same shape as /mcp/call)."""
        import json
        import urllib.error
        import urllib.request

        url = (rec.url or "").rstrip("/") + "/call"
        body = json.dumps(
            {
                "tool_name": raw_name,
                "caller_id": "mcp-manager",
                "kwargs": arguments,
            }
        ).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if rec.auth_token:
            headers["X-Auth-Token"] = rec.auth_token

        def _do() -> dict[str, Any]:
            req = urllib.request.Request(url, data=body, headers=headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=rec.timeout_seconds) as resp:
                    data = resp.read()
                    return json.loads(data.decode("utf-8") or "{}")
            except urllib.error.HTTPError as exc:
                payload = exc.read().decode("utf-8", errors="replace")
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError:
                    parsed = {"error": payload or str(exc), "status": "error"}
                if isinstance(parsed, dict):
                    parsed.setdefault("status", "error")
                    return parsed
                return {"error": str(exc), "status": "error"}

        return await asyncio.to_thread(_do)

    def reset(self) -> None:
        """Clear all servers (tests)."""
        for sid in list(self._servers.keys()):
            self.unregister_server(sid)


# Module singleton — tests may construct MCPManager() with isolated deps.
mcp_manager = MCPManager()


def seed_builtin_sandbox_mcp_server(
    manager: MCPManager | None = None,
) -> MCPServerRecord:
    """Register the built-in sandbox MCP tools as a discoverable server.

    Used so agents can discover sandbox MCP surface via the unified registry
    without calling the external-facing /mcp REST adapter directly.
    """
    mgr = manager or mcp_manager
    from sandbox.mcp.server import mcp_server

    # Tools that exist on the built-in adapter and warrant approval
    high_risk = {
        "write_file",
        "run_command_limited",
        "run_python",
        "submit_artifact",
        *set(mcp_server._high_risk_tools),
    }
    low_risk = {
        "read_file",
        "list_files",
        "preview_file",
        "get_artifacts",
        "create_session",
        "close_session",
        "download_file",
    }
    tools = []
    for name in mcp_server.available_tools:
        if name in low_risk:
            risk, need_appr = "low", False
        elif name in high_risk:
            risk, need_appr = "high", True
        else:
            risk, need_appr = "medium", False
        tools.append(
            MCPToolDef(
                name=name,
                description=f"Sandbox MCP tool: {name}",
                input_schema={"type": "object", "additionalProperties": True},
                risk_level=risk,
                requires_approval=need_appr,
            )
        )

    return mgr.register_server(
        "sandbox",
        name="Built-in Sandbox MCP",
        transport="local",
        enabled=True,
        high_risk_tools=sorted(high_risk),
        tools=tools,
        handlers={},  # dispatch falls through to mcp_server
        metadata={"builtin": True},
    )
