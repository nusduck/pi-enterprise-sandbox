"""Agent run / event / tool-ledger API for session persistence MVP."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
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
from sandbox.repositories import (
    AgentEventIdConflictError,
    AgentRunNotFoundError,
    TaskPlanProjectionRepository,
)
from sandbox.config import settings
from sandbox.security.ownership import assert_resource_owner, require_actor

router = APIRouter(tags=["agent-runs"])
task_plan_projection = TaskPlanProjectionRepository()


class InterruptBody(BaseModel):
    reason: str | None = None
    partial_text: str | None = None


class ToolTerminalBody(BaseModel):
    status: str
    summary: str | None = None
    error: str | None = None
    result_json: dict | list | None = None
    execution_id: str | None = None


class CompleteBody(BaseModel):
    lease_owner: str | None = None
    status: str | None = None
    # B7: actual model + usage (tokens/cost) recorded at completion
    model_id: str | None = None
    usage: dict | None = None


class FailBody(BaseModel):
    error: str | None = None
    lease_owner: str | None = None


class WaitingApprovalBody(BaseModel):
    approval_id: str | None = None
    pending_approval: dict | None = None
    lease_owner: str | None = None


class WaitingInputBody(BaseModel):
    pending_input: dict = Field(default_factory=dict)
    lease_owner: str | None = None


class BudgetExceededBody(BaseModel):
    reason: str | None = None
    usage: dict | None = None
    lease_owner: str | None = None


class TaskPlanProjectionBody(BaseModel):
    tasks: list[dict] = Field(default_factory=list)


def _owned_run_or_404(run_id: str, request: Request) -> AgentRunResponse:
    run = agent_run_manager.get_run(run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Agent run not found")
    if settings.auth_enabled:
        actor = require_actor(request)
        assert_resource_owner(run, actor, not_found_detail="Agent run not found")
        # Legacy rows may predate run ownership. In that case the owning
        # conversation remains the authoritative isolation boundary.
        if not run.owner_user_id or not run.organization_id:
            conversation = agent_run_manager.conversations.get_for_owner(
                run.conversation_id,
                user_id=actor.user_id,
                organization_id=actor.organization_id,
                is_admin=actor.is_admin,
            )
            if conversation is None:
                raise HTTPException(status_code=404, detail="Agent run not found")
    return run


def _assert_owned_conversation(conversation_id: str, request: Request) -> None:
    if not settings.auth_enabled:
        return
    actor = require_actor(request)
    conversation = agent_run_manager.conversations.get_for_owner(
        conversation_id,
        user_id=actor.user_id,
        organization_id=actor.organization_id,
        is_admin=actor.is_admin,
    )
    if conversation is None:
        raise HTTPException(status_code=404, detail="Conversation not found")


@router.post("/agent-runs", response_model=AgentRunResponse, status_code=201)
def create_agent_run(body: AgentRunCreate, request: Request):
    """Create run, claim lease, stamp conversation.last_run_id."""
    budget = body.budget
    if budget is not None and hasattr(budget, "model_dump"):
        budget = budget.model_dump(exclude_none=True)
    owner_user_id = body.owner_user_id
    organization_id = body.organization_id
    if settings.auth_enabled:
        actor = require_actor(request)
        conversation = agent_run_manager.conversations.get_for_owner(
            body.conversation_id,
            user_id=actor.user_id,
            organization_id=actor.organization_id,
            is_admin=actor.is_admin,
        )
        if conversation is None:
            raise HTTPException(status_code=404, detail="Conversation not found")
        owner_user_id = actor.user_id
        organization_id = actor.organization_id
    return agent_run_manager.start_run(
        run_id=body.run_id,
        conversation_id=body.conversation_id,
        owner_user_id=owner_user_id,
        organization_id=organization_id,
        sandbox_session_id=body.sandbox_session_id,
        workspace_id=body.workspace_id,
        model_id=body.model_id,
        lease_owner=body.lease_owner,
        lease_seconds=body.lease_seconds,
        budget=budget,
    )


@router.get("/agent-runs", response_model=list[AgentRunResponse])
def list_agent_runs(
    request: Request,
    status: str | None = Query(default=None),
    conversation_id: str | None = Query(default=None),
):
    """List visible runs, optionally filtered by conversation and status."""
    if conversation_id:
        rows = agent_run_manager.runs.list_by_conversation(conversation_id)
    elif status:
        rows = agent_run_manager.runs.list_by_status(status)
    else:
        rows = agent_run_manager.runs.list_all()
    if status:
        rows = [run for run in rows if run.status == status]
    if not settings.auth_enabled:
        return rows

    actor = require_actor(request)
    visible: list[AgentRunResponse] = []
    for run in rows:
        try:
            assert_resource_owner(run, actor, not_found_detail="Agent run not found")
            if not run.owner_user_id or not run.organization_id:
                conversation = agent_run_manager.conversations.get_for_owner(
                    run.conversation_id,
                    user_id=actor.user_id,
                    organization_id=actor.organization_id,
                    is_admin=actor.is_admin,
                )
                if conversation is None:
                    continue
            visible.append(run)
        except HTTPException:
            continue
    return visible


@router.get("/agent-runs/{run_id}", response_model=AgentRunResponse)
def get_agent_run(run_id: str, request: Request):
    return _owned_run_or_404(run_id, request)


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
    status = body.status or "completed"
    released = agent_run_manager.release_lease(
        run_id, lease_owner=body.lease_owner, status=status
    )
    if released is None:
        raise HTTPException(status_code=409, detail="Lease release failed")
    return released


@router.post("/agent-runs/{run_id}/waiting-approval", response_model=AgentRunResponse)
def mark_run_waiting_approval(run_id: str, body: WaitingApprovalBody | None = None):
    """Park run for recoverable approval; release execution lease."""
    body = body or WaitingApprovalBody()
    updated = agent_run_manager.mark_waiting_approval(
        run_id,
        approval_id=body.approval_id,
        pending_approval=body.pending_approval,
        lease_owner=body.lease_owner,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return updated


@router.post("/agent-runs/{run_id}/budget-exceeded", response_model=AgentRunResponse)
def mark_run_budget_exceeded(run_id: str, body: BudgetExceededBody | None = None):
    """Terminal budget_exceeded status (ADR §4.9)."""
    body = body or BudgetExceededBody()
    updated = agent_run_manager.mark_budget_exceeded(
        run_id,
        reason=body.reason,
        usage=body.usage,
        lease_owner=body.lease_owner,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return updated


@router.post("/agent-runs/{run_id}/waiting-input", response_model=AgentRunResponse)
def mark_run_waiting_input(run_id: str, body: WaitingInputBody):
    updated = agent_run_manager.mark_waiting_input(
        run_id,
        pending_input=body.pending_input,
        lease_owner=body.lease_owner,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return updated


@router.post("/agent-runs/{run_id}/complete", response_model=AgentRunResponse)
def complete_agent_run(run_id: str, body: CompleteBody | None = None):
    body = body or CompleteBody()
    updated = agent_run_manager.complete_run(
        run_id,
        lease_owner=body.lease_owner,
        usage=body.usage,
        model_id=body.model_id,
    )
    if updated is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return updated


@router.put("/agent-runs/{run_id}/task-plan")
def replace_task_plan(run_id: str, body: TaskPlanProjectionBody):
    if agent_run_manager.get_run(run_id) is None:
        raise HTTPException(status_code=404, detail="Agent run not found")
    return {"run_id": run_id, "tasks": task_plan_projection.replace(run_id, body.tasks)}


@router.get("/agent-runs/{run_id}/task-plan")
def get_task_plan(run_id: str):
    return {"run_id": run_id, "tasks": task_plan_projection.list(run_id)}


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
    try:
        return agent_run_manager.append_event(
            run_id,
            event_type=body.type,
            payload=body.payload,
            event_id=body.event_id,
            schema_version=body.schema_version,
        )
    except AgentRunNotFoundError:
        raise HTTPException(status_code=404, detail="Agent run not found")
    except AgentEventIdConflictError:
        raise HTTPException(status_code=409, detail="event_id belongs to another run")


@router.get("/agent-runs/{run_id}/events", response_model=list[AgentEventResponse])
def list_agent_events(
    run_id: str,
    request: Request,
    after_sequence: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=5000),
):
    _owned_run_or_404(run_id, request)
    return agent_run_manager.list_events(
        run_id, after_sequence=after_sequence, limit=limit
    )


@router.get(
    "/conversations/{conversation_id}/agent-runs/latest",
    response_model=AgentRunResponse,
)
def get_latest_run(conversation_id: str, request: Request):
    _assert_owned_conversation(conversation_id, request)
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
    request: Request,
    after_sequence: int = Query(0, ge=0),
    limit: int | None = Query(None, ge=1, le=5000),
):
    """Events for the conversation's last (or active) run — UI recovery helper."""
    _assert_owned_conversation(conversation_id, request)
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
        tool_name=body.tool_name,
        arguments=body.arguments,
        session_id=body.session_id,
        conversation_id=body.conversation_id,
        workspace_id=body.workspace_id,
        execution_id=body.execution_id,
        summary=body.summary,
    )


@router.get(
    "/tool-executions/{tool_call_id}",
    response_model=ToolExecutionResponse,
)
def get_tool_execution(tool_call_id: str):
    row = agent_run_manager.get_tool(tool_call_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Tool execution not found")
    return row


@router.get(
    "/tool-executions",
    response_model=list[ToolExecutionResponse],
)
def list_tool_executions(
    run_id: str | None = Query(default=None),
    idempotency_key: str | None = Query(default=None),
):
    """Lookup by run_id or idempotency_key (for lost-response recovery)."""
    if idempotency_key:
        row = agent_run_manager.get_tool_by_idempotency(idempotency_key)
        return [row] if row else []
    if run_id:
        return agent_run_manager.list_tools_for_run(run_id)
    raise HTTPException(
        status_code=400, detail="run_id or idempotency_key query required"
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
    "/tool-executions/{tool_call_id}/waiting-approval",
    response_model=ToolExecutionResponse,
)
def mark_tool_waiting_approval(tool_call_id: str):
    updated = agent_run_manager.mark_tool_waiting_approval(tool_call_id)
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
        tool_call_id,
        body.status,
        summary=body.summary,
        error=body.error,
        result_json=body.result_json,
        execution_id=body.execution_id,
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
