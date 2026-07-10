"""pi-coding-agent-compatible Python agent runtime (OpenAI tools loop).

Production chat still defaults to Node api-server. This module provides a
working Python-side agent loop against the local sandbox REST API so the
project can cut over incrementally via AGENT_RUNTIME=python (P5).
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

import httpx

from sandbox.agent.message_manager import MessageManager
from sandbox.agent.skill_manager import SkillManager
from sandbox.agent.tool_registry import ToolRegistry
from sandbox.paths import AGENT_SKILL_PATH, AGENT_WORKSPACE_PATH

APPROVAL_POLL_S = 1.5
APPROVAL_MAX_WAIT_S = 5 * 60


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
            "name": "edit",
            "description": (
                "Find-and-replace edit on a private workspace file. "
                "Does not share the file with the user."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "old_string": {"type": "string"},
                    "new_string": {"type": "string"},
                },
                "required": ["path", "old_string", "new_string"],
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
        approval_poll_s: float = APPROVAL_POLL_S,
        approval_max_wait_s: float = APPROVAL_MAX_WAIT_S,
    ) -> None:
        self.model_id = model_id or os.environ.get("MODEL_ID", "deepseek-v4-flash")
        self.workspace_path = workspace_path
        self.skill_path = skill_path
        self.sandbox_base_url = (
            sandbox_base_url
            or os.environ.get("SANDBOX_INTERNAL_URL")
            or os.environ.get("SANDBOX_BASE_URL", "http://127.0.0.1:8081")
        ).rstrip("/")
        self.api_token = api_token if api_token is not None else os.environ.get("SANDBOX_API_TOKEN", "")
        self.llm_base_url = (
            llm_base_url or os.environ.get("LLMIO_BASE_URL", "")
        ).rstrip("/")
        self.llm_api_key = llm_api_key if llm_api_key is not None else os.environ.get("LLMIO_API_KEY", "")
        self.max_tool_rounds = max_tool_rounds
        self.approval_poll_s = approval_poll_s
        self.approval_max_wait_s = approval_max_wait_s
        self.message_manager = MessageManager()
        self.skill_manager = SkillManager()
        self.tool_registry = ToolRegistry()
        self.tool_registry.register_defaults()
        self._session_id: str | None = None
        self._conversation_id: str | None = None
        self._session_reused: bool = False
        self._messages: list[dict[str, Any]] = []
        self._trace_id: str | None = None
        self._on_event: Callable[[dict[str, Any]], None] | None = None

    def set_trace_id(self, trace_id: str | None) -> str:
        """Set or generate an end-to-end trace id for sandbox calls."""
        if trace_id:
            self._trace_id = str(trace_id)
        elif not self._trace_id:
            self._trace_id = f"trace_{uuid.uuid4().hex}"
        return self._trace_id or ""

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
        trace_id: str | None = None,
    ) -> str:
        """Create or attach a sandbox session; initialize system prompt.

        Resolves conversation workspace and reuses a RUNNING sandbox session
        when possible (parity with Node handleChat).
        """
        self.set_trace_id(trace_id)
        self._conversation_id = conversation_id
        self._session_reused = False
        target_workspace = workspace_path_override
        sid = sandbox_session_id

        async with httpx.AsyncClient(timeout=60.0) as client:
            # Resolve conversation if provided
            if conversation_id and not (sid and target_workspace):
                try:
                    resp = await client.get(
                        f"{self.sandbox_base_url}/conversations/{conversation_id}",
                        headers=self._headers(),
                    )
                    if resp.status_code == 200:
                        conv = resp.json()
                        target_workspace = target_workspace or conv.get("workspace_path")
                        if not sid and conv.get("sandbox_session_id"):
                            try:
                                sresp = await client.get(
                                    f"{self.sandbox_base_url}/sessions/{conv['sandbox_session_id']}",
                                    headers=self._headers(),
                                )
                                if sresp.status_code == 200:
                                    existing = sresp.json()
                                    if existing.get("status") == "RUNNING" and existing.get("session_id"):
                                        sid = existing["session_id"]
                                        self._session_reused = True
                            except Exception:
                                pass
                    elif resp.status_code == 404:
                        # Create conversation so multi-turn has a stable id
                        cresp = await client.post(
                            f"{self.sandbox_base_url}/conversations",
                            headers=self._headers(),
                            json={"id": conversation_id},
                        )
                        if cresp.status_code in (200, 201):
                            conv = cresp.json()
                            self._conversation_id = conv.get("id") or conversation_id
                            target_workspace = target_workspace or conv.get("workspace_path")
                except Exception:
                    pass

            if not self._conversation_id and not conversation_id:
                try:
                    cresp = await client.post(
                        f"{self.sandbox_base_url}/conversations",
                        headers=self._headers(),
                        json={"title": "New conversation"},
                    )
                    if cresp.status_code in (200, 201):
                        conv = cresp.json()
                        self._conversation_id = conv.get("id")
                        target_workspace = target_workspace or conv.get("workspace_path")
                except Exception:
                    pass

            if sid:
                self._session_id = sid
            else:
                body: dict[str, Any] = {"caller_id": "python-agent-runtime"}
                if self._conversation_id:
                    body["enterprise_session_id"] = self._conversation_id
                if target_workspace:
                    body["workspace_path"] = target_workspace
                resp = await client.post(
                    f"{self.sandbox_base_url}/sessions",
                    headers=self._headers(),
                    json=body,
                )
                resp.raise_for_status()
                data = resp.json()
                self._session_id = data["session_id"]
                if not target_workspace:
                    target_workspace = data.get("workspace_path")

                # Bind session onto conversation for next turn
                if self._conversation_id:
                    try:
                        await client.patch(
                            f"{self.sandbox_base_url}/conversations/{self._conversation_id}",
                            headers=self._headers(),
                            json={
                                "sandbox_session_id": self._session_id,
                                "workspace_path": target_workspace,
                            },
                        )
                    except Exception:
                        pass

        skills_block = self.skill_manager.to_prompt()
        system = f"""You are an enterprise coding agent in a secure sandbox.
