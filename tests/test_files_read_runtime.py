"""Orchestration tests for FilesReadRuntime (fakes only; offline)."""

from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import replace
from typing import Any

import pytest
from fastapi import HTTPException

from sandbox.app.domain.files_read_contract import READ_MAX_BYTES_FIXED
from sandbox.app.domain.tool_request_hash import compute_tool_request_hash_v1
from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_STATUS_CANCELLED,
    SANDBOX_EXECUTION_STATUS_FAILED,
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    SANDBOX_EXECUTION_STATUS_TIMEOUT,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
    ExecutionRecord,
)
from sandbox.app.domain.ulid import new_ulid
from sandbox.services.files_read_runtime import (
    FilesReadRuntime,
    filter_success_result,
)
from sandbox.services.internal_execution_supervisor import (
    SUPERVISOR_STATE_CLOSED,
    SUPERVISOR_STATE_CLOSING,
    SUPERVISOR_STATE_OPEN,
    InternalExecutionSupervisor,
    SupervisorAdmissionError,
)
from sandbox.services.internal_file_reader import InternalFileReadError

ORG = "01K0G2PAV8FPMVC9QHJG7JPN4Z"
USER = "01K0G2PAV8FPMVC9QHJG7JPN50"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN51"
AGENT = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
SBX = "01K0G2PAV8FPMVC9QHJG7JPN55"
TE = "01K0G2PAV8FPMVC9QHJG7JPN5K"
WS = "01K0G2PAV8FPMVC9QHJG7JPN56"
EXEC = "01K0G2PAV8FPMVC9QHJG7JPN60"
TC = "tc-orch-1"
TRACE = "0123456789abcdef0123456789abcdef"
PATH = "/home/sandbox/workspace/notes/a.txt"
FENCE = 7


def _hash(
    path: str = PATH,
    offset: int = 0,
    limit: int = 100,
    max_bytes: int = READ_MAX_BYTES_FIXED,
) -> str:
    return compute_tool_request_hash_v1(
        tool_name="read",
        args={
            "path": path,
            "offset": offset,
            "limit": limit,
            "maxBytes": max_bytes,
        },
    )["requestHash"]


def claims(**updates: Any) -> dict[str, Any]:
    out: dict[str, Any] = {
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT,
        "sandbox_session_id": SBX,
        "run_id": RUN,
        "tool_execution_id": TE,
        "tool_call_id": TC,
        "tool_name": "read",
        "scope": ["sandbox.files.read"],
        "request_hash": _hash(),
        "request_hash_version": 1,
        "execution_fence_token": FENCE,
        "trace_id": TRACE,
    }
    out.update(updates)
    return out


def body_bytes(**updates: Any) -> bytes:
    h = _hash()
    obj: dict[str, Any] = {
        "path": PATH,
        "offset": 0,
        "limit": 100,
        "maxBytes": READ_MAX_BYTES_FIXED,
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
        "toolExecutionId": TE,
        "toolCallId": TC,
        "requestHash": h,
        "requestHashVersion": 1,
    }
    obj.update(updates)
    return json.dumps(obj, separators=(",", ":")).encode("utf-8")


def _execution(
    *,
    status: str = SANDBOX_EXECUTION_STATUS_RUNNING,
    result_json: dict[str, Any] | None = None,
    execution_id: str = EXEC,
) -> ExecutionRecord:
    return ExecutionRecord(
        execution_id=execution_id,
        org_id=ORG,
        user_id=USER,
        sandbox_session_id=SBX,
        run_id=RUN,
        agent_session_id=AGENT,
        kind="read",
        status=status,
        created_at="2026-01-01 00:00:00",
        started_at="2026-01-01 00:00:00",
        result_json=result_json,
        tool_execution_id=TE,
        tool_call_id=TC,
        request_hash=_hash(),
        request_hash_version=1,
        execution_fence_token=FENCE,
        trace_id=TRACE,
    )


