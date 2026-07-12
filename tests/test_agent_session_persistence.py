"""B1 Agent Session Persistence — schema, repository, restore JSONL, fail-closed."""

from __future__ import annotations

import json
import sqlite3

import pytest
from fastapi.testclient import TestClient

from sandbox.database import Database
from sandbox.main import app
from sandbox.models import AgentSessionStatus
from sandbox.repositories import AgentSessionRepository, ConversationRepository
from sandbox.services.agent_session_manager import AgentSessionManager


client = TestClient(app)


@pytest.fixture
def db(tmp_path):
    database = Database(f"sqlite:///{tmp_path / 'asess.db'}")
    database.initialize()
    return database


@pytest.fixture
def mgr(db):
    return AgentSessionManager(
        sessions=AgentSessionRepository(db),
        conversations=ConversationRepository(db),
    )


@pytest.fixture
def conversation(db):
    repo = ConversationRepository(db)
    return repo.upsert(
        {
            "id": "conv_asess_1",
            "title": "Session persistence",
            "messages": [],
            "owner_user_id": "u1",
            "organization_id": "org1",
        }
    )


def test_schema_has_agent_session_tables(db, tmp_path):
    with sqlite3.connect(tmp_path / "asess.db") as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(conversations)").fetchall()
        }
        sess_cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(agent_sessions)").fetchall()
        }
        entry_cols = {
            row[1]
            for row in conn.execute(
                "PRAGMA table_info(agent_session_entries)"
            ).fetchall()
        }
    assert "agent_sessions" in tables
    assert "agent_session_entries" in tables
    assert "agent_session_id" in cols
    assert {
        "id",
        "conversation_id",
        "sdk_session_id",
        "header_payload",
        "session_schema_version",
    }.issubset(sess_cols)
    assert {
        "id",
        "agent_session_id",
        "sequence",
        "entry_type",
        "entry_payload",
        "parent_entry_id",
    }.issubset(entry_cols)


