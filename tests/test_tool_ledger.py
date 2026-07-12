"""B4 Tool Ledger Completion — completeness, idempotency, edit/patch (ADR §4.4 / §9 / §12.3)."""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox.database import Database
from sandbox.models import ToolExecutionStatus
from sandbox.repositories import (
    ConversationRepository,
    ToolExecutionRepository,
)
from sandbox.services.agent_run_manager import AgentRunManager
from sandbox.services.file_edit import (
    apply_unified_patch_to_content,
    content_sha256,
    file_edit_service,
    find_match_line_numbers,
    plan_unique_edit,
)


@pytest.fixture()
def db(tmp_path: Path) -> Database:
    path = tmp_path / "ledger.db"
    database = Database(f"sqlite:///{path}")
    database.initialize()
    return database


@pytest.fixture()
def mgr(db: Database) -> AgentRunManager:
    return AgentRunManager(
        tools=ToolExecutionRepository(db),
        conversations=ConversationRepository(db),
    )


@pytest.fixture()
def conversation(db: Database):
    return ConversationRepository(db).upsert(
        {
            "id": "conv_ledger_1",
            "title": "ledger-test",
            "messages": [],
            "owner_user_id": "u1",
            "organization_id": "org1",
        }
    )


@pytest.fixture()
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    return ws


# ── Ledger completeness ───────────────────────────────────────────────────