class FakeClaimValidator:
    def __init__(
        self,
        *,
        created: bool = True,
        execution: ExecutionRecord | None = None,
        workspace_id: str = WS,
        finalize_error: Exception | None = None,
        claim_side_effect: Any = None,
    ) -> None:
        self.created = created
        self.execution = execution or _execution()
        self.workspace_id = workspace_id
        self.finalize_error = finalize_error
        self.claim_side_effect = claim_side_effect
        self.claim_inputs: list[dict[str, Any]] = []
        self.finalize_inputs: list[dict[str, Any]] = []
        self.claim_thread_ids: list[int] = []
        self.finalize_thread_ids: list[int] = []
        self._claim_count = 0
        # Concurrent: only first claim wins created=True for same tool call.
        self.race_created_once = False
        self._race_lock = threading.Lock()
        self._race_winner_exec: ExecutionRecord | None = None

    def enable_race_single_created(self) -> None:
        self.race_created_once = True

    def claim(self, input: dict[str, Any]) -> dict[str, Any]:
        self.claim_thread_ids.append(threading.get_ident())
        self.claim_inputs.append(dict(input))
        if self.claim_side_effect is not None:
            if callable(self.claim_side_effect):
                return self.claim_side_effect(input)
            raise self.claim_side_effect
        if self.race_created_once:
            with self._race_lock:
                self._claim_count += 1
                if self._claim_count == 1:
                    exec_rec = replace(
                        self.execution,
                        execution_id=str(input["execution_id"]),
                        status=SANDBOX_EXECUTION_STATUS_RUNNING,
                    )
                    self._race_winner_exec = exec_rec
                    return {
                        "created": True,
                        "execution": exec_rec,
                        "workspace_id": self.workspace_id,
                    }
                assert self._race_winner_exec is not None
                return {
                    "created": False,
                    "execution": self._race_winner_exec,
                    "workspace_id": self.workspace_id,
                }
        return {
            "created": self.created,
            "execution": self.execution
            if not self.created
            else replace(
                self.execution,
                execution_id=str(input["execution_id"]),
                status=SANDBOX_EXECUTION_STATUS_RUNNING,
            ),
            "workspace_id": self.workspace_id,
        }

    def finalize(self, input: dict[str, Any]) -> dict[str, Any]:
        self.finalize_thread_ids.append(threading.get_ident())
        self.finalize_inputs.append(dict(input))
        if self.finalize_error is not None:
            raise self.finalize_error
        return {
            "changed": True,
            "execution": replace(
                self.execution,
                status=str(input["status"]),
                result_json=input.get("result_json"),
            ),
        }


class FakeReader:
    def __init__(
        self,
        result: dict[str, Any] | None = None,
        error: Exception | None = None,
        *,
        block_until: threading.Event | None = None,
        started: threading.Event | None = None,
    ) -> None:
        self.result = result or {
            "path": PATH,
            "binary": False,
            "content": "hello\n",
            "truncated": False,
            "offset": 0,
            "limit": 100,
            "size": 6,
            "returnedLines": 1,
            "nextOffset": None,
            "mimeType": "text/plain",
        }
        self.error = error
        self.block_until = block_until
        self.started = started
        self.calls = 0
        self.thread_ids: list[int] = []
        self.kwargs: list[dict[str, Any]] = []

    def read(self, **kwargs: Any) -> dict[str, Any]:
        self.calls += 1
        self.thread_ids.append(threading.get_ident())
        self.kwargs.append(dict(kwargs))
        if self.started is not None:
            self.started.set()
        if self.block_until is not None:
            self.block_until.wait(timeout=10)
        if self.error is not None:
            raise self.error
        return dict(self.result)


def _runtime(
    claim: FakeClaimValidator | None = None,
    reader: FakeReader | None = None,
) -> tuple[FilesReadRuntime, FakeClaimValidator, FakeReader]:
    c = claim or FakeClaimValidator()
    r = reader or FakeReader()
    rt = FilesReadRuntime(
        claim_validator=c,
        reader=r,
        id_factory=new_ulid,
        supervisor=InternalExecutionSupervisor(),
    )
    return rt, c, r


