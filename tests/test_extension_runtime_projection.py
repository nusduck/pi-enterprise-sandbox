from __future__ import annotations

from sandbox.database import Database
from sandbox.repositories import (
    AgentEventRepository,
    AgentRunRepository,
    ConversationRepository,
    TaskPlanProjectionRepository,
    ToolExecutionRepository,
)
from sandbox.services.agent_run_manager import AgentRunManager


def _manager(db: Database) -> AgentRunManager:
    return AgentRunManager(
        runs=AgentRunRepository(db),
        events=AgentEventRepository(db),
        tools=ToolExecutionRepository(db),
        conversations=ConversationRepository(db),
    )


def _conversation(manager: AgentRunManager, conversation_id: str):
    return manager.conversations.upsert({
        "id": conversation_id,
        "title": "Extension projection test",
        "messages": [],
    })


def test_task_plan_projection_replaces_run_read_model(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'projection.db'}")
    db.initialize()
    manager = _manager(db)
    conversation = _conversation(manager, "conv_projection")
    run = manager.start_run(conversation_id=conversation.id)
    projection = TaskPlanProjectionRepository(db)

    rows = projection.replace(
        run.run_id,
        [{
            "task_id": "T-001",
            "content": "Run tests",
            "status": "completed",
            "evidence": "30 passed",
        }],
    )
    assert rows[0]["task_id"] == "T-001"
    assert rows[0]["status"] == "completed"
    assert rows[0]["evidence"] == "30 passed"


def test_waiting_input_is_durable_and_releases_lease(tmp_path):
    db = Database(f"sqlite:///{tmp_path / 'input.db'}")
    db.initialize()
    manager = _manager(db)
    conversation = _conversation(manager, "conv_input")
    run = manager.start_run(conversation_id=conversation.id, lease_owner="worker-a")
    pending = {"interaction_id": "interaction_1", "title": "Choose"}

    parked = manager.mark_waiting_input(
        run.run_id,
        pending_input=pending,
        lease_owner="worker-a",
    )
    assert parked is not None
    assert parked.status == "waiting_input"
    assert parked.lease_owner is None
    assert parked.pending_input_json == pending