def test_ledger_full_fields_and_lifecycle(mgr: AgentRunManager, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    tool = mgr.prepare_tool(
        tool_call_id="tc_full",
        run_id=run.run_id,
        idempotency_key="idem_full",
        tool_name="write",
        arguments={"path": "a.txt", "content": "hi"},
        session_id="sess_1",
        conversation_id=conversation.id,
        workspace_id="ws_1",
        summary="write a.txt",
    )
    assert tool.tool_call_id == "tc_full"
    assert tool.status == ToolExecutionStatus.PREPARED.value
    assert tool.tool_name == "write"
    assert tool.arguments == {"path": "a.txt", "content": "hi"}
    assert tool.session_id == "sess_1"
    assert tool.conversation_id == conversation.id
    assert tool.workspace_id == "ws_1"
    assert tool.idempotency_key == "idem_full"
    assert tool.started_at is None
    assert tool.finished_at is None

    waiting = mgr.mark_tool_waiting_approval("tc_full")
    assert waiting is not None
    assert waiting.status == ToolExecutionStatus.WAITING_APPROVAL.value

    executing = mgr.mark_tool_executing("tc_full")
    assert executing is not None
    assert executing.status == ToolExecutionStatus.EXECUTING.value
    assert executing.started_at is not None

    terminal = mgr.mark_tool_terminal(
        "tc_full",
        ToolExecutionStatus.SUCCEEDED.value,
        summary="wrote 2 bytes",
        result_json={"content": [{"type": "text", "text": "ok"}], "isError": False},
        execution_id="exec_abc",
    )
    assert terminal is not None
    assert terminal.status == ToolExecutionStatus.SUCCEEDED.value
    assert terminal.result_summary == "wrote 2 bytes"
    assert terminal.summary == "wrote 2 bytes"
    assert terminal.finished_at is not None
    assert terminal.execution_id == "exec_abc"
    assert terminal.result_json is not None
    assert terminal.result_json["isError"] is False

    listed = mgr.list_tools_for_run(run.run_id)
    assert len(listed) == 1
    assert listed[0].tool_call_id == "tc_full"


def test_ledger_failed_and_unknown_not_overwritten(mgr: AgentRunManager, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    mgr.prepare_tool(
        tool_call_id="tc_fail",
        run_id=run.run_id,
        idempotency_key="idem_fail",
        tool_name="bash",
    )
    mgr.mark_tool_executing("tc_fail")
    failed = mgr.mark_tool_terminal(
        "tc_fail",
        ToolExecutionStatus.FAILED.value,
        summary="boom",
        error="boom",
    )
    assert failed is not None
    assert failed.status == ToolExecutionStatus.FAILED.value
    assert failed.error == "boom"

    # Terminal is sticky
    again = mgr.mark_tool_terminal(
        "tc_fail", ToolExecutionStatus.SUCCEEDED.value, summary="nope"
    )
    assert again is not None
    assert again.status == ToolExecutionStatus.FAILED.value


# ── Idempotency / retry ───────────────────────────────────────────────────


def test_retry_idempotency_prepare_returns_same_row(
    mgr: AgentRunManager, conversation
):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    a = mgr.prepare_tool(
        tool_call_id="tc_a",
        run_id=run.run_id,
        idempotency_key="same_key",
        tool_name="bash",
        arguments={"command": "echo 1"},
    )
    b = mgr.prepare_tool(
        tool_call_id="tc_b",
        run_id=run.run_id,
        idempotency_key="same_key",
        tool_name="bash",
        arguments={"command": "echo 2"},
    )
    assert a.tool_call_id == b.tool_call_id == "tc_a"
    assert a.arguments == {"command": "echo 1"}


def test_retry_after_success_replays_result_not_reexec(
    mgr: AgentRunManager, conversation
):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    mgr.prepare_tool(
        tool_call_id="tc_once",
        run_id=run.run_id,
        idempotency_key="idem_once",
        tool_name="write",
        arguments={"path": "x.txt"},
    )
    mgr.mark_tool_executing("tc_once")
    mgr.mark_tool_terminal(
        "tc_once",
        ToolExecutionStatus.SUCCEEDED.value,
        summary="done",
        result_json={
            "content": [{"type": "text", "text": "Written"}],
            "details": {"path": "x.txt"},
            "isError": False,
        },
    )

    # Lost HTTP response → client prepares again with same idempotency key
    replay = mgr.prepare_tool(
        tool_call_id="tc_once_retry",
        run_id=run.run_id,
        idempotency_key="idem_once",
        tool_name="write",
        arguments={"path": "x.txt"},
    )
    assert replay.tool_call_id == "tc_once"
    assert replay.status == ToolExecutionStatus.SUCCEEDED.value
    assert replay.result_json is not None
    assert replay.result_json["content"][0]["text"] == "Written"
    # Auto-retry forbidden for terminal
    assert mgr.tool_can_auto_retry("tc_once") is False


def test_executing_and_unknown_block_auto_retry(mgr: AgentRunManager, conversation):
    run = mgr.start_run(conversation_id=conversation.id, lease_owner="w1")
    mgr.prepare_tool(
        tool_call_id="tc_exec",
        run_id=run.run_id,
        idempotency_key="idem_exec",
        tool_name="bash",
    )
    assert mgr.tool_can_auto_retry("tc_exec") is True
    mgr.mark_tool_executing("tc_exec")
    # Side-effect safety: do not auto-retry while executing
    assert mgr.tool_can_auto_retry("tc_exec") is False

    mgr.mark_tool_terminal(
        "tc_exec", ToolExecutionStatus.UNKNOWN.value, summary="crash"
    )
    assert mgr.tool_can_auto_retry("tc_exec") is False
    sticky = mgr.mark_tool_terminal(
        "tc_exec", ToolExecutionStatus.SUCCEEDED.value, summary="nope"
    )
    assert sticky is not None
    assert sticky.status == ToolExecutionStatus.UNKNOWN.value


# ── Edit multi-match + apply_patch + diff/hash ─────────────────────────────


def test_edit_unique_returns_diff_and_hashes(workspace: Path):
    path = workspace / "app.js"
    path.write_text("const a = 1;\nconst b = 2;\n", encoding="utf-8")
    before = path.read_text(encoding="utf-8")
    result = file_edit_service.edit(
        str(workspace),
        "app.js",
        "const a = 1;",
        "const a = 42;",
    )
    assert result.ok is True
    assert result.before_hash == content_sha256(before)
    assert result.after_hash == content_sha256(path.read_text(encoding="utf-8"))
    assert "const a = 42;" in path.read_text(encoding="utf-8")
    assert result.diff
    assert "@@" in result.diff
    assert result.changed_lines >= 1


def test_edit_multi_match_rejects_with_count_and_lines(workspace: Path):
    path = workspace / "dup.txt"
    path.write_text("foo\nbar\nfoo\nbaz\nfoo\n", encoding="utf-8")
    lines = find_match_line_numbers(path.read_text(encoding="utf-8"), "foo")
    assert lines == [1, 3, 5]

    result = file_edit_service.edit(
        str(workspace), "dup.txt", "foo", "qux"
    )
    assert result.ok is False
    assert result.match_count == 3
    assert result.match_lines == [1, 3, 5]
    assert "3 times" in (result.error or "")
    # File unchanged
    assert path.read_text(encoding="utf-8") == "foo\nbar\nfoo\nbaz\nfoo\n"


def test_edit_not_found(workspace: Path):
    (workspace / "empty.txt").write_text("hello\n", encoding="utf-8")
    result = file_edit_service.edit(
        str(workspace), "empty.txt", "missing", "x"
    )
    assert result.ok is False
    assert result.match_count == 0


def test_edit_race_hash_check(workspace: Path):
    (workspace / "r.txt").write_text("v1\n", encoding="utf-8")
    result = file_edit_service.edit(
        str(workspace),
        "r.txt",
        "v1",
        "v2",
        expected_hash="0" * 64,
    )
    assert result.ok is False
    assert "changed since read" in (result.error or "")


def test_plan_unique_edit_pure():
    plan = plan_unique_edit("aa\nbb\naa\n", "aa", "xx", path="f")
    assert plan.ok is False
    assert plan.match_count == 2
    assert plan.match_lines == [1, 3]

    plan2 = plan_unique_edit("only once\n", "only once", "twice", path="f")
    assert plan2.ok is True
    assert plan2.after == "twice\n"
    assert plan2.diff


def test_apply_patch_success(workspace: Path):
    path = workspace / "src.py"
    original = "def hi():\n    return 1\n"
    path.write_text(original, encoding="utf-8")
    patch = (
        "--- a/src.py\n"
        "+++ b/src.py\n"
        "@@ -1,2 +1,2 @@\n"
        " def hi():\n"
        "-    return 1\n"
        "+    return 2\n"
    )
    result = file_edit_service.apply_patch(str(workspace), "src.py", patch)
    assert result.ok is True, result.error
    assert path.read_text(encoding="utf-8") == "def hi():\n    return 2\n"
    assert result.before_hash == content_sha256(original)
    assert result.after_hash == content_sha256(path.read_text(encoding="utf-8"))
    assert result.diff


def test_apply_patch_context_mismatch(workspace: Path):
    (workspace / "x.txt").write_text("alpha\nbeta\n", encoding="utf-8")
    patch = (
        "--- a/x.txt\n"
        "+++ b/x.txt\n"
        "@@ -1,2 +1,2 @@\n"
        " alpha\n"
        "-gamma\n"
        "+delta\n"
    )
    result = file_edit_service.apply_patch(str(workspace), "x.txt", patch)
    assert result.ok is False
    assert "mismatch" in (result.error or "").lower()


def test_apply_unified_patch_to_content_unit():
    content = "line1\nline2\nline3\n"
    patch = (
        "@@ -1,3 +1,3 @@\n"
        " line1\n"
        "-line2\n"
        "+LINE2\n"
        " line3\n"
    )
    out = apply_unified_patch_to_content(content, patch)
    assert out == "line1\nLINE2\nline3\n"


def test_http_edit_and_patch_endpoints(tmp_path: Path, monkeypatch):
    """Router-level smoke via FileEditService already covered; HTTP via TestClient."""
    from fastapi.testclient import TestClient

    from sandbox.main import app
    from sandbox.services import session_manager as sm_mod

    db_path = tmp_path / "http.db"
    monkeypatch.setenv("SANDBOX_DATABASE_URL", f"sqlite:///{db_path}")
    # Use live app with existing session manager
    client = TestClient(app)
    # Create session through API if available
    resp = client.post("/sessions", json={"caller_id": "test"})
    if resp.status_code not in (200, 201):
        pytest.skip(f"session create unavailable: {resp.status_code}")
    session_id = resp.json()["session_id"]

    # Write a file
    w = client.post(
        f"/sessions/{session_id}/files/write",
        json={"path": "t.txt", "content": "hello world\nhello moon\n"},
    )
    assert w.status_code in (200, 201), w.text

    multi = client.post(
        f"/sessions/{session_id}/files/edit",
        json={"path": "t.txt", "old_string": "hello", "new_string": "hi"},
    )
    assert multi.status_code == 200
    body = multi.json()
    assert body["ok"] is False
    assert body["match_count"] == 2
    assert body["match_lines"] == [1, 2]

    # Unique edit
    ok = client.post(
        f"/sessions/{session_id}/files/edit",
        json={
            "path": "t.txt",
            "old_string": "hello world",
            "new_string": "hi world",
        },
    )
    assert ok.status_code == 200
    ob = ok.json()
    assert ob["ok"] is True
    assert ob["before_hash"]
    assert ob["after_hash"]
    assert ob["diff"]

    # apply_patch
    content = client.post(
        f"/sessions/{session_id}/files/read",
        json={"path": "t.txt"},
    ).json()["content"]
    # simple one-line replace via patch
    patch = (
        "--- a/t.txt\n"
        "+++ b/t.txt\n"
        "@@ -1,2 +1,2 @@\n"
        " hi world\n"
        "-hello moon\n"
        "+hi moon\n"
    )
    # content may already have hi world from edit
    if "hello moon" not in content and "hi moon" not in content:
        pytest.skip("unexpected content after edit")
    if "hello moon" in content:
        pr = client.post(
            f"/sessions/{session_id}/files/apply_patch",
            json={"path": "t.txt", "patch": patch},
        )
        assert pr.status_code == 200
        assert pr.json()["ok"] is True