def test_migrate_agent_session_adds_tables_idempotent(tmp_path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'New conversation',
                sandbox_session_id TEXT,
                workspace_path TEXT,
                messages TEXT NOT NULL DEFAULT '[]',
                owner_user_id TEXT,
                organization_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.commit()

    db = Database(f"sqlite:///{path}")
    r1 = db.migrate_agent_session()
    r2 = db.migrate_agent_session()
    assert r1["tables_ensured"] >= 5
    assert r2["columns_added"] == 0

    with sqlite3.connect(path) as conn:
        tables = {
            row[0]
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(conversations)").fetchall()
        }
    assert "agent_sessions" in tables
    assert "agent_session_entries" in tables
    assert "agent_session_id" in cols


def test_create_bind_and_resume_jsonl(mgr, conversation):
    session = mgr.create_session(
        conversation_id=conversation.id,
        sdk_session_id="sdk-abc",
        model_id="test-model",
        header_payload={
            "type": "session",
            "version": 3,
            "id": "sdk-abc",
            "timestamp": "2026-07-12T00:00:00.000Z",
            "cwd": "/tmp",
        },
    )
    assert session.id.startswith("asess_")
    assert session.conversation_id == conversation.id

    # Conversation is bound
    conv = ConversationRepository(mgr.conversations.db).get(conversation.id)
    assert conv is not None
    assert conv.agent_session_id == session.id

    # Multi-turn entries: user, assistant+toolCall, toolResult, compaction
    user = {
        "type": "message",
        "id": "e1",
        "parentId": None,
        "timestamp": "2026-07-12T00:00:01.000Z",
        "message": {"role": "user", "content": "list files", "timestamp": 1},
    }
    assistant = {
        "type": "message",
        "id": "e2",
        "parentId": "e1",
        "timestamp": "2026-07-12T00:00:02.000Z",
        "message": {
            "role": "assistant",
            "content": [
                {"type": "text", "text": "ok"},
                {
                    "type": "toolCall",
                    "id": "tc1",
                    "name": "bash",
                    "arguments": {"command": "ls"},
                },
            ],
            "timestamp": 2,
            "api": "openai-completions",
            "provider": "test",
            "model": "m",
            "usage": {
                "input": 1,
                "output": 1,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 2,
                "cost": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "total": 0,
                },
            },
            "stopReason": "toolUse",
        },
    }
    tool_result = {
        "type": "message",
        "id": "e3",
        "parentId": "e2",
        "timestamp": "2026-07-12T00:00:03.000Z",
        "message": {
            "role": "toolResult",
            "toolCallId": "tc1",
            "toolName": "bash",
            "content": [{"type": "text", "text": "a.txt"}],
            "isError": False,
            "timestamp": 3,
        },
    }
    compaction = {
        "type": "compaction",
        "id": "e4",
        "parentId": "e3",
        "timestamp": "2026-07-12T00:00:04.000Z",
        "summary": "listed files",
        "firstKeptEntryId": "e3",
        "tokensBefore": 100,
    }

    created = mgr.append_entries(
        session.id,
        [
            {
                "id": "e1",
                "entry_type": "user_message",
                "entry_payload": user,
                "parent_entry_id": None,
            },
            {
                "id": "e2",
                "entry_type": "assistant_message",
                "entry_payload": assistant,
                "parent_entry_id": "e1",
            },
            {
                "id": "e3",
                "entry_type": "tool_result",
                "entry_payload": tool_result,
                "parent_entry_id": "e2",
            },
            {
                "id": "e4",
                "entry_type": "compaction",
                "entry_payload": compaction,
                "parent_entry_id": "e3",
            },
        ],
    )
    assert len(created) == 4
    assert [c.sequence for c in created] == [1, 2, 3, 4]

    resume = mgr.resume(session.id)
    assert resume is not None
    assert resume.session.entry_count == 4
    assert resume.session.last_compacted_at is not None
    assert resume.session.status in {
        AgentSessionStatus.COMPACTED.value,
        AgentSessionStatus.ACTIVE.value,
    }

    lines = [ln for ln in resume.jsonl.strip().split("\n") if ln.strip()]
    assert len(lines) == 5  # header + 4 entries
    header = json.loads(lines[0])
    assert header["type"] == "session"
    assert header["id"] == "sdk-abc"
    payloads = [json.loads(ln) for ln in lines[1:]]
    assert payloads[0]["message"]["role"] == "user"
    assert payloads[1]["message"]["role"] == "assistant"
    assert any(
        p.get("type") == "toolCall" for p in payloads[1]["message"]["content"]
    )
    assert payloads[2]["message"]["role"] == "toolResult"
    assert payloads[2]["message"]["toolCallId"] == "tc1"
    assert payloads[3]["type"] == "compaction"


def test_append_idempotent_by_entry_id(mgr, conversation):
    session = mgr.create_session(conversation_id=conversation.id, sdk_session_id="s1")
    entry = {
        "id": "same",
        "entry_type": "user_message",
        "entry_payload": {
            "type": "message",
            "id": "same",
            "parentId": None,
            "timestamp": "t",
            "message": {"role": "user", "content": "hi", "timestamp": 1},
        },
    }
    a = mgr.append_entries(session.id, [entry])
    b = mgr.append_entries(session.id, [entry])
    assert len(a) == 1 and len(b) == 1
    assert a[0].sequence == b[0].sequence
    assert mgr.sessions.count_entries(session.id) == 1


def test_resume_missing_returns_none(mgr):
    assert mgr.resume("asess_does_not_exist") is None