@pytest.mark.asyncio
async def test_created_true_success_once() -> None:
    rt, claim, reader = _runtime()
    main_tid = threading.get_ident()
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 200
    body = json.loads(resp.body)
    assert body["content"] == "hello\n"
    assert body["path"] == PATH
    assert "physical" not in str(body).lower()
    assert rt.read_calls == 1
    assert rt.finalize_calls == 1
    assert reader.calls == 1
    assert claim.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_SUCCESS
    # claim/read/finalize off the event-loop thread
    assert claim.claim_thread_ids[0] != main_tid
    assert reader.thread_ids[0] != main_tid
    assert claim.finalize_thread_ids[0] != main_tid
    # workspace_id only from claim → reader
    assert reader.kwargs[0]["workspace_id"] == WS


@pytest.mark.asyncio
async def test_contract_failure_zero_claim_read_finalize() -> None:
    rt, claim, reader = _runtime()
    bad = body_bytes()
    # corrupt JSON float
    bad = bad.replace(b'"offset":0', b'"offset":1.5')
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=bad)
    assert ei.value.status_code == 400
    assert rt.claim_calls == 0
    assert rt.read_calls == 0
    assert rt.finalize_calls == 0
    assert reader.calls == 0
    assert claim.claim_inputs == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status,http_status,code",
    [
        (SANDBOX_EXECUTION_STATUS_RUNNING, 409, "IN_PROGRESS"),
        (SANDBOX_EXECUTION_STATUS_TIMEOUT, 504, None),
        (SANDBOX_EXECUTION_STATUS_CANCELLED, 409, "CANCELLED"),
        (SANDBOX_EXECUTION_STATUS_UNKNOWN, 409, "TOOL_OUTCOME_UNKNOWN"),
    ],
)
async def test_created_false_terminal_states_zero_read_finalize(
    status: str, http_status: int, code: str | None
) -> None:
    exec_rec = _execution(status=status)
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, reader = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == http_status
    if code is not None:
        assert ei.value.detail["code"] == code
    assert rt.read_calls == 0
    assert rt.finalize_calls == 0
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_created_false_success_replays_filtered() -> None:
    success_result = {
        "path": PATH,
        "binary": False,
        "content": "from-db\n",
        "truncated": False,
        "offset": 0,
        "limit": 100,
        "size": 8,
        "returnedLines": 1,
        "nextOffset": None,
        "mimeType": "text/plain",
        # poison fields must not leak
        "physicalPath": "/var/sandbox/workspaces/x/a.txt",
        "claimSecret": "secret",
    }
    exec_rec = _execution(
        status=SANDBOX_EXECUTION_STATUS_SUCCESS, result_json=success_result
    )
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, reader = _runtime(claim=claim)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 200
    body = json.loads(resp.body)
    assert body["content"] == "from-db\n"
    assert "physicalPath" not in body
    assert "claimSecret" not in body
    assert rt.read_calls == 0
    assert rt.finalize_calls == 0
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_created_false_failed_replays_envelope() -> None:
    env = {
        "error": {"code": "FILE_NOT_FOUND", "message": "file not found"},
        "httpStatus": 404,
    }
    exec_rec = _execution(status=SANDBOX_EXECUTION_STATUS_FAILED, result_json=env)
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, reader = _runtime(claim=claim)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 404
    body = json.loads(resp.body)
    assert body == {"error": {"code": "FILE_NOT_FOUND", "message": "file not found"}}
    assert rt.read_calls == 0
    assert rt.finalize_calls == 0


@pytest.mark.asyncio
async def test_created_false_corrupt_success_fail_closed() -> None:
    exec_rec = _execution(
        status=SANDBOX_EXECUTION_STATUS_SUCCESS,
        result_json={"garbage": True},
    )
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, _ = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 500
    assert rt.read_calls == 0


