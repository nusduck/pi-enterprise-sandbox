"""B7: agent_runs.usage records actual model tokens/cost on complete."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from sandbox.database import Database
from sandbox.repositories import AgentRunRepository, ConversationRepository
from sandbox.services.agent_run_manager import AgentRunManager


@pytest.fixture
def db(tmp_path: Path):
    database = Database(f"sqlite:///{tmp_path / 'usage.db'}")
    database.initialize()
    return database


@pytest.fixture
def mgr(db):
    return AgentRunManager(
        runs=AgentRunRepository(db),
        conversations=ConversationRepository(db),
    )


@pytest.fixture
def conversation(db):
    repo = ConversationRepository(db)
    return repo.upsert(
        {
            "id": "conv_usage_1",
            "title": "Usage",
            "messages": [],
            "owner_user_id": "u1",
            "organization_id": "org1",
        }
    )


def test_schema_has_usage_column(db, tmp_path: Path):
    with sqlite3.connect(tmp_path / "usage.db") as conn:
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(agent_runs)").fetchall()
        }
    assert "usage" in cols


def test_migrate_agent_run_usage_idempotent(tmp_path: Path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE agent_runs (
                run_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                version INTEGER NOT NULL DEFAULT 0,
                model_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            """
        )
        conn.commit()

    db = Database(f"sqlite:///{path}")
    r1 = db.migrate_agent_run_usage()
    r2 = db.migrate_agent_run_usage()
    assert r1["columns_added"] == 1
    assert r2["columns_added"] == 0

    with sqlite3.connect(path) as conn:
        cols = {
            row[1]
            for row in conn.execute("PRAGMA table_info(agent_runs)").fetchall()
        }
    assert "usage" in cols


def test_complete_run_records_model_and_usage(mgr, conversation):
    run = mgr.start_run(
        conversation_id=conversation.id,
        model_id="deepseek-v4-flash",
        lease_owner="worker_1",
    )
    usage = {
        "input_tokens": 120,
        "output_tokens": 40,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "total_tokens": 160,
        "cost": {
            "input": 0.0000168,
            "output": 0.0000112,
            "cache_read": 0,
            "cache_write": 0,
            "total": 0.000028,
        },
        "model_id": "deepseek-v4-flash",
        "provider": "llmio",
    }
    completed = mgr.complete_run(
        run.run_id,
        lease_owner="worker_1",
        model_id="deepseek-v4-flash",
        usage=usage,
    )
    assert completed is not None
    assert completed.status == "completed"
    assert completed.model_id == "deepseek-v4-flash"
    assert completed.usage is not None
    assert completed.usage["input_tokens"] == 120
    assert completed.usage["output_tokens"] == 40
    assert completed.usage["total_tokens"] == 160
    assert completed.usage["cost"]["total"] == pytest.approx(0.000028)

    # Done event payload includes usage for recovery streams.
    events = mgr.list_events(run.run_id)
    done = [e for e in events if e.type == "done"]
    assert done
    assert done[-1].payload.get("usage", {}).get("total_tokens") == 160
    assert done[-1].payload.get("model_id") == "deepseek-v4-flash"


def test_usage_persisted_as_json_text(db, conversation, mgr):
    run = mgr.start_run(
        conversation_id=conversation.id,
        model_id="gpt-5.5",
        lease_owner="w2",
    )
    mgr.complete_run(
        run.run_id,
        lease_owner="w2",
        model_id="gpt-5.5",
        usage={"input_tokens": 1, "output_tokens": 2, "total_tokens": 3, "cost": {"total": 0}},
    )
    with db.connect() as conn:
        row = conn.execute(
            "SELECT usage, model_id FROM agent_runs WHERE run_id = ?",
            (run.run_id,),
        ).fetchone()
    assert row["model_id"] == "gpt-5.5"
    parsed = json.loads(row["usage"])
    assert parsed["total_tokens"] == 3