def test_http_create_resume_entries_flow():
    # Create conversation
    r = client.post("/conversations", json={"title": "http-session"})
    assert r.status_code == 201
    cid = r.json()["id"]

    # Create agent session
    s = client.post(
        "/agent-sessions",
        json={
            "conversation_id": cid,
            "sdk_session_id": "sdk-http-1",
            "model_id": "m1",
            "header_payload": {
                "type": "session",
                "version": 3,
                "id": "sdk-http-1",
                "timestamp": "2026-07-12T00:00:00Z",
                "cwd": "/tmp",
            },
        },
    )
    assert s.status_code == 201
    sid = s.json()["id"]

    # Conversation bound
    g = client.get(f"/conversations/{cid}")
    assert g.status_code == 200
    assert g.json()["agent_session_id"] == sid

    # Append multi-turn with tool call/result
    entries = client.post(
        f"/agent-sessions/{sid}/entries",
        json={
            "entries": [
                {
                    "id": "h1",
                    "entry_type": "user_message",
                    "entry_payload": {
                        "type": "message",
                        "id": "h1",
                        "parentId": None,
                        "timestamp": "t1",
                        "message": {
                            "role": "user",
                            "content": "turn1",
                            "timestamp": 1,
                        },
                    },
                },
                {
                    "id": "h2",
                    "entry_type": "assistant_message",
                    "entry_payload": {
                        "type": "message",
                        "id": "h2",
                        "parentId": "h1",
                        "timestamp": "t2",
                        "message": {
                            "role": "assistant",
                            "content": [
                                {"type": "text", "text": "calling"},
                                {
                                    "type": "toolCall",
                                    "id": "tc",
                                    "name": "read",
                                    "arguments": {"path": "a.txt"},
                                },
                            ],
                            "timestamp": 2,
                            "api": "openai-completions",
                            "provider": "t",
                            "model": "m",
                            "usage": {
                                "input": 1,
                                "output": 1,
                                "cacheRead": 0,
                                "cacheWrite": 0,
                                "totalTokens": 2,
                                "cost": {
                                    "input": 0,
                                    "output": 0,
                                    "cacheRead": 0,
                                    "cacheWrite": 0,
                                    "total": 0,
                                },
                            },
                            "stopReason": "toolUse",
                        },
                    },
                },
                {
                    "id": "h3",
                    "entry_type": "tool_result",
                    "entry_payload": {
                        "type": "message",
                        "id": "h3",
                        "parentId": "h2",
                        "timestamp": "t3",
                        "message": {
                            "role": "toolResult",
                            "toolCallId": "tc",
                            "toolName": "read",
                            "content": [{"type": "text", "text": "hello"}],
                            "isError": False,
                            "timestamp": 3,
                        },
                    },
                },
            ]
        },
    )
    assert entries.status_code == 201
    assert len(entries.json()) == 3

    # Resume for SessionManager.open materialization
    resume = client.post(f"/agent-sessions/{sid}/resume")
    assert resume.status_code == 200
    body = resume.json()
    assert body["session"]["id"] == sid
    assert len(body["entries"]) == 3
    assert "sdk-http-1" in body["jsonl"]
    assert "toolResult" in body["jsonl"]
    assert "toolCall" in body["jsonl"]

    # Conversation lookup
    by_conv = client.get(f"/conversations/{cid}/agent-session")
    assert by_conv.status_code == 200
    assert by_conv.json()["id"] == sid

    # Fail-closed: missing session
    missing = client.post("/agent-sessions/asess_missing/resume")
    assert missing.status_code == 404


def test_conversation_patch_agent_session_id():
    r = client.post("/conversations", json={"title": "bind-patch"})
    cid = r.json()["id"]
    s = client.post(
        "/agent-sessions",
        json={"conversation_id": cid, "sdk_session_id": "sdk-p"},
    )
    sid = s.json()["id"]
    # Re-patch should preserve agent_session_id when omitted
    u = client.patch(
        f"/conversations/{cid}",
        json={"messages": [{"role": "user", "content": "hi"}]},
    )
    assert u.status_code == 200
    assert u.json()["agent_session_id"] == sid
