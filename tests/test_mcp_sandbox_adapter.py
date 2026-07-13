"""MCP adapter parity for Conversation workspace and persistent /tmp."""

from __future__ import annotations

import uuid

import pytest

from sandbox.mcp.server import mcp_server
from sandbox.repositories import ConversationRepository
from sandbox.services.workspace_manager import workspace_manager


def _conversation_id() -> str:
    return f"mcp-{uuid.uuid4().hex[:12]}"


def _create_conversation(conversation_id: str) -> None:
    workspace_manager.init_conversation_workspace(conversation_id)
    ConversationRepository().upsert(
        {
            "id": conversation_id,
            "title": "MCP dual roots",
            "workspace_id": f"conv_{conversation_id}",
            "workspace_path": f"conv_{conversation_id}",
            "messages": [],
        }
    )


@pytest.mark.asyncio
async def test_mcp_rejects_forged_workspace_binding():
    conversation_id = _conversation_id()
    _create_conversation(conversation_id)
    result = await mcp_server.create_session(
        conversation_id=conversation_id,
        workspace_id="conv_someone_else",
    )
    assert "error" in result
    assert "does not match" in result["error"]


@pytest.mark.asyncio
async def test_mcp_workspace_temp_artifact_and_rebind():
    conversation_id = _conversation_id()
    _create_conversation(conversation_id)
    created = await mcp_server.create_session(conversation_id=conversation_id)
    session_id = created["session_id"]

    logical_write = await mcp_server.write_file(
        session_id=session_id,
        path="/home/sandbox/workspace/report.txt",
        content="workspace",
    )
    assert logical_write["path"] == "report.txt"
    temp_write = await mcp_server.write_file(
        session_id=session_id,
        path="/tmp/cache/result.txt",
        content="persistent-temp",
    )
    assert temp_write["path"] == "/tmp/cache/result.txt"

    temp_read = await mcp_server.read_file(
        session_id=session_id,
        path="/tmp/cache/result.txt",
    )
    assert temp_read["content"] == "persistent-temp"
    artifact = await mcp_server.submit_artifact(
        session_id=session_id,
        path="/tmp/cache/result.txt",
        name="result.txt",
        mime_type="text/plain",
    )
    assert artifact["path"] == "/tmp/cache/result.txt"
    download = await mcp_server.download_file(
        session_id=session_id,
        path="/tmp/cache/result.txt",
    )
    assert download["path"] == "/tmp/cache/result.txt"
    assert "/var/sandbox" not in str(download)

    closed = await mcp_server.close_session(session_id=session_id)
    assert closed == {"status": "closed"}
    rebound = await mcp_server.create_session(conversation_id=conversation_id)
    rebound_read = await mcp_server.read_file(
        session_id=rebound["session_id"],
        path="/tmp/cache/result.txt",
    )
    assert rebound_read["content"] == "persistent-temp"