@pytest.mark.asyncio
async def test_reader_error_finalizes_failed() -> None:
    reader = FakeReader(
        error=InternalFileReadError("FILE_NOT_FOUND", "file not found")
    )
    rt, claim, _ = _runtime(reader=reader)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 404
    body = json.loads(resp.body)
    assert body["error"]["code"] == "FILE_NOT_FOUND"
    assert rt.read_calls == 1
    assert rt.finalize_calls == 1
    fin = claim.finalize_inputs[0]
    assert fin["status"] == SANDBOX_EXECUTION_STATUS_FAILED
    assert fin["result_json"]["httpStatus"] == 404
    assert fin["error_code"] == "FILE_NOT_FOUND"


@pytest.mark.asyncio
async def test_finalize_error_read_still_one_ledger_running() -> None:
    claim = FakeClaimValidator(finalize_error=RuntimeError("db down"))
    rt, _, reader = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 503
    assert reader.calls == 1
    assert rt.read_calls == 1
    assert rt.finalize_calls == 1  # attempted once
    # No second read on finalize failure
    assert reader.calls == 1
    # Keep the claimed RUNNING row registered for shutdown UNKNOWN recovery.
    assert rt.inflight_claim_count() == 1


@pytest.mark.asyncio
async def test_result_filtering_no_leak() -> None:
    reader = FakeReader(
        result={
            "path": PATH,
            "binary": False,
            "content": "x\n",
            "truncated": False,
            "offset": 0,
            "limit": 100,
            "size": 2,
            "returnedLines": 1,
            "nextOffset": None,
            "mimeType": "text/plain",
            "hostPath": "/Users/eddie/secret",
            "stack": "traceback",
        }
    )
    rt, claim, _ = _runtime(reader=reader)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    body = json.loads(resp.body)
    assert "hostPath" not in body
    assert "stack" not in body
    stored = claim.finalize_inputs[0]["result_json"]
    assert "hostPath" not in stored
    assert "stack" not in stored


@pytest.mark.asyncio
async def test_client_cancel_still_finalizes_once() -> None:
    release = threading.Event()
    started = threading.Event()
    reader = FakeReader(block_until=release, started=started)
    claim = FakeClaimValidator()
    rt, _, _ = _runtime(claim=claim, reader=reader)

    async def _run() -> Any:
        return await rt.handle(claims=claims(), raw_body=body_bytes())

    task = asyncio.create_task(_run())
    # Wait until reader has entered the blocking section.
    for _ in range(100):
        if started.is_set():
            break
        await asyncio.sleep(0.01)
    assert started.is_set()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Release reader; supervised work should still finalize exactly once.
    release.set()
    for _ in range(100):
        if claim.finalize_inputs:
            break
        await asyncio.sleep(0.01)
    assert len(claim.finalize_inputs) == 1
    assert claim.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_SUCCESS
    assert reader.calls == 1
    assert rt.finalize_calls == 1


@pytest.mark.asyncio
async def test_client_cancel_during_claim_still_read_finalize_once() -> None:
    """Cancel while claim is blocking RUNNING: caller CancelledError; bg still
    completes exactly one read+finalize when created=true.
    """
    claim_started = threading.Event()
    claim_release = threading.Event()
    held_input: list[dict[str, Any]] = []

    def _blocking_claim(input: dict[str, Any]) -> dict[str, Any]:
        held_input.append(dict(input))
        claim_started.set()
        claim_release.wait(timeout=10)
        return {
            "created": True,
            "execution": replace(
                _execution(),
                execution_id=str(input["execution_id"]),
                status=SANDBOX_EXECUTION_STATUS_RUNNING,
            ),
            "workspace_id": WS,
        }

    claim = FakeClaimValidator(claim_side_effect=_blocking_claim)
    reader = FakeReader()
    rt, _, _ = _runtime(claim=claim, reader=reader)

    async def _run() -> Any:
        return await rt.handle(claims=claims(), raw_body=body_bytes())

    task = asyncio.create_task(_run())
    for _ in range(100):
        if claim_started.is_set():
            break
        await asyncio.sleep(0.01)
    assert claim_started.is_set()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    # Background supervised task must continue after claim returns created=true.
    claim_release.set()
    for _ in range(100):
        if claim.finalize_inputs:
            break
        await asyncio.sleep(0.01)
    assert len(held_input) == 1
    assert reader.calls == 1
    assert len(claim.finalize_inputs) == 1
    assert claim.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_SUCCESS
    assert rt.read_calls == 1
    assert rt.finalize_calls == 1


