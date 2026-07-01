"""Enterprise Tool Adapter — intercepts Pi tool calls and routes them to Sandbox.

This is the most important Pi secondary-development layer. It:
1. Receives Pi tool_call
2. Checks against ToolPolicyChecker
3. Routes to SandboxClient (HTTP) or blocks
4. Normalizes ToolResult for Pi context
5. Logs audit trail
"""

from __future__ import annotations

import logging
from typing import Any

from agent.sandbox_client import SandboxClient
from agent.tool_policy import EnterpriseToolPolicy

logger = logging.getLogger("agent.tool_adapter")


class StandardizedToolResult:
    """Standardised ToolResult matching Pi's expected format.

    Only injects stdout_preview, stderr_preview, exit_code, artifact
    summary, and next-step suggestions — never full large files.
    """

    def __init__(self, raw: dict[str, Any]) -> None:
        self._raw = raw

    @property
    def tool_name(self) -> str:
        return self._raw.get("tool_name", "unknown")

    @property
    def status(self) -> str:
        return self._raw.get("status", "success")

    @property
    def stdout_preview(self) -> str:
        return self._raw.get("stdout_preview", "")

    @property
    def stderr_preview(self) -> str:
        return self._raw.get("stderr_preview", "")

    @property
    def exit_code(self) -> int | None:
        return self._raw.get("exit_code")

    @property
    def artifacts(self) -> list[dict[str, Any]]:
        return self._raw.get("artifacts", [])

    @property
    def metadata(self) -> dict[str, Any]:
        return self._raw.get("metadata", {})

    # ── Pi context injection ──────────────────────────────────────

    def to_pi_context(self) -> str:
        """Build the preview text that gets injected into Pi's context."""
        parts = [f"[{self.tool_name}] exit_code={self.exit_code}"]

        if self.stdout_preview:
            stdout = self.stdout_preview
            if len(stdout) > 2000:
                stdout = stdout[:2000] + "\n... [truncated]"
            parts.append(f"stdout:\n{stdout}")

        if self.stderr_preview:
            stderr = self.stderr_preview
            if len(stderr) > 1000:
                stderr = stderr[:1000] + "\n... [truncated]"
            parts.append(f"stderr:\n{stderr}")

        if self.artifacts:
            parts.append("artifacts:")
            for a in self.artifacts:
                parts.append(f"  - {a.get('name', 'unknown')} ({a.get('mime_type', '?')})")

        if self.metadata:
            meta = self.metadata
            parts.append(f"duration={meta.get('duration_ms', '?')}ms | truncated={meta.get('truncated', False)}")

        return "\n".join(parts)

    def to_dict(self) -> dict[str, Any]:
        return self._raw


