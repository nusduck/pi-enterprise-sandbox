"""Focused orchestration tests for the formal execution runtime."""

from __future__ import annotations

import json
import threading
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from sandbox.app.domain.internal_execution_contract import (
    parse_and_bind_internal_execution,
)
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
    ExecutionRecord,
)
from sandbox.models import ExecutionStatus
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.execution_manager import ExecutionManager
from sandbox.services.formal_execution_runtime import FormalExecutionRuntime
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
SBX = "01K0G2PAV8FPMVC9QHJG7JPN54"
TOOL_EXEC = "01K0G2PAV8FPMVC9QHJG7JPN55"
EXECUTION = "01K0G2PAV8FPMVC9QHJG7JPN56"
WORKSPACE = "01K0G2PAV8FPMVC9QHJG7JPN57"
TOOL_CALL = "tc-execution-1"
TRACE = "0123456789abcdef0123456789abcdef"
FENCE = 7


def _request() -> tuple[bytes, dict[str, Any]]:
    args = {"command": "printf ok", "timeoutSeconds": 12, "env": {"MODE": "test"}}
    request_hash = compute_tool_request_hash_v1(tool_name="bash", args=args)["requestHash"]
    body = {
        "identity": {
            "orgId": ORG,
            "userId": USER,
            "conversationId": CONV,
            "agentSessionId": AGENT,
            "runId": RUN,
            "sandboxSessionId": SBX,
            "traceId": TRACE,
            "executionFenceToken": FENCE,
        },
        "toolExecutionId": TOOL_EXEC,
        "toolCallId": TOOL_CALL,
        "requestHash": request_hash,
        "requestHashVersion": 1,
        **args,
    }
    claims = {
        "scope": ["sandbox.executions.bash"],
        "tool_name": "bash",
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT,
        "run_id": RUN,
        "sandbox_session_id": SBX,
        "trace_id": TRACE,
        "execution_fence_token": FENCE,
        "tool_execution_id": TOOL_EXEC,
        "tool_call_id": TOOL_CALL,
        "request_hash": request_hash,
        "request_hash_version": 1,
    }
    return json.dumps(body, separators=(",", ":")).encode(), claims


def _record(*, status: str = SANDBOX_EXECUTION_STATUS_RUNNING, result=None) -> ExecutionRecord:
    return ExecutionRecord(
        execution_id=EXECUTION,
        org_id=ORG,
        user_id=USER,
        sandbox_session_id=SBX,
        run_id=RUN,
        agent_session_id=AGENT,
        kind="bash",
        status=status,
        created_at="2026-01-01 00:00:00",
        result_json=result,
        tool_execution_id=TOOL_EXEC,
        tool_call_id=TOOL_CALL,
        request_hash=_request()[1]["request_hash"],
        request_hash_version=1,
        execution_fence_token=FENCE,
        trace_id=TRACE,
    )


class Validator:
    def __init__(
        self,
        *,
        created: bool = True,
        record: ExecutionRecord | None = None,
        finalize_error: Exception | None = None,
        unknown_error: Exception | None = None,
    ) -> None:
        self.created = created
        self.record = record or _record()
        self.finalize_error = finalize_error
        self.unknown_error = unknown_error
        self.claims: list[dict[str, Any]] = []
        self.finalizations: list[dict[str, Any]] = []
        self.unknown: list[dict[str, Any]] = []

    def claim(self, input: dict[str, Any]) -> dict[str, Any]:
        self.claims.append(input)
        return {"created": self.created, "execution": self.record, "workspace_id": WORKSPACE}

    def finalize(self, input: dict[str, Any]) -> dict[str, Any]:
        if self.finalize_error is not None:
            raise self.finalize_error
        self.finalizations.append(input)
        self.record = replace(
            self.record,
            status=input["status"],
            result_json=input["result_json"],
            exit_code=input["exit_code"],
            error_code=input["error_code"],
        )
        return {"changed": True, "execution": self.record}

    def mark_unknown_for_crash_recovery(self, input: dict[str, Any]) -> None:
        if self.unknown_error is not None:
            raise self.unknown_error
        self.unknown.append(input)