@pytest.mark.asyncio
async def test_client_cancel_during_claim_created_false_replay_only() -> None:
    """created=false after cancel-during-claim: replay only, zero read/finalize."""
    claim_started = threading.Event()
    claim_release = threading.Event()
    exec_rec = _execution(status=SANDBOX_EXECUTION_STATUS_RUNNING)

    def _blocking_claim(input: dict[str, Any]) -> dict[str, Any]:
        claim_started.set()
        claim_release.wait(timeout=10)
        return {
            "created": False,
            "execution": exec_rec,
            "workspace_id": WS,
        }

    claim = FakeClaimValidator(claim_side_effect=_blocking_claim)
    reader = FakeReader()
    rt, _, _ = _runtime(claim=claim, reader=reader)

    async def _run() -> Any:
        return await rt.handle(claims=claims(), raw_body=body_bytes())

    task = asyncio.create_task(_run())
    for _ in range(100):
        if claim_started.is_set():
            break
        await asyncio.sleep(0.01)
    assert claim_started.is_set()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    claim_release.set()
    for _ in range(50):
        await asyncio.sleep(0.01)
        if rt.claim_calls >= 1 and rt.supervisor.active_count == 0:
            break
    assert rt.claim_calls == 1
    assert reader.calls == 0
    assert rt.read_calls == 0
    assert rt.finalize_calls == 0
    assert claim.finalize_inputs == []


@pytest.mark.asyncio
async def test_supervisor_max_active_rejects_with_503_zero_claim() -> None:
    release = threading.Event()
    started = threading.Event()
    reader = FakeReader(block_until=release, started=started)
    claim = FakeClaimValidator()
    sup = InternalExecutionSupervisor(max_active=1)
    rt = FilesReadRuntime(
        claim_validator=claim,
        reader=reader,
        id_factory=new_ulid,
        supervisor=sup,
    )

    async def _run() -> Any:
        return await rt.handle(claims=claims(), raw_body=body_bytes())

    first = asyncio.create_task(_run())
    for _ in range(100):
        if started.is_set():
            break
        await asyncio.sleep(0.01)
    assert started.is_set()
    assert sup.active_count == 1

    # Second request must be rejected before claim (capacity full).
    claim_before = len(claim.claim_inputs)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 503
    assert len(claim.claim_inputs) == claim_before
    assert rt.claim_calls == 1  # only the admitted first request

    release.set()
    resp = await first
    assert resp.status_code == 200
    assert reader.calls == 1


@pytest.mark.asyncio
async def test_supervisor_closing_rejects_without_claim() -> None:
    release = asyncio.Event()
    sup = InternalExecutionSupervisor(max_active=4)

    async def _hold() -> str:
        await release.wait()
        return "held"

    waiter = asyncio.create_task(sup.run_shielded(_hold()))
    await asyncio.sleep(0)
    assert sup.active_count == 1
    assert sup.state == SUPERVISOR_STATE_OPEN

    # Transition to CLOSING without finishing the in-flight task.
    drain = asyncio.create_task(sup.close_and_drain(0.05))
    await asyncio.sleep(0)
    assert sup.state == SUPERVISOR_STATE_CLOSING

    claim = FakeClaimValidator()
    reader = FakeReader()
    rt = FilesReadRuntime(
        claim_validator=claim,
        reader=reader,
        id_factory=new_ulid,
        supervisor=sup,
    )
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 503
    assert claim.claim_inputs == []
    assert rt.claim_calls == 0
    assert reader.calls == 0

    timed_out = await drain
    assert timed_out is False
    assert sup.active_count == 1
    assert sup.state == SUPERVISOR_STATE_CLOSING

    release.set()
    assert await waiter == "held"
    ok = await sup.close_and_drain(1.0)
    assert ok is True
    assert sup.state == SUPERVISOR_STATE_CLOSED
    assert sup.active_count == 0


