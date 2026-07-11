"""Sandbox MCP Server — exposes sandbox capabilities via MCP protocol.

Exposed as an independent MCP server for external low-code platforms
(Dify, Hi-Agent, etc.) — NOT used as the internal Pi→Sandbox path.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from sandbox.config import settings
from sandbox.models import (
    CommandExecutionRequest,
    FileReadRequest,
    FileWriteRequest,
    PythonExecutionRequest,
)
from sandbox.paths import get_session_physical_workspace
from sandbox.services.artifact_manager import artifact_manager
from sandbox.services.execution_manager import execution_manager
from sandbox.services.file_manager import file_manager
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager

logger = logging.getLogger("sandbox.mcp")


class MCPServerAdapter:
    """Simplified MCP tool server.

    In production, this would be a proper MCP stdio/HTTP server using
    the ``mcp`` package. For v1 this adapter provides the same contract
    as a callable interface that a lightweight MCP wrapper can route to.
    """

    def __init__(self) -> None:
        self._rate_limits: dict[str, list[float]] = {}
        self._max_calls_per_minute = 60
        self._high_risk_tools = {
            "raw_run_command", "pip_install", "npm_install",
            "network_request", "delete_file", "run_skill",
        }

    # ── MCP tool implementations ──────────────────────────────────

    async def create_session(self, **kwargs) -> dict[str, Any]:
        session = session_manager.create(
            agent_session_id=kwargs.get("agent_session_id"),
            user_id=kwargs.get("user_id"),
            caller_id=kwargs.get("caller_id", "mcp"),
            metadata=kwargs.get("metadata"),
        )
        workspace_manager.init_workspace(session.session_id)
        return {
            "session_id": session.session_id,
            "status": session.status,
            "workspace_path": session.workspace_path,
        }

    async def close_session(self, **kwargs) -> dict[str, Any]:
        session_id = kwargs.get("session_id", "")
        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}
        workspace_manager.remove_workspace(session_id)
        session_manager.delete(session_id)
        return {"status": "closed"}

    async def run_python(self, **kwargs) -> dict[str, Any]:
        session_id = kwargs.get("session_id", "")
        code = kwargs.get("code", "")
        timeout = kwargs.get("timeout")

        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}
        if session.status != "RUNNING":
            return {"error": "Session is not active"}

        ws = get_session_physical_workspace(session)
        result = execution_manager.run_python(
            session_id=session_id,
            code=code,
            workspace_path=ws,
            timeout=timeout,
        )

        if result.get("status") == "conflict":
            return {"error": result["error"], "status": "conflict"}

        return {
            "execution_id": result["execution_id"],
            "status": result["status"],
            "stdout_preview": result.get("stdout_preview", ""),
            "stderr_preview": result.get("stderr_preview", ""),
            "exit_code": result.get("exit_code"),
            "duration_ms": result.get("duration_ms", 0.0),
        }

    async def run_command_limited(self, **kwargs) -> dict[str, Any]:
        """Run a limited shell command (no raw bash, no dangerous commands)."""
        session_id = kwargs.get("session_id", "")
        command = kwargs.get("command", "")
        timeout = kwargs.get("timeout")

        # Block dangerous commands
        blocked_prefixes = (
            "sudo", "su ", "rm -rf", "dd ", "> /dev/", "mkfs",
            "fdisk", "chmod 777", "chown ", "kill",
        )
        if command.startswith(blocked_prefixes):
            return {"error": f"Command not allowed: {command.split()[0]}", "status": "denied"}

        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}
        if session.status != "RUNNING":
            return {"error": "Session is not active"}

        ws = get_session_physical_workspace(session)
        result = execution_manager.run_command(
            session_id=session_id,
            command=command,
            workspace_path=ws,
            timeout=timeout,
        )

        if result.get("status") == "conflict":
            return {"error": result["error"], "status": "conflict"}

        return {
            "execution_id": result["execution_id"],
            "status": result["status"],
            "stdout_preview": result.get("stdout_preview", ""),
            "stderr_preview": result.get("stderr_preview", ""),
            "exit_code": result.get("exit_code"),
            "duration_ms": result.get("duration_ms", 0.0),
        }

    async def read_file(self, **kwargs) -> dict[str, Any]:
        session_id = kwargs.get("session_id", "")
        path = kwargs.get("path", "")
        offset = kwargs.get("offset")
        limit = kwargs.get("limit")

        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}

        ws = get_session_physical_workspace(session)
        try:
            result = file_manager.read_file(ws, path, offset, limit)
            return {
                "path": result.path,
                "content": result.content,
                "size": result.size,
                "truncated": result.truncated,
                "mime_type": result.mime_type,
            }
        except PermissionError as exc:
            return {"error": str(exc)}

    async def write_file(self, **kwargs) -> dict[str, Any]:
        session_id = kwargs.get("session_id", "")
        path = kwargs.get("path", "")
        content = kwargs.get("content", "")

        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}

        ws = get_session_physical_workspace(session)
        try:
            result = file_manager.write_file(ws, path, content)
            return {
                "path": result.path,
                "size": result.size,
                "mime_type": result.mime_type,
            }
        except (PermissionError, ValueError) as exc:
            return {"error": str(exc)}

    async def preview_file(self, **kwargs) -> dict[str, Any]:
        session_id = kwargs.get("session_id", "")
        path = kwargs.get("path", "")

        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}

        ws = get_session_physical_workspace(session)
        try:
            result = file_manager.read_file(ws, path, offset=1, limit=40)
            return {
                "path": result.path,
                "content": result.content,
                "size": result.size,
                "mime_type": result.mime_type,
            }
        except PermissionError as exc:
            return {"error": str(exc)}

    async def list_files(self, **kwargs) -> dict[str, Any]:
        session_id = kwargs.get("session_id", "")
        path = kwargs.get("path", ".")

        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}

        ws = get_session_physical_workspace(session)
        try:
            files = file_manager.list_files(ws, path)
            return {
                "files": [
                    {"name": f.name, "path": f.path, "is_dir": f.is_dir,
                     "size": f.size, "modified_at": f.modified_at}
                    for f in files
                ],
                "total": len(files),
            }
        except PermissionError as exc:
            return {"error": str(exc)}

    async def get_artifacts(self, **kwargs) -> dict[str, Any]:
        session_id = kwargs.get("session_id", "")
        artifacts = artifact_manager.list_by_session(session_id)
        return {
            "artifacts": [
                {
                    "artifact_id": a.artifact_id,
                    "name": a.name,
                    "path": a.path,
                    "mime_type": a.mime_type,
                    "size": a.size,
                }
                for a in artifacts
            ],
            "total": len(artifacts),
        }

    async def submit_artifact(self, **kwargs) -> dict[str, Any]:
        """Explicitly submit a workspace file as an artifact."""
        session_id = kwargs.get("session_id", "")
        path = kwargs.get("path", "")
        name = kwargs.get("name", path.split("/")[-1] if path else "untitled")
        mime_type = kwargs.get("mime_type", "application/octet-stream")

        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}

        ws = Path(get_session_physical_workspace(session))
        artifact_path = ws / path

        size = artifact_path.stat().st_size if artifact_path.exists() else 0

        result = artifact_manager.register(
            session_id=session_id,
            name=name,
            path=path,
            mime_type=mime_type,
            size=size,
        )
        return {
            "artifact_id": result.artifact_id,
            "name": result.name,
            "path": result.path,
            "mime_type": result.mime_type,
            "size": result.size,
        }

    async def download_file(self, **kwargs) -> dict[str, Any]:
        """Return file path for external download (MCP client fetches the file)."""
        session_id = kwargs.get("session_id", "")
        path = kwargs.get("path", "")

        session = session_manager.get(session_id)
        if session is None:
            return {"error": "Session not found"}

        ws = get_session_physical_workspace(session)
        try:
            safe_path = file_manager.get_binary_path(ws, path)
            if not safe_path.is_file():
                return {"error": "File not found"}
            return {
                "path": str(safe_path),
                "name": safe_path.name,
                "size": safe_path.stat().st_size,
            }
        except PermissionError as exc:
            return {"error": str(exc)}

    # ── Rate limiting ─────────────────────────────────────────────

    def check_rate_limit(self, caller_id: str, tool_name: str) -> bool:
        """Check if a caller is rate-limited. Returns True if allowed."""
        import time

        now = time.time()
        key = f"{caller_id}:{tool_name}"
        calls = self._rate_limits.get(key, [])

        # Remove calls older than 60 seconds
        calls = [c for c in calls if now - c < 60]
        is_high_risk = tool_name in self._high_risk_tools
        limit = 10 if is_high_risk else self._max_calls_per_minute

        if len(calls) >= limit:
            return False

        calls.append(now)
        self._rate_limits[key] = calls
        return True

    # ── Tool routing ──────────────────────────────────────────────

    TOOL_MAP = {
        "create_session": "create_session",
        "close_session": "close_session",
        "run_python": "run_python",
        "run_command_limited": "run_command_limited",
        "read_file": "read_file",
        "write_file": "write_file",
        "preview_file": "preview_file",
        "download_file": "download_file",
        "list_files": "list_files",
        "get_artifacts": "get_artifacts",
        "submit_artifact": "submit_artifact",
    }

    @property
    def available_tools(self) -> list[str]:
        return list(self.TOOL_MAP.keys())

    async def call_tool(
        self,
        tool_name: str,
        caller_id: str,
        auth_token: str | None = None,
        client_ip: str | None = None,
        **kwargs,
    ) -> dict[str, Any]:
        """Route an MCP tool call with rate limiting and auth check.

        ``client_ip`` is optional defense-in-depth: HTTP/MCP entry points already
        enforce ``NetworkPolicy`` in middleware. When provided (e.g. standalone
        adapters), the same allowlist is applied before tool dispatch.
        """
        if client_ip is not None:
            from sandbox.security.network_policy import get_network_policy

            allowed, _effective, reason = get_network_policy().evaluate(client_ip)
            if not allowed:
                try:
                    from sandbox.routers.health import sandbox_client_denied_total

                    sandbox_client_denied_total.labels(reason=reason).inc()
                except Exception:  # pragma: no cover
                    pass
                return {
                    "error": "Client address not allowlisted",
                    "status": "denied",
                }

        # Check MCP auth tokens if configured
        if settings.mcp_auth_tokens:
            if not auth_token or auth_token not in settings.mcp_auth_tokens:
                return {"error": "Invalid or missing MCP auth token", "status": "denied"}

        if not self.check_rate_limit(caller_id, tool_name):
            from sandbox.routers.health import sandbox_rate_limited_total
            sandbox_rate_limited_total.labels(caller_id=caller_id).inc()
            return {"error": "rate_limited", "status": "denied"}

        if tool_name not in self.TOOL_MAP:
            return {"error": f"Unknown MCP tool: {tool_name}", "status": "error"}

        handler_name = self.TOOL_MAP[tool_name]
        handler = getattr(self, handler_name, None)
        if handler is None:
            return {"error": f"Handler not implemented: {tool_name}", "status": "error"}

        from sandbox.routers.health import sandbox_mcp_requests_total
        sandbox_mcp_requests_total.labels(tool_name=tool_name).inc()

        return await handler(**kwargs)


mcp_server = MCPServerAdapter()