Workspace (always): {self.workspace_path}
Skills (read-only): {self.skill_path}
Use relative paths. write/edit are private. Use submit_artifact to share files with the user.

## Multi-turn context
Prior user/assistant messages in this conversation may already be in your transcript.
Continue the task with that context; do not ask the user to repeat earlier details.

## File Sharing (Artifact-only delivery)
Available tools: read, write, edit, bash, submit_artifact.
write/edit/bash only touch the private workspace. To share a file, call submit_artifact.
{system_prompt_extra}
{skills_block}
"""
        self._messages = [{"role": "system", "content": system}]
        return self._session_id or ""

    async def restore_messages(self, messages: list[dict[str, Any]], *, exclude_last: bool = False) -> None:
        """Load prior user/assistant messages into the agent transcript.

        When prompting with the latest user text separately, pass only *prior*
        messages (or set exclude_last=True) so the last user turn is not doubled.
        """
        hist = self.message_manager.to_agent_history(messages, exclude_last=exclude_last)
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
        if self._trace_id:
            headers["X-Trace-Id"] = self._trace_id
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

    async def _approval_gate(
        self, tool_name: str, params: dict[str, Any]
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield approval_required events; final yield is a gate result dict with type=_gate."""
        assert self._session_id
        sid = self._session_id
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                r = await client.post(
                    f"{self.sandbox_base_url}/sessions/{sid}/executions/approval-check",
                    headers=self._headers(),
                    json={
                        "tool_name": tool_name,
                        "command": params.get("command"),
                        "path": params.get("path"),
                        "timeout": params.get("timeout"),
                    },
                )
                # 200 approved/rejected, 202 pending
                if r.status_code >= 400:
                    if tool_name == "bash":
                        yield {
                            "type": "_gate",
                            "ok": False,
                            "reason": f"Approval check failed: HTTP {r.status_code}",
                        }
                        return
                    yield {"type": "_gate", "ok": True}
                    return
                check = r.json()
        except Exception as exc:
            if tool_name == "bash":
                yield {
                    "type": "_gate",
                    "ok": False,
                    "reason": f"Approval check failed: {exc}",
                }
                return
            yield {"type": "_gate", "ok": True}
            return

        status = check.get("status")
        if status == "approved":
            yield {"type": "_gate", "ok": True}
            return
        if status == "rejected":
            yield {
                "type": "_gate",
                "ok": False,
                "reason": check.get("reason") or "Rejected by policy",
            }
            return
        if status != "pending_approval" or not check.get("approval_id"):
            yield {
                "type": "_gate",
                "ok": False,
                "reason": check.get("reason") or "Not allowed",
            }
            return

        approval_id = check["approval_id"]
        yield {
            "type": "approval_required",
            "approval_id": approval_id,
            "tool_name": tool_name,
            "command": params.get("command"),
            "path": params.get("path"),
            "reason": check.get("reason"),
            "risk_level": check.get("risk_level"),
        }

        deadline = time.monotonic() + self.approval_max_wait_s
        while time.monotonic() < deadline:
            await asyncio.sleep(self.approval_poll_s)
            try:
                async with httpx.AsyncClient(timeout=30.0) as client:
                    st_r = await client.get(
                        f"{self.sandbox_base_url}/approvals/{approval_id}",
                        headers=self._headers(),
                    )
                    if st_r.status_code >= 400:
                        continue
                    st = st_r.json()
                if st.get("status") == "approved":
                    yield {"type": "_gate", "ok": True, "approval_id": approval_id}
                    return
                if st.get("status") == "rejected":
                    yield {
                        "type": "_gate",
                        "ok": False,
                        "reason": st.get("reason") or "Rejected by operator",
                        "approval_id": approval_id,
                    }
                    return
            except Exception:
                continue
        yield {
            "type": "_gate",
            "ok": False,
            "reason": "Approval timed out",
            "approval_id": approval_id,
        }

    async def _exec_tool(self, name: str, args: dict[str, Any]) -> str:
        assert self._session_id
        sid = self._session_id
        async with httpx.AsyncClient(timeout=180.0) as client:
            if name == "read":
                q: dict[str, Any] = {"path": args["path"]}
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
            if name == "edit":
                # read → replace last occurrence → write (mirrors Node edit tool)
                path = args["path"]
                old = args.get("old_string") or ""
                new = args.get("new_string") if args.get("new_string") is not None else ""
                r = await client.get(
                    f"{self.sandbox_base_url}/sessions/{sid}/files/read",
                    headers=self._headers(),
                    params={"path": path},
                )
                r.raise_for_status()
                content = r.json().get("content") or ""
                idx = content.rfind(old)
                if idx == -1:
                    return f"Error: old_string not found in {path}"
                new_content = content[:idx] + new + content[idx + len(old) :]
                w = await client.post(
                    f"{self.sandbox_base_url}/sessions/{sid}/files/write",
                    headers=self._headers(),
                    json={"path": path, "content": new_content},
                )
                w.raise_for_status()
                return f"Replaced in {path}"
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

        def capture(ev: dict[str, Any]) -> None:
            pass

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

        self.set_trace_id(self._trace_id)
        yield {"type": "trace", "trace_id": self._trace_id}
        yield {
            "type": "session",
            "session_id": self._session_id,
            "workspace_path": self.workspace_path,
            "conversation_id": self._conversation_id,
            "session_reused": self._session_reused,
            "trace_id": self._trace_id,
        }

        self._messages.append({"role": "user", "content": text})

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

                # Approval gate for bash (fail-closed) — mirrors Node sandbox-tools
                if name == "bash":
                    gate_ok = True
                    gate_reason = ""
                    async for gev in self._approval_gate(name, args):
                        if gev.get("type") == "approval_required":
                            yield gev
                        elif gev.get("type") == "_gate":
                            gate_ok = bool(gev.get("ok"))
                            gate_reason = gev.get("reason") or ""
                    if not gate_ok:
                        tool_result = f"Blocked (approval): {gate_reason}"
                        yield {
                            "type": "tool_end",
                            "id": tid,
                            "name": name,
                            "result": tool_result,
                            "isError": True,
                        }
                        self._messages.append({
                            "role": "tool",
                            "tool_call_id": tid,
                            "content": tool_result,
                        })
                        continue

                try:
                    tool_result = await self._exec_tool(name, args)
                    is_error = (
                        tool_result.startswith("Error")
                        or tool_result.startswith("Unknown")
                    )
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
                            "path": art.get("path") or args.get("path"),
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

    async def persist_turn_messages(
        self,
        client_messages: list[dict[str, Any]],
        assistant_text: str = "",
    ) -> None:
        """Patch conversation DB with client history + this assistant turn.

        Mirrors Node handleChat post-turn persistence so reload/list still
        show messages when AGENT_RUNTIME=python. Failures are swallowed —
        SSE already completed for the user.
        """
        cid = self._conversation_id
        if not cid:
            return
        persisted = self.message_manager.to_persistable(client_messages or [])
        text = (assistant_text or "").strip()
        if text:
            persisted.append({"role": "assistant", "content": text})
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                await client.patch(
                    f"{self.sandbox_base_url}/conversations/{cid}",
                    headers=self._headers(),
                    json={
                        "messages": persisted,
                        "sandbox_session_id": self._session_id,
                    },
                )
        except Exception:
            pass

    async def close(self) -> None:
        """Release agent session resources (sandbox session kept for reuse)."""
        return None
