import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from sandbox.app.domain.internal_files_write_contract import (
    FilesWriteContractError, parse_and_bind_files_edit, parse_and_bind_files_write,
)
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_FAILED,
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
    ExecutionRecord,
)
from sandbox.services.files_write_runtime import FilesWriteRuntime
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor
from sandbox.services.internal_file_writer import InternalFileWriteError, InternalFileWriter

WS = "01K0G2PAV8FPMVC9QHJG7JPN5F"
EXEC = "01K0G2PAV8FPMVC9QHJG7JPN60"
IDS = {
    "orgId": "01K0G2PAV8FPMVC9QHJG7JPN4Z",
    "userId": "01K0G2PAV8FPMVC9QHJG7JPN50",
    "conversationId": "01K0G2PAV8FPMVC9QHJG7JPN51",
    "agentSessionId": "01K0G2PAV8FPMVC9QHJG7JPN52",
    "runId": "01K0G2PAV8FPMVC9QHJG7JPN53",
    "sandboxSessionId": "01K0G2PAV8FPMVC9QHJG7JPN54",
    "traceId": "0123456789abcdef0123456789abcdef",
    "executionFenceToken": 1,
}

def body(tool, args, **extra):
    h = compute_tool_request_hash_v1(tool_name=tool, args=args)["requestHash"]
    return {**args, "identity": IDS, "toolExecutionId": WS, "toolCallId":"tc", "requestHash":h, "requestHashVersion":1, **extra}

def claims(tool, h):
    return {
        "scope": [f"sandbox.files.{tool}"],
        "tool_name": tool,
        "org_id": IDS["orgId"],
        "user_id": IDS["userId"],
        "conversation_id": IDS["conversationId"],
        "agent_session_id": IDS["agentSessionId"],
        "run_id": IDS["runId"],
        "sandbox_session_id": IDS["sandboxSessionId"],
        "trace_id": IDS["traceId"],
        "execution_fence_token": 1,
        "tool_execution_id": WS,
        "tool_call_id": "tc",
        "request_hash": h,
        "request_hash_version": 1,
    }

def test_write_and_edit_contract_binds_hash_and_identity():
    b = body("write", {"path":"/home/sandbox/workspace/a.txt","content":"hello","encoding":"utf-8"})
    c = parse_and_bind_files_write(json.dumps(b).encode(), claims("write", b["requestHash"]))
    assert c.path.endswith("a.txt")
    b2 = body("edit", {"path":b["path"],"oldText":"h","newText":"H","expectedHash":"a"*64})
    c2 = parse_and_bind_files_edit(json.dumps(b2).encode(), claims("edit", b2["requestHash"]))
    assert c2.expected_hash == "a"*64

def test_contract_rejects_hash_tamper():
    b = body("write", {"path":"/home/sandbox/workspace/a.txt","content":"hello","encoding":"utf-8"})
    b["requestHash"] = "b" * 64
    with pytest.raises(FilesWriteContractError):
        parse_and_bind_files_write(json.dumps(b).encode(), claims("write", b["requestHash"]))


def test_contract_checks_decoded_base64_size(monkeypatch):
    monkeypatch.setattr(
        "sandbox.app.domain.internal_files_write_contract._MAX_CONTENT_BYTES", 2
    )
    args = {
        "path": "/home/sandbox/workspace/a.bin",
        "content": "YWJj",
        "encoding": "base64",
    }
    b = body("write", args)
    with pytest.raises(FilesWriteContractError):
        parse_and_bind_files_write(
            json.dumps(b).encode(), claims("write", b["requestHash"])
        )


def test_edit_contract_preserves_exact_optional_precondition_shape():
    args = {
        "path": "/home/sandbox/workspace/a.txt",
        "oldText": "a",
        "newText": "b",
        "expectedVersion": "v1",
    }
    b = body("edit", args)
    command = parse_and_bind_files_edit(
        json.dumps(b).encode(), claims("edit", b["requestHash"])
    )
    assert command.expected_hash is None
    assert command.expected_version == "v1"