@pytest.mark.asyncio
async def test_supervisor_drain_success_and_timeout() -> None:
    sup = InternalExecutionSupervisor(max_active=2)
    release = asyncio.Event()

    async def _hold() -> int:
        await release.wait()
        return 1

    t = asyncio.create_task(sup.run_shielded(_hold()))
    await asyncio.sleep(0)
    assert await sup.close_and_drain(0.02) is False
    assert sup.state == SUPERVISOR_STATE_CLOSING
    assert sup.active_count == 1

    # Rejected admission must close the coroutine (no unawaited warning).
    async def _orphan() -> None:
        return None

    with pytest.raises(SupervisorAdmissionError):
        sup.spawn(_orphan())

    release.set()
    assert await t == 1
    assert await sup.close_and_drain(1.0) is True
    assert sup.state == SUPERVISOR_STATE_CLOSED
    assert sup.active_count == 0

    # Already closed, empty → True.
    assert await sup.close_and_drain(0.0) is True


def test_supervisor_max_active_must_be_positive() -> None:
    with pytest.raises(ValueError, match="max_active"):
        InternalExecutionSupervisor(max_active=0)
    with pytest.raises(ValueError, match="max_active"):
        InternalExecutionSupervisor(max_active=-1)
    with pytest.raises(ValueError, match="max_active"):
        InternalExecutionSupervisor(max_active=True)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_concurrent_two_jti_reader_once() -> None:
    claim = FakeClaimValidator()
    claim.enable_race_single_created()
    reader = FakeReader()
    rt = FilesReadRuntime(
        claim_validator=claim,
        reader=reader,
        id_factory=new_ulid,
        supervisor=InternalExecutionSupervisor(),
    )

    async def one() -> Any:
        return await rt.handle(claims=claims(), raw_body=body_bytes())

    r1, r2 = await asyncio.gather(one(), one(), return_exceptions=True)
    # One success 200; the other is 409 IN_PROGRESS (RUNNING replay) or also
    # 200 if it awaited after finalize — race-dependent. Reader must be 1.
    assert reader.calls == 1
    assert rt.read_calls == 1
    statuses = []
    for r in (r1, r2):
        if isinstance(r, HTTPException):
            statuses.append(r.status_code)
        else:
            statuses.append(r.status_code)
    assert 200 in statuses
    # Second may be 200 (if first finalized before second claim) or 409.
    assert all(s in (200, 409) for s in statuses)


def test_filter_success_rejects_arbitrary() -> None:
    from sandbox.app.domain.files_read_contract import ReadCommand

    cmd = ReadCommand(
        path=PATH,
        offset=0,
        limit=100,
        max_bytes=READ_MAX_BYTES_FIXED,
        org_id=ORG,
        user_id=USER,
        conversation_id=CONV,
        agent_session_id=AGENT,
        run_id=RUN,
        sandbox_session_id=SBX,
        trace_id=TRACE,
        execution_fence_token=FENCE,
        tool_execution_id=TE,
        tool_call_id=TC,
        request_hash=_hash(),
        request_hash_version=1,
    )
    with pytest.raises(ValueError):
        filter_success_result({"ok": True}, cmd)


@pytest.mark.asyncio
async def test_id_factory_rejects_exec_prefix() -> None:
    rt, claim, reader = _runtime()
    rt.id_factory = lambda: "exec_deadbeef"
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    # Invalid id fails before claim; mapped to 503.
    assert ei.value.status_code == 503
    assert claim.claim_inputs == []
    assert rt.claim_calls == 0
    assert rt.read_calls == 0
    assert rt.finalize_calls == 0
    assert reader.calls == 0


# ── Strict integrity branches (created / ULID / SUCCESS bind / FAILED) ──


