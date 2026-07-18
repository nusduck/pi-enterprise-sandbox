"""Unit tests for multi-turn history conversion helpers (Node logic mirrored in pure Python).

The production converter lives in the Node Agent Run Host. These tests document
the expected contract and exercise the conversation message persistence path.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.main import app


client = TestClient(app)


def test_conversation_message_persistence_roundtrip():
    # Create conversation
    r = client.post("/conversations", json={"title": "multi-turn"})
    assert r.status_code == 201
    conv = r.json()
    cid = conv["id"]
    assert conv["messages"] == []

    messages = [
        {"role": "user", "content": "My favorite color is blue."},
        {"role": "assistant", "content": "Got it, blue."},
        {"role": "user", "content": "What is my favorite color?"},
    ]
    u = client.patch(f"/conversations/{cid}", json={"messages": messages})
    assert u.status_code == 200
    assert u.json()["messages"] == messages

    g = client.get(f"/conversations/{cid}")
    assert g.status_code == 200
    assert g.json()["messages"][0]["content"] == "My favorite color is blue."

    # Partial patch must not wipe messages when messages omitted
    u2 = client.patch(
        f"/conversations/{cid}",
        json={"sandbox_session_id": "sandbox_test123"},
    )
    assert u2.status_code == 200
    assert u2.json()["sandbox_session_id"] == "sandbox_test123"
    assert len(u2.json()["messages"]) == 3


def test_conversation_binds_workspace_and_session():
    """Conversation does not own workspace; Session owns formal workspace_id.

    Conversation create must leave workspace_id unset. A formal Sandbox Session
    is created with agent_session_id + workspace_id; Conversation is then PATCHed
    only as a pointer (agent/sandbox/workspace ids).
    """
    from tests.conftest import formal_id, session_create_payload

    r = client.post("/conversations", json={"title": "bind"})
    assert r.status_code == 201, r.text
    conv = r.json()
    cid = conv["id"]
    # Conversation does not invent / own a workspace identity.
    assert conv.get("workspace_id") in (None, "")

    agent = formal_id("AGT")
    wsp = formal_id("WSP")
    s = client.post(
        "/sessions",
        json=session_create_payload(
            "pi-coding-agent",
            agent_session_id=agent,
            workspace_id=wsp,
            enterprise_session_id=cid,
            conversation_id=cid,
        ),
    )
    assert s.status_code == 201, s.text
    body = s.json()
    sid = body["session_id"]
    assert body["workspace_id"] == wsp
    assert body["agent_session_id"] == agent

    u = client.patch(
        f"/conversations/{cid}",
        json={
            "sandbox_session_id": sid,
            "agent_session_id": agent,
            "workspace_id": wsp,
        },
    )
    assert u.status_code == 200, u.text
    patched = u.json()
    assert patched["sandbox_session_id"] == sid
    assert patched["agent_session_id"] == agent
    assert patched["workspace_id"] == wsp

    # Re-fetch session still RUNNING; Conversation remains a pointer only.
    gs = client.get(f"/sessions/{sid}")
    assert gs.status_code == 200
    assert gs.json()["status"] == "RUNNING"
    assert gs.json()["workspace_id"] == wsp
