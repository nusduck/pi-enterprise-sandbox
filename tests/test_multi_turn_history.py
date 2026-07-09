"""Unit tests for multi-turn history conversion helpers (Node logic mirrored in pure Python).

The production converter lives in api-server/routes/chat.js. These tests document
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
    r = client.post("/conversations", json={"title": "bind"})
    conv = r.json()
    cid = conv["id"]
    assert conv["workspace_path"]

    s = client.post(
        "/sessions",
        json={
            "caller_id": "pi-coding-agent",
            "enterprise_session_id": cid,
            "workspace_path": conv["workspace_path"],
        },
    )
    assert s.status_code == 201
    sid = s.json()["session_id"]

    u = client.patch(
        f"/conversations/{cid}",
        json={"sandbox_session_id": sid},
    )
    assert u.status_code == 200
    assert u.json()["sandbox_session_id"] == sid

    # Re-fetch session still RUNNING
    gs = client.get(f"/sessions/{sid}")
    assert gs.status_code == 200
    assert gs.json()["status"] == "RUNNING"