@pytest.mark.asyncio
async def test_created_string_false_fail_closed_no_read() -> None:
    """created='false' must not coerce via bool(); never read or finalize."""

    def _side_effect(input: dict[str, Any]) -> dict[str, Any]:
        return {
            "created": "false",  # truthy if bool() — must be rejected
            "execution": _execution(status=SANDBOX_EXECUTION_STATUS_SUCCESS),
            "workspace_id": WS,
        }

    claim = FakeClaimValidator(claim_side_effect=_side_effect)
    rt, _, reader = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 500
    assert rt.read_calls == 0
    assert rt.finalize_calls == 0
    assert reader.calls == 0
    # claim was attempted (validator returned) but no side effects after
    assert len(claim.claim_inputs) == 1
    assert claim.finalize_inputs == []


@pytest.mark.asyncio
async def test_created_int_zero_fail_closed_no_read() -> None:
    def _side_effect(input: dict[str, Any]) -> dict[str, Any]:
        return {
            "created": 0,
            "execution": _execution(),
            "workspace_id": WS,
        }

    claim = FakeClaimValidator(claim_side_effect=_side_effect)
    rt, _, reader = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 500
    assert reader.calls == 0
    assert rt.finalize_calls == 0


@pytest.mark.asyncio
async def test_invalid_ulid_id_factory_no_claim() -> None:
    rt, claim, reader = _runtime()
    rt.id_factory = lambda: "not-a-ulid"
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 503
    assert claim.claim_inputs == []
    assert rt.claim_calls == 0
    assert reader.calls == 0
    assert rt.finalize_calls == 0


@pytest.mark.asyncio
async def test_id_factory_lowercase_ulid_canonicalized() -> None:
    """Lowercase formal ULID is accepted and claim sees uppercase."""
    lower = EXEC.lower()
    assert lower != EXEC
    seen: list[str] = []

    def factory() -> str:
        return lower

    claim = FakeClaimValidator()
    rt, _, _ = _runtime(claim=claim)
    rt.id_factory = factory
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 200
    assert claim.claim_inputs[0]["execution_id"] == EXEC  # uppercase


@pytest.mark.asyncio
async def test_new_read_wrong_path_does_not_finalize_success() -> None:
    reader = FakeReader(
        result={
            "path": "/home/sandbox/workspace/other.txt",
            "binary": False,
            "content": "x\n",
            "truncated": False,
            "offset": 0,
            "limit": 100,
            "size": 2,
            "returnedLines": 1,
            "nextOffset": None,
            "mimeType": "text/plain",
        }
    )
    rt, claim, _ = _runtime(reader=reader)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    # Filter fails → FAILED envelope, never SUCCESS finalize.
    assert resp.status_code == 500
    assert len(claim.finalize_inputs) == 1
    assert claim.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_FAILED
    assert claim.finalize_inputs[0]["result_json"]["error"]["code"] == "READ_FAILED"


@pytest.mark.asyncio
async def test_new_read_wrong_offset_does_not_finalize_success() -> None:
    reader = FakeReader(
        result={
            "path": PATH,
            "binary": False,
            "content": "x\n",
            "truncated": False,
            "offset": 99,  # command.offset is 0
            "limit": 100,
            "size": 2,
            "returnedLines": 1,
            "nextOffset": None,
            "mimeType": "text/plain",
        }
    )
    rt, claim, _ = _runtime(reader=reader)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 500
    assert claim.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_FAILED


@pytest.mark.asyncio
async def test_new_read_wrong_limit_does_not_finalize_success() -> None:
    reader = FakeReader(
        result={
            "path": PATH,
            "binary": False,
            "content": "x\n",
            "truncated": False,
            "offset": 0,
            "limit": 1,  # command.limit is 100
            "size": 2,
            "returnedLines": 1,
            "nextOffset": None,
            "mimeType": "text/plain",
        }
    )
    rt, claim, _ = _runtime(reader=reader)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 500
    assert claim.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_FAILED


