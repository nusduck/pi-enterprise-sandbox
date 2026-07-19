import json

import pytest

from sandbox.app.domain.internal_process_contract import (
    InternalProcessCommand,
    InternalProcessContractError,
    parse_and_bind_internal_process,
)
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.services.formal_process_runtime import FormalProcessRuntime
from sandbox.services.internal_execution_supervisor import InternalExecutionSupervisor
from sandbox.trace import get_trace_id, reset_trace_id, set_trace_id

IDS = {
    "orgId": "01K0G2PAV8FPMVC9QHJG7JPN4Z",
    "userId": "01K0G2PAV8FPMVC9QHJG7JPN50",
    "conversationId": "01K0G2PAV8FPMVC9QHJG7JPN51",
    "agentSessionId": "01K0G2PAV8FPMVC9QHJG7JPN52",
    "runId": "01K0G2PAV8FPMVC9QHJG7JPN5H",
    "sandboxSessionId": "01K0G2PAV8FPMVC9QHJG7JPN5F",
    "traceId": "b" * 32,
    "executionFenceToken": 7,
}


def make(tool="process_start", args=None):
    args = args or {"command": "sleep 1", "env": {}, "timeoutSeconds": 30}
    h = compute_tool_request_hash_v1(tool_name=tool, args=args)
    body = {**args, "identity": IDS, "toolExecutionId": "01K0G2PAV8FPMVC9QHJG7PJN70", "toolCallId": "call-1", "requestHash": h["requestHash"], "requestHashVersion": 1}
    claims = {"scope": [f"sandbox.processes.{tool}"], "tool_name": tool, "org_id": IDS["orgId"], "user_id": IDS["userId"], "conversation_id": IDS["conversationId"], "agent_session_id": IDS["agentSessionId"], "run_id": IDS["runId"], "sandbox_session_id": IDS["sandboxSessionId"], "trace_id": IDS["traceId"], "execution_fence_token": 7, "tool_execution_id": body["toolExecutionId"], "tool_call_id": "call-1", "request_hash": h["requestHash"], "request_hash_version": 1}
    return body, claims


def test_process_contract_binds_hash_and_identity():
    body, claims = make()
    out = parse_and_bind_internal_process(json.dumps(body, separators=(",", ":")).encode(), claims, tool_name="process_start")
    assert out.args["command"] == "sleep 1"


def test_process_contract_rejects_hash_mismatch():
    body, claims = make()
    body["command"] = "echo changed"
    with pytest.raises(InternalProcessContractError, match="requestHash mismatch"):
        parse_and_bind_internal_process(json.dumps(body).encode(), claims, tool_name="process_start")


def test_process_kill_rejects_signal_outside_formal_allowlist():
    body, claims = make(
        "process_kill",
        {
            "processId": "01K0G2PAV8FPMVC9QHJG7PJN71",
            "signal": "SIGSTOP",
        },
    )

    with pytest.raises(InternalProcessContractError, match="signal invalid"):
        parse_and_bind_internal_process(
            json.dumps(body).encode(), claims, tool_name="process_kill"
        )


def test_formal_process_runtime_uses_claim_trace_and_restores_context():
    observed: list[str | None] = []

    class Manager:
        def get_owned(self, *_args, **_kwargs):
            observed.append(get_trace_id())
            return None

    command = InternalProcessCommand(
        tool_name="process_status",
        args={"processId": "01K0G2PAV8FPMVC9QHJG7PJN71"},
        org_id=IDS["orgId"],
        user_id=IDS["userId"],
        conversation_id=IDS["conversationId"],
        agent_session_id=IDS["agentSessionId"],
        run_id=IDS["runId"],
        sandbox_session_id=IDS["sandboxSessionId"],
        trace_id=IDS["traceId"],
        execution_fence_token=7,
        tool_execution_id="01K0G2PAV8FPMVC9QHJG7PJN70",
        tool_call_id="call-1",
        request_hash="a" * 64,
        request_hash_version=1,
    )
    runtime = FormalProcessRuntime(
        claim_validator=object(),
        supervisor=InternalExecutionSupervisor(max_active=1),
        id_factory=lambda: "01K0G2PAV8FPMVC9QHJG7PJN72",
        manager=Manager(),
    )
    outer = set_trace_id("a" * 32)
    try:
        runtime._run_sync(command, "01K0G2PAV8FPMVC9QHJG7PJN72", "workspace")
        assert observed == [IDS["traceId"]]
        assert get_trace_id() == "a" * 32
    finally:
        reset_trace_id(outer)


def test_formal_process_runtime_emits_shared_lowercase_process_statuses():
    process_id = "01K0G2PAV8FPMVC9QHJG7PJN71"

    class Manager:
        def get_owned(self, *_args, **_kwargs):
            return {"process_id": process_id, "status": "WAITING_INPUT"}

        def read_stream_owned(self, *_args, **_kwargs):
            return {
                "stream": "stdout",
                "cursor": "0-0",
                "next_cursor": "0-1",
                "data": "x",
                "status": "COMPLETED",
            }

        def signal_process_owned(self, *_args, **_kwargs):
            return {"ok": True, "signaled": True, "status": "CANCEL_REQUESTED"}

    runtime = FormalProcessRuntime(
        claim_validator=object(),
        supervisor=InternalExecutionSupervisor(max_active=1),
        id_factory=lambda: "01K0G2PAV8FPMVC9QHJG7PJN72",
        manager=Manager(),
    )

    def command(tool_name, args):
        return InternalProcessCommand(
            tool_name=tool_name,
            args=args,
            org_id=IDS["orgId"],
            user_id=IDS["userId"],
            conversation_id=IDS["conversationId"],
            agent_session_id=IDS["agentSessionId"],
            run_id=IDS["runId"],
            sandbox_session_id=IDS["sandboxSessionId"],
            trace_id=IDS["traceId"],
            execution_fence_token=7,
            tool_execution_id="01K0G2PAV8FPMVC9QHJG7PJN70",
            tool_call_id="call-1",
            request_hash="a" * 64,
            request_hash_version=1,
        )

    status, _, _ = runtime._run_sync_with_trace(
        command("process_status", {"processId": process_id}), "execution", "workspace"
    )
    read, _, _ = runtime._run_sync_with_trace(
        command(
            "process_read",
            {"processId": process_id, "stream": "stdout", "cursor": "0-0", "limit": 8},
        ),
        "execution",
        "workspace",
    )
    killed, _, _ = runtime._run_sync_with_trace(
        command("process_kill", {"processId": process_id, "signal": "TERM"}),
        "execution",
        "workspace",
    )

    assert status["status"] == "running"
    assert read["status"] == "completed"
    assert killed["status"] == "running"
