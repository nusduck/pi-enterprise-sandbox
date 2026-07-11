"""Agent run / event / tool-ledger API for session persistence MVP."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from sandbox.models import (
    AgentEventAppend,
    AgentEventResponse,
    AgentRunCreate,
    AgentRunResponse,
    ClaimLeaseRequest,
    ToolExecutionPrepare,
    ToolExecutionResponse,
    TOOL_TERMINAL_STATUSES,
)
from sandbox.services.agent_run_manager import agent_run_manager

router = APIRouter(tags=["agent-runs"])


class InterruptBody(BaseModel):
    reason: str | None = None
    partial_text: str | None = None


class ToolTerminalBody(BaseModel):
    status: str
    summary: str | None = None


class CompleteBody(BaseModel):
    lease_owner: str | None = None


class FailBody(BaseModel):
    error: str | None = None
    lease_owner: str | None = None


@router.post("/agent-runs", response_model=AgentRunResponse, status_code=201)
def create_agent_run(body: AgentRunCreate):
    """Create run, claim lease, stamp conversation.last_run_id."""
    return agent_run_manager.start_run(
        conversation_id=body.conversation_id,
        owner_user_id=body.owner_user_id,
        organization_id=body.organization_id,
        sandbox_session_id=body.sandbox_session_id,
        workspace_id=body.workspace_id,
        model_id=body.model_id,
        lease_owner=body.lease_owner,
        lease_seconds=body.lease_seconds,
    )


@router.get("/agent-runs/{run_id}", response_model=AgentRunResponse)
def get_agent_run(run_id: str):
    run = agent_run_manager.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return run


@router.post("/agent-runs/{run_id}/claim", response_model=AgentRunResponse)
def claim_agent_run(run_id: str, body: ClaimLeaseRequest):
    claimed = agent_run_manager.claim_lease(
        run_id,
        lease_owner=body.lease_owner,
        expected_version=body.expected_version,
        lease_seconds=body.lease_seconds,
    )
    if claimed is None:
        raise HTTPException(status_code=409, detail="Lease claim conflict")
    return claimed


@router.post("/agent-runs/{run_id}/release", response_model=AgentRunResponse)
def release_agent_run(run_id: str, body: CompleteBody):
    if not body.lease_owner:
        raise HTTPException(status_code=400, detail="lease_owner is required")
    released = agent_run_manager.release_lease(
        run_id, lease_owner=body.lease_owner, status="completed"
    )
    if released is None:
        raise HTTPException(status_code=409, detail="Lease release failed")
    return released


@router.post("/agent-runs/{run_id}/complete", response_model=AgentRunResponse)
def complete_agent_run(run_id: str, body: CompleteBody | None = None):
    body = body or CompleteBody()
    updated = agent_run_manager.complete_run(run_id, lease_owner=body.lease_owner)
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return updated


@router.post("/agent-runs/{run_id}/fail", response_model=AgentRunResponse)
def fail_agent_run(run_id: str, body: FailBody | None = None):
    body = body or FailBody()
    updated = agent_run_manager.fail_run(
        run_id, error=body.error, lease_owner=body.lease_owner
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return updated


@router.post("/agent-runs/{run_id}/interrupt", response_model=AgentRunResponse)
def interrupt_agent_run(run_id: str, body: InterruptBody | None = None):
    body = body or InterruptBody()
    updated = agent_run_manager.mark_interrupted(
        run_id, reason=body.reason, partial_text=body.partial_text
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return updated


@router.post(
    "/agent-runs/{run_id}/events",
    response_model=AgentEventResponse,
    status_code=201,
)
def append_agent_event(run_id: str, body: AgentEventAppend):
    if not agent_run_manager.get_run(run_id):
        raise HTTPException(status_code=404, detail="Agent run not found")
    return agent_run_manager.append_event(
        run_id,
        event_type=body.type,
        payload=body.payload,
        event_id=body.event_id,
        schema_version=body.schema_version,
    )


@router.get("/agent-runs/{run_id}/events", response_model=list[AgentEventResponse])
def list_agent_events(
    run_id: str,
    after_sequence: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=5000),
):
    if not agent_run_manager.get_run(run_id):
        raise HTTPException(status_code=404, detail="Agent run not found")
    return agent_run_manager.list_events(
        run_id, after_sequence=after_sequence, limit=limit
    )


@router.get(
    "/conversations/{conversation_id}/agent-runs/latest",
    response_model=AgentRunResponse,
)
def get_latest_run(conversation_id: str):
    run = agent_run_manager.get_last_run_for_conversation(conversation_id)
    if not run:
        raise HTTPException(status_code=404, detail="No agent run for conversation")
    return run


@router.get(
    "/conversations/{conversation_id}/events",
    response_model=list[AgentEventResponse],
)
def list_conversation_events(
    conversation_id: str,
    after_sequence: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=5000),
):
    """Events for the conversation's last (or active) run — UI recovery helper."""
    run = agent_run_manager.get_last_run_for_conversation(conversation_id)
    if not run:
        return []
    return agent_run_manager.list_events(
        run.run_id, after_sequence=after_sequence, limit=limit
    )


@router.post(
    "/tool-executions",
    response_model=ToolExecutionResponse,
    status_code=201,
)
def prepare_tool_execution(body: ToolExecutionPrepare):
    return agent_run_manager.prepare_tool(
        tool_call_id=body.tool_call_id,
        run_id=body.run_id,
        idempotency_key=body.idempotency_key,
        summary=body.summary,
    )


@router.post(
    "/tool-executions/{tool_call_id}/executing",
    response_model=ToolExecutionResponse,
)
def mark_tool_executing(tool_call_id: str):
    updated = agent_run_manager.mark_tool_executing(tool_call_id)
    if updated is None:
        raise HTTPException(status_code=404, detail="Tool execution not found")
    return updated


@router.post(
    "/tool-executions/{tool_call_id}/terminal",
    response_model=ToolExecutionResponse,
)
def mark_tool_terminal(tool_call_id: str, body: ToolTerminalBody):
    if body.status not in TOOL_TERMINAL_STATUSES:
        raise HTTPException(
            status_code=400,
            detail=f"status must be one of {sorted(TOOL_TERMINAL_STATUSES)}",
        )
    updated = agent_run_manager.mark_tool_terminal(
        tool_call_id, body.status, summary=body.summary
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Tool execution not found")
    return updated


class ToolRetryCheck(BaseModel):
    tool_call_id: str
    can_auto_retry: bool


@router.get(
    "/tool-executions/{tool_call_id}/can-auto-retry",
    response_model=ToolRetryCheck,
)
def tool_can_auto_retry(tool_call_id: str):
    return ToolRetryCheck(
        tool_call_id=tool_call_id,
        can_auto_retry=agent_run_manager.tool_can_auto_retry(tool_call_id),
    )