class EnterpriseToolAdapter:
    """Main adapter that wraps Pi's tool dispatch.

    Use this to replace Pi's default tool executors for:
        - read -> SandboxClient.read_file
        - write -> SandboxClient.write_file
        - edit -> SandboxClient.write_file (append/replace mode)
        - bash -> SandboxClient.run_command
        - python -> SandboxClient.run_python
        - grep/find/ls/cat/head/tail -> SandboxClient.run_command

    Example::

        adapter = EnterpriseToolAdapter("http://sandbox:8081")
        result = adapter.execute("bash", {
            "session_id": "sess_001",
            "command": "ls -la",
        })
        pi_context = result.to_pi_context()
    """

    def __init__(
        self,
        sandbox_base_url: str = "http://localhost:8081",
        auth_token: str | None = None,
    ) -> None:
        self.client = SandboxClient(
            base_url=sandbox_base_url,
            auth_token=auth_token,
        )
        self.policy = EnterpriseToolPolicy()

        # Map Pi tool names to handler methods
        self._tool_handlers: dict[str, callable] = {
            "read": self._handle_read,
            "read_file": self._handle_read,
            "write": self._handle_write,
            "write_file": self._handle_write,
            "edit": self._handle_edit,
            "edit_file": self._handle_edit,
            "bash": self._handle_bash,
            "command": self._handle_bash,
            "python": self._handle_python,
            "grep": self._handle_command,
            "find": self._handle_command,
            "ls": self._handle_command,
            "cat": self._handle_command,
            "head": self._handle_command,
            "tail": self._handle_command,
        }

    # ── Main entry point ─────────────────────────────────────────

    def execute(
        self,
        tool_name: str,
        params: dict[str, Any],
    ) -> StandardizedToolResult:
        """Execute a tool call through the adapter.

        Parameters
        ----------
        tool_name : str
            Pi tool name (read, write, bash, python, etc.)
        params : dict
            Tool parameters. Must include at least ``session_id``,
            plus tool-specific fields (path, command, code, content, etc.)

        Returns
        -------
        StandardizedToolResult
        """
        session_id = params.get("session_id", "")
        caller_id = params.get("caller_id", "pi-agent")

        # 1. Policy check
        check = self.policy.check(tool_name, params)
        if not check["allowed"]:
            logger.warning(
                "Tool %s blocked by policy: %s", tool_name, check["reason"],
            )
            return StandardizedToolResult({
                "tool_name": tool_name,
                "status": "denied",
                "stdout_preview": "",
                "stderr_preview": f"Policy denied: {check['reason']}",
                "exit_code": -1,
                "artifacts": [],
                "metadata": {"policy_decision": check},
            })

        # 2. Route to handler
        handler = self._tool_handlers.get(tool_name)
        if handler is None:
            return StandardizedToolResult({
                "tool_name": tool_name,
                "status": "error",
                "stderr_preview": f"No handler for tool: {tool_name}",
                "exit_code": -1,
            })

        try:
            raw_result = handler(session_id, params)
            return StandardizedToolResult(raw_result)
        except Exception as exc:
            logger.exception("Tool %s failed: %s", tool_name, exc)
            return StandardizedToolResult({
                "tool_name": tool_name,
                "status": "error",
                "stderr_preview": str(exc),
                "exit_code": -1,
            })

    # ── Tool handlers ─────────────────────────────────────────────

    def _handle_read(self, session_id: str, params: dict) -> dict[str, Any]:
        path = params.get("path", "")
        offset = params.get("offset")
        limit = params.get("limit")
        result = self.client.read_file(session_id, path, offset, limit)
        return {
            "tool_name": "read",
            "status": "success",
            "stdout_preview": result.get("content", ""),
            "stderr_preview": "",
            "exit_code": 0,
            "artifacts": [],
            "metadata": {
                "size": result.get("size", 0),
                "truncated": result.get("truncated", False),
            },
        }

    def _handle_write(self, session_id: str, params: dict) -> dict[str, Any]:
        path = params.get("path", "")
        content = params.get("content", "")
        mode = params.get("mode", "w")
        result = self.client.write_file(session_id, path, content, mode)
        return {
            "tool_name": "write",
            "status": "success",
            "stdout_preview": f"Written {result.get('size', 0)} bytes to {path}",
            "stderr_preview": "",
            "exit_code": 0,
            "artifacts": [{
                "artifact_id": f"file_{path.replace('/', '_')}",
                "name": path.split("/")[-1],
                "path": path,
                "mime_type": result.get("mime_type", "text/plain"),
            }],
            "metadata": {"size": result.get("size", 0)},
        }

    def _handle_edit(self, session_id: str, params: dict) -> dict[str, Any]:
        """Edit: read existing, apply edit, write back. Simplifies to write."""
        path = params.get("path", "")
        new_content = params.get("content", "")
        return self._handle_write(session_id, {
            "path": path,
            "content": new_content,
            "mode": "w",
        })

    def _handle_bash(self, session_id: str, params: dict) -> dict[str, Any]:
        command = params.get("command", "")
        timeout = params.get("timeout")
        result = self.client.run_command(session_id, command, timeout)
        return {
            "tool_name": "bash",
            "status": "success" if result.get("exit_code") == 0 else "error",
            "stdout_preview": result.get("stdout_preview", ""),
            "stderr_preview": result.get("stderr_preview", ""),
            "exit_code": result.get("exit_code"),
            "artifacts": [],
            "metadata": {
                "duration_ms": result.get("duration_ms", 0.0),
                "truncated": result.get("truncated", False),
            },
        }

    def _handle_python(self, session_id: str, params: dict) -> dict[str, Any]:
        code = params.get("code", "")
        timeout = params.get("timeout")
        result = self.client.run_python(session_id, code, timeout)
        return {
            "tool_name": "python",
            "status": "success" if result.get("exit_code") == 0 else "error",
            "stdout_preview": result.get("stdout_preview", ""),
            "stderr_preview": result.get("stderr_preview", ""),
            "exit_code": result.get("exit_code"),
            "artifacts": [],
            "metadata": {
                "duration_ms": result.get("duration_ms", 0.0),
                "truncated": result.get("truncated", False),
            },
        }

    def _handle_command(self, session_id: str, params: dict) -> dict[str, Any]:
        """Generic command for grep/find/ls/cat/head/tail."""
        command = params.get("command", "")
        # Build command from params if not provided
        if not command:
            tool = params.get("_tool_name", "ls")
            args = params.get("args", params.get("path", "."))
            command = f"{tool} {args}"

        result = self.client.run_command(session_id, command)
        return {
            "tool_name": command.split()[0],
            "status": "success" if result.get("exit_code") == 0 else "error",
            "stdout_preview": result.get("stdout_preview", ""),
            "stderr_preview": result.get("stderr_preview", ""),
            "exit_code": result.get("exit_code"),
            "artifacts": [],
            "metadata": {
                "duration_ms": result.get("duration_ms", 0.0),
            },
        }