class Manager:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def run_command(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {
            "status": ExecutionStatus.SUCCESS,
            "exit_code": 0,
            "stdout_preview": "ok",
            "stderr_preview": "",
            "truncated": False,
            "duration_ms": 4.5,
        }


def _runtime_with_workspace(monkeypatch, tmp_path: Path, validator: Validator):
    manager = Manager()
    monkeypatch.setattr(
        "sandbox.services.formal_execution_runtime.workspace_manager.init_workspace",
        lambda workspace_id: tmp_path / workspace_id,
    )
    monkeypatch.setattr(
        "sandbox.services.formal_execution_runtime.workspace_manager.init_temp",
        lambda workspace_id: tmp_path / f"tmp-{workspace_id}",
    )
    (tmp_path / WORKSPACE).mkdir()
    (tmp_path / f"tmp-{WORKSPACE}").mkdir()
    runtime = FormalExecutionRuntime(
        claim_validator=validator,
        supervisor=InternalExecutionSupervisor(),
        id_factory=lambda: EXECUTION,
        manager=manager,
    )
    return runtime, manager


@pytest.mark.asyncio
async def test_created_claim_executes_once_with_formal_id_then_finalizes(
    monkeypatch, tmp_path: Path
) -> None:
    validator = Validator()
    manager = Manager()
    monkeypatch.setattr(
        "sandbox.services.formal_execution_runtime.workspace_manager.init_workspace",
        lambda workspace_id: tmp_path / workspace_id,
    )
    monkeypatch.setattr(
        "sandbox.services.formal_execution_runtime.workspace_manager.init_temp",
        lambda workspace_id: tmp_path / f"tmp-{workspace_id}",
    )
    (tmp_path / WORKSPACE).mkdir()
    (tmp_path / f"tmp-{WORKSPACE}").mkdir()
    runtime = FormalExecutionRuntime(
        claim_validator=validator,
        supervisor=InternalExecutionSupervisor(),
        id_factory=lambda: EXECUTION,
        manager=manager,
    )
    body, claims = _request()

    response = await runtime.handle(claims=claims, raw_body=body, tool_name="bash")

    assert response.status_code == 200
    assert json.loads(response.body) == {
        "exitCode": 0,
        "stdout": "ok",
        "stderr": "",
        "truncated": False,
        "durationMs": 4.5,
    }
    assert validator.claims == [
        {
            "org_id": ORG,
            "user_id": USER,
            "execution_id": EXECUTION,
            "sandbox_session_id": SBX,
            "run_id": RUN,
            "agent_session_id": AGENT,
            "conversation_id": CONV,
            "tool_execution_id": TOOL_EXEC,
            "tool_call_id": TOOL_CALL,
            "tool_name": "bash",
            "kind": "bash",
            "request_hash": claims["request_hash"],
            "request_hash_version": 1,
            "execution_fence_token": FENCE,
            "trace_id": TRACE,
        }
    ]
    assert len(manager.calls) == 1
    assert manager.calls[0]["execution_id"] == EXECUTION
    assert manager.calls[0]["formal_claimed"] is True
    assert manager.calls[0]["context"].workspace_id == WORKSPACE
    assert validator.finalizations == [
        {
            "org_id": ORG,
            "user_id": USER,
            "execution_id": EXECUTION,
            "execution_fence_token": FENCE,
            "status": SANDBOX_EXECUTION_STATUS_SUCCESS,
            "result_json": json.loads(response.body),
            "exit_code": 0,
            "error_code": None,
        }
    ]


@pytest.mark.asyncio
async def test_existing_terminal_claim_replays_without_runner_or_finalize() -> None:
    result = {"exitCode": 0, "stdout": "prior", "stderr": "", "truncated": False, "durationMs": 1.0}
    validator = Validator(
        created=False,
        record=_record(status=SANDBOX_EXECUTION_STATUS_SUCCESS, result=result),
    )
    manager = Manager()
    runtime = FormalExecutionRuntime(
        claim_validator=validator,
        supervisor=InternalExecutionSupervisor(),
        id_factory=lambda: EXECUTION,
        manager=manager,
    )
    body, claims = _request()

    response = await runtime.handle(claims=claims, raw_body=body, tool_name="bash")

    assert response.status_code == 200
    assert json.loads(response.body) == result
    assert manager.calls == []
    assert validator.finalizations == []


@pytest.mark.asyncio
async def test_finalize_failure_marks_unknown_and_clears_inflight(
    monkeypatch, tmp_path: Path
) -> None:
    validator = Validator(finalize_error=RuntimeError("finalize unavailable"))
    runtime, manager = _runtime_with_workspace(monkeypatch, tmp_path, validator)
    body, claims = _request()

    with pytest.raises(HTTPException) as caught:
        await runtime.handle(claims=claims, raw_body=body, tool_name="bash")

    assert caught.value.status_code == 503
    assert len(manager.calls) == 1
    assert validator.finalizations == []
    assert validator.unknown == [
        {
            "org_id": ORG,
            "user_id": USER,
            "execution_id": EXECUTION,
            "execution_fence_token": FENCE,
            "error_code": "POST_EXECUTION_FINALIZE_FAILED",
            "result_json": {
                "unknown": True,
                "reason": "POST_EXECUTION_FINALIZE_FAILED",
            },
        }
    ]
    assert runtime._inflight == {}


@pytest.mark.asyncio
async def test_finalize_and_unknown_recovery_failure_keeps_inflight(
    monkeypatch, tmp_path: Path
) -> None:
    validator = Validator(
        finalize_error=RuntimeError("finalize unavailable"),
        unknown_error=RuntimeError("mysql unavailable"),
    )
    runtime, manager = _runtime_with_workspace(monkeypatch, tmp_path, validator)
    body, claims = _request()

    with pytest.raises(HTTPException) as caught:
        await runtime.handle(claims=claims, raw_body=body, tool_name="bash")

    assert caught.value.status_code == 503
    assert len(manager.calls) == 1
    assert validator.finalizations == []
    assert validator.unknown == []
    assert runtime._inflight == {
        EXECUTION: {
            "org_id": ORG,
            "user_id": USER,
            "execution_id": EXECUTION,
            "execution_fence_token": FENCE,
        }
    }
    validator.unknown_error = None
    assert runtime.reconcile_inflight_as_unknown() == 1
    assert validator.unknown[0]["error_code"] == "SHUTDOWN_DRAIN_TIMEOUT"
    assert runtime._inflight == {}


def test_shutdown_reconcile_marks_registered_execution_unknown_once() -> None:
    validator = Validator()
    runtime = FormalExecutionRuntime(
        claim_validator=validator,
        supervisor=InternalExecutionSupervisor(),
        id_factory=lambda: EXECUTION,
        manager=Manager(),
    )
    body, claims = _request()
    command = parse_and_bind_internal_execution(body, claims, tool_name="bash")
    runtime._register_inflight(command, _record())

    assert runtime.reconcile_inflight_as_unknown() == 1
    assert runtime.reconcile_inflight_as_unknown() == 0
    assert validator.unknown[0]["execution_id"] == EXECUTION
    assert validator.unknown[0]["error_code"] == "SHUTDOWN_DRAIN_TIMEOUT"


def test_formal_execution_manager_entries_never_touch_legacy_repository() -> None:
    class Repo:
        def __init__(self) -> None:
            self.calls = 0

        def upsert(self, entry: dict[str, Any]) -> None:
            self.calls += 1

    manager = object.__new__(ExecutionManager)
    manager.repository = Repo()
    manager._executions = {}
    manager._session_locks = {}
    manager._runner_active = set()
    manager._active_procs = {}
    manager._cancel_requested = set()
    manager._lock = threading.RLock()
    manager._total_count = 0
    manager._isolation = type("Isolation", (), {"name": "test"})()
    entry = manager._new_entry(EXECUTION, SBX, "command", workspace_id=WORKSPACE)
    entry["_formal_claimed"] = True

    assert manager._admit(WORKSPACE, EXECUTION, entry) is None
    manager._finalize(
        SBX,
        EXECUTION,
        entry,
        result={"exit_code": 0, "stdout_preview": "ok", "stderr_preview": ""},
    )

    assert manager.repository.calls == 0


@pytest.mark.parametrize("method_name", ["run_command", "run_python"])
def test_formal_execution_manager_rejects_non_ulid_execution_id(
    tmp_path: Path, method_name: str
) -> None:
    manager = object.__new__(ExecutionManager)
    context = SandboxExecutionContext(
        session_id=SBX,
        workspace_id=WORKSPACE,
        temp_id="tmp",
        physical_workspace=tmp_path,
        physical_temp=tmp_path,
    )
    kwargs: dict[str, Any] = {
        "session_id": SBX,
        "context": context,
        "execution_id": "exec_legacy",
        "formal_claimed": True,
    }
    if method_name == "run_command":
        kwargs["command"] = "printf ok"
    else:
        kwargs["code"] = "print('ok')"

    with pytest.raises(ValueError, match="formal ULID|Crockford"):
        getattr(manager, method_name)(**kwargs)


@pytest.mark.asyncio
async def test_invalid_contract_is_rejected_before_supervisor_admission() -> None:
    runtime = FormalExecutionRuntime(
        claim_validator=Validator(),
        supervisor=InternalExecutionSupervisor(),
        id_factory=lambda: EXECUTION,
        manager=Manager(),
    )
    body, claims = _request()
    claims["run_id"] = "01K0G2PAV8FPMVC9QHJG7JPN99"

    with pytest.raises(HTTPException) as caught:
        await runtime.handle(claims=claims, raw_body=body, tool_name="bash")

    assert caught.value.status_code == 400
    assert runtime.supervisor.active_count == 0
