"""Python agent runtime parity: restore, event types, approval, cancel path."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock

import pytest

from sandbox.agent.agent_runtime import SANDBOX_TOOL_DEFS, AgentRuntime
from sandbox.agent.message_manager import MessageManager

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "sse_events.json"


@pytest.mark.asyncio
async def test_stream_prompt_emits_contract_event_types_without_tools():
    runtime = AgentRuntime(
        llm_base_url="http://llm.test",
        llm_api_key="test-key",
        sandbox_base_url="http://sandbox.test",
    )
    runtime._session_id = "sandbox_test"
    runtime._conversation_id = "conv_1"
    runtime._trace_id = "trace_fixed"
    runtime._messages = [{"role": "system", "content": "sys"}]

    async def fake_llm(_messages: list[dict[str, Any]]) -> dict[str, Any]:
        return {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": "hello from mock",
                        "tool_calls": [],
                    }
                }
            ]
        }

    runtime._call_llm = fake_llm  # type: ignore[method-assign]

    events = []
    async for ev in runtime.stream_prompt("hi"):
        events.append(ev)

    types = [e["type"] for e in events]
    assert types[0] == "trace"
    assert types[1] == "session"
    assert "token" in types
    assert types[-1] == "done"
    assert events[1]["session_id"] == "sandbox_test"
    assert events[1]["conversation_id"] == "conv_1"
    assert events[1]["trace_id"] == "trace_fixed"
    assert any(e.get("text") == "hello from mock" for e in events if e["type"] == "token")

    required = set(json.loads(FIXTURE.read_text())["required_event_types"])
    # This path does not exercise tool/approval/file_ready — only check emitted ⊆ required
    assert set(types) <= required


@pytest.mark.asyncio
async def test_restore_messages_does_not_double_last_user_when_prior_only():
    runtime = AgentRuntime(llm_base_url="http://x", llm_api_key="k")
    runtime._messages = [{"role": "system", "content": "sys"}]
    prior = [
        {"role": "user", "content": "color is teal"},
        {"role": "assistant", "content": "ok"},
    ]
    await runtime.restore_messages(prior, exclude_last=False)
    roles = [m["role"] for m in runtime._messages]
    assert roles == ["system", "user", "assistant"]
    # stream_prompt will append the new user message once
    runtime._session_id = "s1"
    runtime._trace_id = "t1"

    async def fake_llm(messages: list[dict[str, Any]]) -> dict[str, Any]:
        # Last user should appear exactly once
        users = [m for m in messages if m.get("role") == "user"]
        assert sum(1 for u in users if u.get("content") == "what color?") == 1
        return {
            "choices": [{"message": {"role": "assistant", "content": "teal", "tool_calls": []}}]
        }

    runtime._call_llm = fake_llm  # type: ignore[method-assign]
    async for _ in runtime.stream_prompt("what color?"):
        pass


@pytest.mark.asyncio
async def test_tool_defs_include_edit_and_submit_artifact():
    names = {d["function"]["name"] for d in SANDBOX_TOOL_DEFS}
    assert names == {"read", "write", "edit", "bash", "submit_artifact"}


@pytest.mark.asyncio
async def test_bash_approval_required_event_and_block():
    runtime = AgentRuntime(
        llm_base_url="http://llm.test",
        llm_api_key="k",
        sandbox_base_url="http://sandbox.test",
        approval_poll_s=0.01,
        approval_max_wait_s=0.05,
    )
    runtime._session_id = "sandbox_appr"
    runtime._trace_id = "trace_a"
    runtime._messages = [{"role": "system", "content": "sys"}]

    call_count = {"n": 0}

    async def fake_llm(_messages: list[dict[str, Any]]) -> dict[str, Any]:
        call_count["n"] += 1
        if call_count["n"] == 1:
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "call_bash",
                                    "type": "function",
                                    "function": {
                                        "name": "bash",
                                        "arguments": json.dumps({"command": "rm -rf /tmp/x"}),
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        return {
            "choices": [
                {"message": {"role": "assistant", "content": "blocked", "tool_calls": []}}
            ]
        }

    runtime._call_llm = fake_llm  # type: ignore[method-assign]

    async def fake_gate(_name: str, _params: dict[str, Any]):
        yield {
            "type": "approval_required",
            "approval_id": "approval_test",
            "tool_name": "bash",
            "command": "rm -rf /tmp/x",
            "reason": "high risk",
            "risk_level": "high",
        }
        yield {"type": "_gate", "ok": False, "reason": "Rejected by operator"}

    runtime._approval_gate = fake_gate  # type: ignore[method-assign]
    runtime._exec_tool = AsyncMock(side_effect=AssertionError("should not exec"))  # type: ignore

    events = []
    async for ev in runtime.stream_prompt("do danger"):
        events.append(ev)

    types = [e["type"] for e in events]
    assert "approval_required" in types
    assert "tool_start" in types
    assert "tool_end" in types
    blocked = next(e for e in events if e["type"] == "tool_end")
    assert blocked["isError"] is True
    assert "Blocked (approval)" in blocked["result"]
    runtime._exec_tool.assert_not_called()


@pytest.mark.asyncio
async def test_submit_artifact_emits_file_ready():
    runtime = AgentRuntime(
        llm_base_url="http://llm.test",
        llm_api_key="k",
        sandbox_base_url="http://sandbox.test",
    )
    runtime._session_id = "sandbox_art"
    runtime._trace_id = "trace_b"
    runtime._messages = [{"role": "system", "content": "sys"}]
    n = {"i": 0}

    async def fake_llm(_messages: list[dict[str, Any]]) -> dict[str, Any]:
        n["i"] += 1
        if n["i"] == 1:
            return {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": "",
                            "tool_calls": [
                                {
                                    "id": "c1",
                                    "function": {
                                        "name": "submit_artifact",
                                        "arguments": '{"path":"out.txt","name":"out.txt"}',
                                    },
                                }
                            ],
                        }
                    }
                ]
            }
        return {
            "choices": [{"message": {"role": "assistant", "content": "done", "tool_calls": []}}]
        }

    async def fake_exec(name: str, args: dict[str, Any]) -> str:
        assert name == "submit_artifact"
        return json.dumps(
            {
                "artifact_id": "art_1",
                "path": args["path"],
                "name": "out.txt",
                "mime_type": "text/plain",
                "size": 3,
            }
        )

    runtime._call_llm = fake_llm  # type: ignore[method-assign]
    runtime._exec_tool = fake_exec  # type: ignore[method-assign]

    events = []
    async for ev in runtime.stream_prompt("submit"):
        events.append(ev)

    fr = next(e for e in events if e["type"] == "file_ready")
    assert fr["artifact_id"] == "art_1"
    assert fr["path"] == "out.txt"


def test_message_manager_exclude_last_default_for_node_parity():
    mm = MessageManager()
    msgs = [
        {"role": "user", "content": "a"},
        {"role": "assistant", "content": "b"},
        {"role": "user", "content": "c"},
    ]
    hist = mm.to_agent_history(msgs, exclude_last=True)
    assert [m["content"] for m in hist] == ["a", "b"]


@pytest.mark.asyncio
async def test_set_trace_id_propagates_to_headers():
    runtime = AgentRuntime()
    tid = runtime.set_trace_id("from-bff-trace")
    assert tid == "from-bff-trace"
    assert runtime._headers()["X-Trace-Id"] == "from-bff-trace"


@pytest.mark.asyncio
async def test_persist_turn_messages_patches_conversation(httpx_mock):
    """Post-turn persistence mirrors Node handleChat conversation patch."""
    runtime = AgentRuntime(sandbox_base_url="http://sandbox.test")
    runtime._conversation_id = "conv_persist"
    runtime._session_id = "sandbox_p1"
    runtime.set_trace_id("trace_p")

    httpx_mock.add_response(
        method="PATCH",
        url="http://sandbox.test/conversations/conv_persist",
        json={
            "id": "conv_persist",
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": "hello"},
            ],
        },
    )

    await runtime.persist_turn_messages(
        [{"role": "user", "content": "hi"}],
        "hello",
    )

    req = httpx_mock.get_request()
    assert req is not None
    assert req.method == "PATCH"
    body = json.loads(req.content.decode())
    assert body["messages"] == [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "hello"},
    ]
    assert body["sandbox_session_id"] == "sandbox_p1"


@pytest.mark.asyncio
async def test_persist_turn_messages_noop_without_conversation():
    runtime = AgentRuntime(sandbox_base_url="http://sandbox.test")
    runtime._conversation_id = None
    # Must not raise or attempt HTTP
    await runtime.persist_turn_messages([{"role": "user", "content": "x"}], "y")