@pytest.mark.asyncio
async def test_new_read_content_over_max_bytes_no_success() -> None:
    big = "x" * (READ_MAX_BYTES_FIXED + 1)
    reader = FakeReader(
        result={
            "path": PATH,
            "binary": False,
            "content": big,
            "truncated": False,
            "offset": 0,
            "limit": 100,
            "size": len(big),
            "returnedLines": 1,
            "nextOffset": None,
            "mimeType": "text/plain",
        }
    )
    rt, claim, _ = _runtime(reader=reader)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 500
    assert claim.finalize_inputs[0]["status"] == SANDBOX_EXECUTION_STATUS_FAILED


@pytest.mark.asyncio
async def test_replay_success_path_mismatch_fail_closed() -> None:
    success_result = {
        "path": "/home/sandbox/workspace/other.txt",
        "binary": False,
        "content": "from-db\n",
        "truncated": False,
        "offset": 0,
        "limit": 100,
        "size": 8,
        "returnedLines": 1,
        "nextOffset": None,
        "mimeType": "text/plain",
    }
    exec_rec = _execution(
        status=SANDBOX_EXECUTION_STATUS_SUCCESS, result_json=success_result
    )
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, reader = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 500
    assert reader.calls == 0
    assert rt.finalize_calls == 0


@pytest.mark.asyncio
async def test_corrupt_failed_code_fail_closed() -> None:
    env = {
        "error": {"code": "TOTALLY_UNKNOWN", "message": "nope"},
        "httpStatus": 500,
    }
    exec_rec = _execution(status=SANDBOX_EXECUTION_STATUS_FAILED, result_json=env)
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, reader = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 500
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_corrupt_failed_status_mismatch_fail_closed() -> None:
    # FILE_NOT_FOUND must map to 404, not 500.
    env = {
        "error": {"code": "FILE_NOT_FOUND", "message": "file not found"},
        "httpStatus": 500,
    }
    exec_rec = _execution(status=SANDBOX_EXECUTION_STATUS_FAILED, result_json=env)
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, reader = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 500
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_failed_message_with_host_path_fail_closed() -> None:
    env = {
        "error": {
            "code": "FILE_NOT_FOUND",
            "message": "missing /Users/eddie/secret.txt",
        },
        "httpStatus": 404,
    }
    exec_rec = _execution(status=SANDBOX_EXECUTION_STATUS_FAILED, result_json=env)
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, _ = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 500


@pytest.mark.asyncio
async def test_failed_message_with_newline_fail_closed() -> None:
    env = {
        "error": {"code": "FILE_NOT_FOUND", "message": "file not found\nstack"},
        "httpStatus": 404,
    }
    exec_rec = _execution(status=SANDBOX_EXECUTION_STATUS_FAILED, result_json=env)
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, _ = _runtime(claim=claim)
    with pytest.raises(HTTPException) as ei:
        await rt.handle(claims=claims(), raw_body=body_bytes())
    assert ei.value.status_code == 500


@pytest.mark.asyncio
async def test_failed_file_not_found_replay_still_works() -> None:
    env = {
        "error": {"code": "FILE_NOT_FOUND", "message": "file not found"},
        "httpStatus": 404,
    }
    exec_rec = _execution(status=SANDBOX_EXECUTION_STATUS_FAILED, result_json=env)
    claim = FakeClaimValidator(created=False, execution=exec_rec)
    rt, _, reader = _runtime(claim=claim)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 404
    assert json.loads(resp.body)["error"]["code"] == "FILE_NOT_FOUND"
    assert reader.calls == 0


@pytest.mark.asyncio
async def test_unknown_reader_code_normalized_to_read_failed() -> None:
    reader = FakeReader(
        error=InternalFileReadError("WEIRD_CODE", "something odd")
    )
    rt, claim, _ = _runtime(reader=reader)
    resp = await rt.handle(claims=claims(), raw_body=body_bytes())
    assert resp.status_code == 500
    body = json.loads(resp.body)
    assert body["error"]["code"] == "READ_FAILED"
    fin = claim.finalize_inputs[0]
    assert fin["status"] == SANDBOX_EXECUTION_STATUS_FAILED
    assert fin["result_json"]["error"]["code"] == "READ_FAILED"
    assert fin["result_json"]["httpStatus"] == 500
    assert fin["error_code"] == "READ_FAILED"