def test_writer_atomic_and_symlink_rejected(tmp_path, monkeypatch):
    from sandbox.config import settings
    monkeypatch.setattr(settings, "workspaces_root", str(tmp_path))
    monkeypatch.setattr(settings, "workspace_quota_mb", 10)
    monkeypatch.setattr(settings, "max_file_size_mb", 10)
    root = Path(tmp_path) / WS
    root.mkdir()
    writer = InternalFileWriter()
    out = writer.write(workspace_id=WS, path="/home/sandbox/workspace/nested/a.txt", content="one")
    assert out["size"] == 3 and (root / "nested/a.txt").read_text() == "one"
    assert (root / "nested/a.txt").is_file()
    writer.edit(workspace_id=WS, path="/home/sandbox/workspace/nested/a.txt", old_text="one", new_text="two", expected_hash=out["hash"], expected_version=None)
    with pytest.raises(InternalFileWriteError) as exc:
        writer.edit(workspace_id=WS, path="/home/sandbox/workspace/nested/a.txt", old_text="two", new_text="three", expected_hash="a"*64, expected_version=None)
    assert exc.value.code == "FILE_VERSION_CONFLICT"
    (root / "link").symlink_to(root / "nested/a.txt")
    with pytest.raises(InternalFileWriteError):
        writer.write(workspace_id=WS, path="/home/sandbox/workspace/link", content="bad")


def test_writer_enforces_decoded_size_and_workspace_quota(tmp_path, monkeypatch):
    from sandbox.config import settings

    monkeypatch.setattr(settings, "workspaces_root", str(tmp_path))
    monkeypatch.setattr(settings, "workspace_quota_mb", 1)
    monkeypatch.setattr(settings, "max_file_size_mb", 1)
    root = tmp_path / WS
    root.mkdir()
    writer = InternalFileWriter()

    out = writer.write(
        workspace_id=WS,
        path="/home/sandbox/workspace/a.bin",
        content="YWJj",
        encoding="base64",
    )
    assert out["size"] == 3
    assert (root / "a.bin").read_bytes() == b"abc"

    with pytest.raises(InternalFileWriteError) as exc:
        writer.write(
            workspace_id=WS,
            path="/home/sandbox/workspace/b.bin",
            content="x" * (1024 * 1024),
        )
    assert exc.value.code == "WORKSPACE_QUOTA_EXCEEDED"
    assert not (root / "b.bin").exists()


def _record(*, status=SANDBOX_EXECUTION_STATUS_RUNNING, result=None):
    return ExecutionRecord(
        execution_id=EXEC,
        org_id=IDS["orgId"],
        user_id=IDS["userId"],
        sandbox_session_id=IDS["sandboxSessionId"],
        run_id=IDS["runId"],
        agent_session_id=IDS["agentSessionId"],
        kind="write",
        status=status,
        created_at="2026-01-01 00:00:00",
        result_json=result,
        tool_execution_id=WS,
        tool_call_id="tc",
        request_hash="a" * 64,
        request_hash_version=1,
        execution_fence_token=1,
        trace_id=IDS["traceId"],
    )


class _Validator:
    def __init__(
        self,
        *,
        created=True,
        record=None,
        finalize_error=None,
        unknown_error=None,
    ):
        self.created = created
        self.record = record or _record()
        self.finalize_error = finalize_error
        self.unknown_error = unknown_error
        self.claim_inputs = []
        self.finalize_inputs = []
        self.unknown_inputs = []

    def claim(self, value):
        self.claim_inputs.append(dict(value))
        return {"created": self.created, "execution": self.record, "workspace_id": WS}

    def finalize(self, value):
        self.finalize_inputs.append(dict(value))
        if self.finalize_error:
            raise self.finalize_error
        self.record = replace(
            self.record,
            status=value["status"],
            result_json=value["result_json"],
            error_code=value["error_code"],
        )
        return {"changed": True, "execution": self.record}

    def mark_unknown_for_crash_recovery(self, value):
        self.unknown_inputs.append(dict(value))
        if self.unknown_error:
            raise self.unknown_error


class _Writer:
    def __init__(self, *, error=None):
        self.error = error
        self.calls = []

    def write(self, **kwargs: Any):
        self.calls.append(dict(kwargs))
        if self.error:
            raise self.error
        return {
            "path": kwargs["path"],
            "size": 5,
            "hash": "b" * 64,
            "version": "b" * 64,
            "physicalPath": "/secret",
        }


def _runtime_request():
    args = {
        "path": "/home/sandbox/workspace/a.txt",
        "content": "hello",
        "encoding": "utf-8",
    }
    b = body("write", args)
    return json.dumps(b).encode(), claims("write", b["requestHash"])


