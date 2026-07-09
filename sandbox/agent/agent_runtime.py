"""pi-coding-agent-compatible Python agent runtime (OpenAI tools loop).

Production chat still defaults to Node api-server. This module provides a
working Python-side agent loop against the local sandbox REST API so the
project can cut over incrementally (P5).
"""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

import httpx

from sandbox.agent.message_manager import MessageManager
from sandbox.agent.skill_manager import SkillManager
from sandbox.agent.tool_registry import ToolRegistry
from sandbox.paths import AGENT_SKILL_PATH, AGENT_WORKSPACE_PATH


@dataclass
class AgentTurnResult:
    """Result of one user turn."""

    assistant_text: str = ""
    tool_events: list[dict[str, Any]] = field(default_factory=list)
    artifacts: list[dict[str, Any]] = field(default_factory=list)
    error: str | None = None
    messages: list[dict[str, Any]] = field(default_factory=list)


SANDBOX_TOOL_DEFS = [
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": "Read a file from the private workspace.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "offset": {"type": "integer"},
                    "limit": {"type": "integer"},
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write",
            "description": "Write a private workspace file (does not share with user).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a shell command. High-risk commands may require approval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {"type": "string"},
                    "timeout": {"type": "integer"},
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_artifact",
            "description": "Submit a file as a user deliverable (only way to share files).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "name": {"type": "string"},
                    "mime_type": {"type": "string"},
                },
                "required": ["path"],
            },
        },
    },
]


