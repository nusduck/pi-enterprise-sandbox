"""Agent router: single restore path + session_closed + empty message."""

from __future__ import annotations

import json
from typing import Any, AsyncIterator
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from sandbox.main import app


class _FakeRuntime:
    def __init__(self, **kwargs: Any) -> None:
        self._session_id = "sandbox_fake"
        self._conversation_id = kwargs.get("conversation_id")
        self._messages: list[dict[str, Any]] = [{"role": "system", "content": "sys"}]
        self.restored: list[list[dict[str, Any]]] = []
        self.prompts: list[str] = []
        self.trace_ids: list[str | None] = []
        self.persisted: list[tuple[list[dict[str, Any]], str]] = []

    async def create_session(self, **kwargs: Any) -> str:
        self.trace_ids.append(kwargs.get("trace_id"))
        self._conversation_id = kwargs.get("conversation_id")
        return self._session_id or ""

    async def restore_messages(
        self, messages: list[dict[str, Any]], *, exclude_last: bool = False
    ) -> None:
        self.restored.append(list(messages))

    async def stream_prompt(self, text: str) -> AsyncIterator[dict[str, Any]]:
        self.prompts.append(text)
        yield {"type": "trace", "trace_id": "t1"}
        yield {
            "type": "session",
            "session_id": self._session_id,
            "conversation_id": self._conversation_id,
            "workspace_path": "/home/sandbox/workspace",
            "trace_id": "t1",
        }
        yield {"type": "token", "text": f"echo:{text}"}
        yield {"type": "done"}

    async def persist_turn_messages(
        self, client_messages: list[dict[str, Any]], assistant_text: str = ""
    ) -> None:
        self.persisted.append((list(client_messages), assistant_text))


@pytest.fixture
def client():
    return TestClient(app)


def test_agent_chat_restores_prior_only_once(client: TestClient):
    fake = _FakeRuntime()

    def factory(**kwargs: Any) -> _FakeRuntime:
        return fake

    with patch("sandbox.routers.agent_router.AgentRuntime", side_effect=factory):
        with client.stream(
            "POST",
            "/agent/chat",
            json={
                "conversation_id": "conv_r1",
                "messages": [
                    {"role": "user", "content": "first"},
                    {"role": "assistant", "content": "ok"},
                    {"role": "user", "content": "second"},
                ],
            },
            headers={"X-Trace-Id": "trace-from-bff"},
        ) as resp:
            assert resp.status_code == 200
            body = "".join(resp.iter_text())

    assert len(fake.restored) == 1
    assert [m["content"] for m in fake.restored[0]] == ["first", "ok"]
    assert fake.prompts == ["second"]
    assert fake.trace_ids == ["trace-from-bff"]
    assert len(fake.persisted) == 1
    persisted_msgs, assistant_text = fake.persisted[0]
    assert [m["content"] for m in persisted_msgs] == ["first", "ok", "second"]
    assert assistant_text == "echo:second"

    events = []
    for line in body.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))
    types = [e["type"] for e in events]
    assert "token" in types
    assert "done" in types
    assert types[-1] == "session_closed"
    assert events[-1].get("session_id") == "sandbox_fake"


def test_agent_chat_empty_message(client: TestClient):
    fake = _FakeRuntime()

    with patch("sandbox.routers.agent_router.AgentRuntime", return_value=fake):
        with client.stream(
            "POST",
            "/agent/chat",
            json={"messages": [{"role": "user", "content": "   "}]},
        ) as resp:
            body = "".join(resp.iter_text())

    events = [
        json.loads(line[6:])
        for line in body.splitlines()
        if line.startswith("data: ")
    ]
    types = [e["type"] for e in events]
    assert "error" in types
    assert "done" in types
    assert types[-1] == "session_closed"
    assert fake.prompts == []