@pytest.mark.asyncio
async def test_runtime_claim_execute_finalize_and_replay():
    validator = _Validator()
    writer = _Writer()
    runtime = FilesWriteRuntime(
        claim_validator=validator,
        writer=writer,
        id_factory=lambda: EXEC,
        supervisor=InternalExecutionSupervisor(),
    )
    raw, token_claims = _runtime_request()

    response = await runtime.handle(tool="write", claims=token_claims, raw_body=raw)

    assert response.status_code == 200
    assert json.loads(response.body) == {
        "path": "/home/sandbox/workspace/a.txt",
        "size": 5,
        "hash": "b" * 64,
        "version": "b" * 64,
    }
    assert len(writer.calls) == 1
    assert validator.claim_inputs[0]["execution_id"] == EXEC
    assert validator.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_SUCCESS
    assert runtime.inflight_claim_count() == 0

    validator.created = False
    replay = await runtime.handle(tool="write", claims=token_claims, raw_body=raw)
    assert replay.status_code == 200
    assert json.loads(replay.body) == json.loads(response.body)
    assert len(writer.calls) == 1
    assert len(validator.finalize_inputs) == 1


@pytest.mark.asyncio
async def test_runtime_failed_write_is_finalized_and_replayed_with_http_status():
    validator = _Validator()
    writer = _Writer(
        error=InternalFileWriteError(
            "FILE_VERSION_CONFLICT", "file version precondition failed"
        )
    )
    runtime = FilesWriteRuntime(
        claim_validator=validator,
        writer=writer,
        id_factory=lambda: EXEC,
        supervisor=InternalExecutionSupervisor(),
    )
    raw, token_claims = _runtime_request()

    response = await runtime.handle(tool="write", claims=token_claims, raw_body=raw)
    assert response.status_code == 409
    assert json.loads(response.body)["error"]["code"] == "FILE_VERSION_CONFLICT"
    assert "_httpStatus" not in json.loads(response.body)
    assert validator.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_FAILED

    validator.created = False
    replay = await runtime.handle(tool="write", claims=token_claims, raw_body=raw)
    assert replay.status_code == 409
    assert json.loads(replay.body) == json.loads(response.body)
    assert len(writer.calls) == 1


@pytest.mark.asyncio
async def test_finalize_failure_marks_unknown_and_does_not_reexecute():
    validator = _Validator(finalize_error=RuntimeError("db down"))
    writer = _Writer()
    runtime = FilesWriteRuntime(
        claim_validator=validator,
        writer=writer,
        id_factory=lambda: EXEC,
        supervisor=InternalExecutionSupervisor(),
    )
    raw, token_claims = _runtime_request()
    with pytest.raises(HTTPException) as exc:
        await runtime.handle(tool="write", claims=token_claims, raw_body=raw)
    assert exc.value.status_code == 503
    assert len(writer.calls) == 1
    assert validator.unknown_inputs[0]["error_code"] == "POST_EXECUTION_FINALIZE_FAILED"
    assert runtime.inflight_claim_count() == 0

    validator.created = False
    validator.record = replace(
        validator.record,
        status=SANDBOX_EXECUTION_STATUS_UNKNOWN,
        result_json={"unknown": True},
    )
    replay = await runtime.handle(tool="write", claims=token_claims, raw_body=raw)
    assert replay.status_code == 409
    assert json.loads(replay.body)["error"]["code"] == "TOOL_OUTCOME_UNKNOWN"
    assert len(writer.calls) == 1


@pytest.mark.asyncio
async def test_finalize_and_unknown_failure_retains_inflight_for_shutdown_reconcile():
    validator = _Validator(
        finalize_error=RuntimeError("db down"),
        unknown_error=RuntimeError("still down"),
    )
    runtime = FilesWriteRuntime(
        claim_validator=validator,
        writer=_Writer(),
        id_factory=lambda: EXEC,
        supervisor=InternalExecutionSupervisor(),
    )
    raw, token_claims = _runtime_request()
    with pytest.raises(HTTPException) as exc:
        await runtime.handle(tool="write", claims=token_claims, raw_body=raw)
    assert exc.value.status_code == 503
    assert runtime.inflight_claim_count() == 1
    assert runtime.reconcile_inflight_as_unknown() == 0
    assert runtime.inflight_claim_count() == 1

    validator.unknown_error = None
    assert runtime.reconcile_inflight_as_unknown() == 1