class AgentRuntime:
    """Python-first agent orchestration using OpenAI-compatible chat + tools."""

    def __init__(
        self,
        *,
        model_id: str | None = None,
        workspace_path: str = AGENT_WORKSPACE_PATH,
        skill_path: str = AGENT_SKILL_PATH,
        sandbox_base_url: str | None = None,
        api_token: str | None = None,
        llm_base_url: str | None = None,
        llm_api_key: str | None = None,
        max_tool_rounds: int = 8,
    ) -> None:
        self.model_id = model_id or os.environ.get("MODEL_ID", "deepseek-v4-flash")
        self.workspace_path = workspace_path
        self.skill_path = skill_path
        self.sandbox_base_url = (
            sandbox_base_url
            or os.environ.get("SANDBOX_BASE_URL", "http://127.0.0.1:8081")
        ).rstrip("/")
        self.api_token = api_token if api_token is not None else os.environ.get("SANDBOX_API_TOKEN", "")
        self.llm_base_url = (
            llm_base_url or os.environ.get("LLMIO_BASE_URL", "")
        ).rstrip("/")
        self.llm_api_key = llm_api_key if llm_api_key is not None else os.environ.get("LLMIO_API_KEY", "")
        self.max_tool_rounds = max_tool_rounds
        self.message_manager = MessageManager()
        self.skill_manager = SkillManager()
        self.tool_registry = ToolRegistry()
        self.tool_registry.register_defaults()
        self._session_id: str | None = None
        self._messages: list[dict[str, Any]] = []
        self._trace_id: str | None = None
        self._on_event: Callable[[dict[str, Any]], None] | None = None

    def _headers(self) -> dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_token:
            h["X-API-Key"] = self.api_token
        if self._trace_id:
            h["X-Trace-Id"] = self._trace_id
        return h

    async def create_session(
        self,
        *,
        conversation_id: str | None = None,
        sandbox_session_id: str | None = None,
        system_prompt_extra: str = "",
        workspace_path_override: str | None = None,
    ) -> str:
        """Create or attach a sandbox session; initialize system prompt."""
        self._trace_id = f"trace_{uuid.uuid4().hex}"
        if sandbox_session_id:
            self._session_id = sandbox_session_id
        else:
            body: dict[str, Any] = {"caller_id": "python-agent-runtime"}
            if conversation_id:
                body["enterprise_session_id"] = conversation_id
            if workspace_path_override:
                body["workspace_path"] = workspace_path_override
            async with httpx.AsyncClient(timeout=60.0) as client:
                resp = await client.post(
                    f"{self.sandbox_base_url}/sessions",
                    headers=self._headers(),
                    json=body,
                )
                resp.raise_for_status()
                data = resp.json()
                self._session_id = data["session_id"]

        skills_block = self.skill_manager.to_prompt()
        system = f"""You are an enterprise coding agent in a secure sandbox.
Workspace (always): {self.workspace_path}
Skills (read-only): {self.skill_path}
Use relative paths. write/edit are private. Use submit_artifact to share files with the user.
{system_prompt_extra}
{skills_block}
"""
        self._messages = [{"role": "system", "content": system}]
        return self._session_id or ""

    async def restore_messages(self, messages: list[dict[str, Any]]) -> None:
        """Load prior user/assistant messages into the agent transcript."""
        hist = self.message_manager.to_agent_history(messages, exclude_last=False)
        # Keep system if present
        system = [m for m in self._messages if m.get("role") == "system"]
        self._messages = system + hist

    async def _call_llm(self, messages: list[dict[str, Any]]) -> dict[str, Any]:
        if not self.llm_base_url or not self.llm_api_key:
            raise RuntimeError("LLMIO_BASE_URL and LLMIO_API_KEY are required for AgentRuntime")
        url = f"{self.llm_base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.llm_api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model_id,
            "messages": messages,
            "tools": SANDBOX_TOOL_DEFS,
            "tool_choice": "auto",
        }
        async with httpx.AsyncClient(timeout=120.0) as client:
            resp = await client.post(url, headers=headers, json=payload)
            resp.raise_for_status()
            return resp.json()

    async def _exec_tool(self, name: str, args: dict[str, Any]) -> str:
        assert self._session_id
        sid = self._session_id
        async with httpx.AsyncClient(timeout=180.0) as client:
            if name == "read":
                q = {"path": args["path"]}
                if args.get("offset") is not None:
                    q["offset"] = args["offset"]
                if args.get("limit") is not None:
                    q["limit"] = args["limit"]
                r = await client.get(
                    f"{self.sandbox_base_url}/sessions/{sid}/files/read",
                    headers=self._headers(),
                    params=q,
                )
                r.raise_for_status()
                return r.json().get("content") or ""
            if name == "write":
                r = await client.post(
                    f"{self.sandbox_base_url}/sessions/{sid}/files/write",
                    headers=self._headers(),
                    json={"path": args["path"], "content": args["content"]},
                )
                r.raise_for_status()
                return f"Written {r.json().get('size', 0)} bytes to {args['path']}"
            if name == "bash":
                r = await client.post(
                    f"{self.sandbox_base_url}/sessions/{sid}/executions/command",
                    headers=self._headers(),
                    json={"command": args["command"], "timeout": args.get("timeout") or 120},
                )
                r.raise_for_status()
                data = r.json()
                return (
                    f"exit={data.get('exit_code')}\n"
                    f"STDOUT:\n{data.get('stdout_preview') or ''}\n"
                    f"STDERR:\n{data.get('stderr_preview') or ''}"
                )
            if name == "submit_artifact":
                name_ = args.get("name") or args["path"].split("/")[-1]
                r = await client.post(
                    f"{self.sandbox_base_url}/sessions/{sid}/artifacts/submit",
                    headers=self._headers(),
                    json={
                        "name": name_,
                        "path": args["path"],
                        "mime_type": args.get("mime_type") or "application/octet-stream",
                    },
                )
                r.raise_for_status()
                data = r.json()
                return json.dumps(data)
        return f"Unknown tool: {name}"

    def _emit(self, event: dict[str, Any]) -> None:
        if self._on_event:
            self._on_event(event)

    async def prompt(self, text: str) -> AgentTurnResult:
        """Run one user prompt turn (aggregate result)."""
        result = AgentTurnResult()
        events: list[dict[str, Any]] = []

        def capture(ev: dict[str, Any]) -> None:
            events.append(ev)

        self._on_event = capture
        try:
            async for ev in self.stream_prompt(text):
                if ev.get("type") == "token":
                    result.assistant_text += ev.get("text") or ""
                if ev.get("type") == "file_ready":
                    result.artifacts.append(ev)
                if ev.get("type") == "tool_end":
                    result.tool_events.append(ev)
                if ev.get("type") == "error":
                    result.error = ev.get("message")
        finally:
            self._on_event = None
        result.messages = list(self._messages)
        return result

    async def stream_prompt(self, text: str) -> AsyncIterator[dict[str, Any]]:
        """Stream SSE-compatible events for one user turn."""
        if not self._session_id:
            await self.create_session()

        self._messages.append({"role": "user", "content": text})
        yield {"type": "session", "session_id": self._session_id, "trace_id": self._trace_id}

        for _round in range(self.max_tool_rounds):
            try:
                data = await self._call_llm(self._messages)
            except Exception as exc:
                yield {"type": "error", "message": str(exc)}
                return

            choice = (data.get("choices") or [{}])[0]
            msg = choice.get("message") or {}
            content = msg.get("content") or ""
            tool_calls = msg.get("tool_calls") or []

            if content:
                yield {"type": "token", "text": content}

            # Append assistant message for transcript
            self._messages.append(msg)

            if not tool_calls:
                yield {"type": "done"}
                return

            for tc in tool_calls:
                fn = tc.get("function") or {}
                name = fn.get("name") or "tool"
                raw_args = fn.get("arguments") or "{}"
                try:
                    args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
                except json.JSONDecodeError:
                    args = {}
                tid = tc.get("id") or f"call_{uuid.uuid4().hex[:8]}"
                yield {"type": "tool_start", "id": tid, "name": name, "args": args}
                try:
                    tool_result = await self._exec_tool(name, args)
                    is_error = tool_result.startswith("Error") or tool_result.startswith("Unknown")
                except Exception as exc:
                    tool_result = f"Error: {exc}"
                    is_error = True
                yield {
                    "type": "tool_end",
                    "id": tid,
                    "name": name,
                    "result": tool_result,
                    "isError": is_error,
                }
                if name == "submit_artifact" and not is_error:
                    try:
                        art = json.loads(tool_result)
                        yield {
                            "type": "file_ready",
                            "artifact_id": art.get("artifact_id"),
                            "path": art.get("path"),
                            "name": art.get("name"),
                            "mime_type": art.get("mime_type"),
                            "size": art.get("size"),
                        }
                    except Exception:
                        pass
                self._messages.append({
                    "role": "tool",
                    "tool_call_id": tid,
                    "content": tool_result,
                })

        yield {"type": "done"}

    async def close(self) -> None:
        """Release agent session resources (sandbox session kept for reuse)."""
        return None
