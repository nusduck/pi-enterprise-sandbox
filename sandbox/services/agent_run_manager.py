"""Agent run lifecycle: create, lease claim/release, event append, interrupt.

Dual-write strategy: conversation.messages remain the UI projection while
agent_events form the append-only recovery log. Full SDK JSONL rebuild from
PG is deferred.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sandbox.models import (
    AgentEventResponse,
    AgentRunResponse,
    AgentRunStatus,
    ToolExecutionStatus,
    ToolExecutionResponse,
)
from sandbox.repositories import (
    AgentEventIdConflictError,
    AgentEventRepository,
    AgentRunNotFoundError,
    AgentRunRepository,
    ConversationRepository,
    ToolExecutionRepository,
)

TERMINAL_RUN_STATUSES = frozenset(
    {
        AgentRunStatus.COMPLETED.value,
        AgentRunStatus.INTERRUPTED.value,
        AgentRunStatus.CANCELLED.value,
        AgentRunStatus.FAILED.value,
        AgentRunStatus.BUDGET_EXCEEDED.value,
        AgentRunStatus.REJECTED.value,
    }
)


class AgentRunManager:
    def __init__(
        self,
        runs: AgentRunRepository | None = None,
        events: AgentEventRepository | None = None,
        tools: ToolExecutionRepository | None = None,
        conversations: ConversationRepository | None = None,
    ) -> None:
        provided = [
            repo
            for repo in (runs, events, tools, conversations)
            if repo is not None
        ]
        database_urls = {repo.db.url for repo in provided}
        if len(database_urls) > 1:
            raise ValueError(
                "AgentRunManager repositories must use the same database"
            )

        # Partial dependency injection must still form one transactional
        # aggregate. Falling back each missing repository to the module-global
        # database can otherwise create a run in one database and append its
        # first event to another.
        shared_db = provided[0].db if provided else None
        self.runs = runs or AgentRunRepository(shared_db)
        self.events = events or AgentEventRepository(shared_db)
        self.tools = tools or ToolExecutionRepository(shared_db)
        self.conversations = conversations or ConversationRepository(shared_db)

    def _reconcile_tool_ledger(
        self,
        run_id: str,
        *,
        run_status: str,
        reason: str,
    ) -> None:
        """Make active tool rows terminal when their run closes.

        The Agent normally closes each row from the tool wrapper, but the run
        boundary is the durable safety net for lost tool_end events, worker
        crashes, and SSE disconnects. A successful run cannot establish the
        outcome of a still-executing side effect, so it is recorded as
        ``unknown`` rather than incorrectly reported as succeeded.
        """
        if run_status == AgentRunStatus.COMPLETED.value:
            terminal_status = ToolExecutionStatus.UNKNOWN.value
        elif run_status in {
            AgentRunStatus.INTERRUPTED.value,
            AgentRunStatus.CANCELLED.value,
        }:
            terminal_status = ToolExecutionStatus.CANCELLED.value
        else:
            terminal_status = ToolExecutionStatus.FAILED.value

        active_statuses = {
            ToolExecutionStatus.PREPARED.value,
            ToolExecutionStatus.WAITING_APPROVAL.value,
            ToolExecutionStatus.EXECUTING.value,
        }
        for tool in self.tools.list_by_run(run_id):
            if tool.status not in active_statuses:
                continue
            summary = reason or f"run ended while tool was {tool.status}"
            try:
                self.tools.mark_terminal(
                    tool.tool_call_id,
                    terminal_status,
                    summary=summary,
                    error=summary if terminal_status != ToolExecutionStatus.CANCELLED.value else None,
                )
            except Exception:
                # Never prevent the run status/event from becoming terminal.
                # A later reconciliation can retry the sticky terminal write.
                continue

    def start_run(
        self,
        *,
        conversation_id: str,
        run_id: str | None = None,
        owner_user_id: str | None = None,
        organization_id: str | None = None,
        sandbox_session_id: str | None = None,
        workspace_id: str | None = None,
        model_id: str | None = None,
        lease_owner: str | None = None,
        lease_seconds: int = 120,
        budget: dict[str, Any] | None = None,
    ) -> AgentRunResponse:
        """Create a run, claim lease, and stamp conversation.last_run_id."""
        run_id = run_id or f"run_{uuid.uuid4().hex}"
        now = datetime.now(timezone.utc)
        owner = lease_owner or f"worker_{uuid.uuid4().hex[:12]}"
        lease_until = (now + timedelta(seconds=lease_seconds)).isoformat()

        run = self.runs.create(
            {
                "run_id": run_id,
                "conversation_id": conversation_id,
                "owner_user_id": owner_user_id,
                "organization_id": organization_id,
                "status": AgentRunStatus.PENDING.value,
                "lease_owner": None,
                "lease_until": None,
                "version": 0,
                "sandbox_session_id": sandbox_session_id,
                "workspace_id": workspace_id,
                "model_id": model_id,
                "budget_json": budget,
                "created_at": now.isoformat(),
                "updated_at": now.isoformat(),
            }
        )
        try:
            claimed = self.runs.claim_lease(
                run_id,
                lease_owner=owner,
                lease_until=lease_until,
                expected_version=run.version,
                now_iso=now.isoformat(),
            )
            if claimed is None:
                # Single-process should always succeed; surface current state
                claimed = self.runs.get(run_id)
            if claimed is None:
                raise RuntimeError(f"Agent run disappeared during start: {run_id}")

            self.conversations.set_last_run_id(conversation_id, run_id)
            self.events.append(
                run_id=run_id,
                event_type="run_started",
                payload={
                    "conversation_id": conversation_id,
                    "lease_owner": claimed.lease_owner,
                    "model_id": model_id,
                },
            )
            return claimed
        except Exception:
            # ``create`` commits before the ancillary projections above. If a
            # later initialization step fails, leave the durable row terminal
            # and lease-free so a caller cannot execute an orphaned run.
            try:
                current = self.runs.get(run_id)
                if current is not None:
                    if current.lease_owner in (None, owner):
                        self.runs.release_lease(
                            run_id,
                            lease_owner=owner,
                            status=AgentRunStatus.FAILED.value,
                        )
                    else:
                        self.runs.update_status(run_id, AgentRunStatus.FAILED.value)
            except Exception:
                # Preserve the original creation error; cleanup is best effort.
                pass
            raise

    def claim_lease(
        self,
        run_id: str,
        *,
        lease_owner: str,
        expected_version: int | None = None,
        lease_seconds: int = 120,
    ) -> AgentRunResponse | None:
        now = datetime.now(timezone.utc)
        lease_until = (now + timedelta(seconds=lease_seconds)).isoformat()
        return self.runs.claim_lease(
            run_id,
            lease_owner=lease_owner,
            lease_until=lease_until,
            expected_version=expected_version,
            now_iso=now.isoformat(),
        )

    def renew_lease(
        self,
        run_id: str,
        *,
        lease_owner: str,
        lease_seconds: int = 120,
    ) -> AgentRunResponse | None:
        now = datetime.now(timezone.utc)
        lease_until = (now + timedelta(seconds=lease_seconds)).isoformat()
        return self.runs.renew_lease(
            run_id,
            lease_owner=lease_owner,
            lease_until=lease_until,
        )

    def reap_expired_run(self, run_id: str) -> AgentRunResponse | None:
        """Reap one stale active run and close its unfinished tools."""
        current = self.runs.get(run_id)
        if current is None or current.status not in {
            AgentRunStatus.PENDING.value,
            AgentRunStatus.RUNNING.value,
        }:
            return current
        now = datetime.now(timezone.utc).isoformat()
        updated = self.runs.expire_lease(run_id, now_iso=now)
        if updated is None:
            return self.runs.get(run_id)
        self._reconcile_tool_ledger(
            run_id,
            run_status=AgentRunStatus.INTERRUPTED.value,
            reason="run lease expired; execution owner is unavailable",
        )
        self.events.append(
            run_id=run_id,
            event_type="interrupted",
            payload={"reason": "lease_expired", "partial_text": None},
        )
        self.conversations.set_interrupted(
            updated.conversation_id, interrupted=True, last_run_id=run_id
        )
        return self.runs.get(run_id)

    def reap_expired_runs(self) -> int:
        count = 0
        for status in (AgentRunStatus.PENDING.value, AgentRunStatus.RUNNING.value):
            for run in self.runs.list_by_status(status):
                before = self.runs.get(run.run_id)
                self.reap_expired_run(run.run_id)
                after = self.runs.get(run.run_id)
                if before and after and before.status != after.status:
                    count += 1
        return count

    def release_lease(
        self,
        run_id: str,
        *,
        lease_owner: str,
        status: str = AgentRunStatus.COMPLETED.value,
    ) -> AgentRunResponse | None:
        current = self.runs.get(run_id)
        if current is None or current.status in TERMINAL_RUN_STATUSES:
            return current
        return self.runs.release_lease(run_id, lease_owner=lease_owner, status=status)

    def append_event(
        self,
        run_id: str,
        *,
        event_type: str,
        payload: dict[str, Any] | None = None,
        event_id: str | None = None,
        schema_version: int = 1,
    ) -> AgentEventResponse:
        """Append an event; on hard failure after retries mark run failed.

        Hard failures (exhausted sequence retries, unexpected DB errors) make
        the run observably ``failed`` via status update only — we do not try
        to append an error event, which would re-enter the failing path.
        """
        try:
            return self.events.append(
                run_id=run_id,
                event_type=event_type,
                payload=payload,
                event_id=event_id,
                schema_version=schema_version,
            )
        except (AgentRunNotFoundError, AgentEventIdConflictError):
            # A missing parent is a normal 404 condition, not a failed run;
            # an event_id collision is a client conflict, not a run failure.
            # In both cases the repository transaction has not inserted an
            # invalid or cross-linked event row.
            raise
        except Exception:
            try:
                self.runs.update_status(run_id, AgentRunStatus.FAILED.value)
            except Exception:
                # Best-effort observability; original append error is authoritative.
                pass
            raise

    def list_events(
        self,
        run_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[AgentEventResponse]:
        return self.events.list_by_run(
            run_id, after_sequence=after_sequence, limit=limit
        )

    def mark_interrupted(
        self,
        run_id: str,
        *,
        reason: str | None = None,
        partial_text: str | None = None,
        lease_owner: str | None = None,
    ) -> AgentRunResponse | None:
        """Mark run + conversation interrupted; append interrupt event."""
        run = self.runs.get(run_id)
        if run is None:
            return None
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if lease_owner:
            updated = self.runs.release_lease(
                run_id,
                lease_owner=lease_owner,
                status=AgentRunStatus.INTERRUPTED.value,
            )
        else:
            updated = self.runs.mark_interrupted(run_id)
        if updated is None:
            return None
        self._reconcile_tool_ledger(
            run_id,
            run_status=AgentRunStatus.INTERRUPTED.value,
            reason=reason or "run interrupted",
        )
        self.events.append(
            run_id=run_id,
            event_type="interrupted",
            payload={
                "reason": reason or "disconnect_or_error",
                "partial_text": partial_text,
            },
        )
        self.conversations.set_interrupted(
            run.conversation_id,
            interrupted=True,
            last_run_id=run_id,
        )
        # Dual-write: stamp interrupted flag on last assistant message if present
        conv = self.conversations.get(run.conversation_id)
        if conv and conv.messages:
            msgs = list(conv.messages)
            for i in range(len(msgs) - 1, -1, -1):
                if msgs[i].get("role") == "assistant":
                    msgs[i] = {
                        **msgs[i],
                        "interrupted": True,
                        "status": "interrupted",
                    }
                    break
            else:
                # Partial assistant not yet in messages — append placeholder
                if partial_text:
                    msgs.append(
                        {
                            "role": "assistant",
                            "content": partial_text,
                            "interrupted": True,
                            "status": "interrupted",
                        }
                    )
            self.conversations.update_messages(run.conversation_id, msgs)
        elif conv and partial_text:
            self.conversations.update_messages(
                run.conversation_id,
                list(conv.messages)
                + [
                    {
                        "role": "assistant",
                        "content": partial_text,
                        "interrupted": True,
                        "status": "interrupted",
                    }
                ],
            )
        return updated

    def complete_run(
        self,
        run_id: str,
        *,
        lease_owner: str | None = None,
        usage: dict[str, Any] | None = None,
        model_id: str | None = None,
    ) -> AgentRunResponse | None:
        run = self.runs.get(run_id)
        if run is None:
            return None
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if lease_owner:
            updated = self.runs.release_lease(
                run_id,
                lease_owner=lease_owner,
                status=AgentRunStatus.COMPLETED.value,
            )
        else:
            updated = self.runs.update_status(
                run_id, AgentRunStatus.COMPLETED.value
            )
        if updated is None:
            # A stale/wrong owner must not append done or reconcile another
            # worker's active tools. This also covers a run deleted between
            # the initial read and terminal update.
            return None
        # Record actual model + usage only after the status/lease transition
        # succeeds (B7), so a stale worker has no side effects.
        if usage is not None or model_id is not None:
            updated = self.runs.update_usage(
                run_id, usage=usage, model_id=model_id
            ) or updated
        self._reconcile_tool_ledger(
            run_id,
            run_status=AgentRunStatus.COMPLETED.value,
            reason="run completed with an unfinished tool execution",
        )
        done_payload: dict[str, Any] = {"status": AgentRunStatus.COMPLETED.value}
        if model_id is not None:
            done_payload["model_id"] = model_id
        if usage is not None:
            done_payload["usage"] = usage
        self.events.append(
            run_id=run_id,
            event_type="done",
            payload=done_payload,
        )
        self.conversations.set_interrupted(
            run.conversation_id, interrupted=False, last_run_id=run_id
        )
        return updated

    def fail_run(
        self,
        run_id: str,
        *,
        error: str | None = None,
        lease_owner: str | None = None,
    ) -> AgentRunResponse | None:
        run = self.runs.get(run_id)
        if run is None:
            return None
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if lease_owner:
            updated = self.runs.release_lease(
                run_id,
                lease_owner=lease_owner,
                status=AgentRunStatus.FAILED.value,
            )
        else:
            updated = self.runs.update_status(run_id, AgentRunStatus.FAILED.value)
        if updated is None:
            return None
        self._reconcile_tool_ledger(
            run_id,
            run_status=AgentRunStatus.FAILED.value,
            reason=error or "run failed with an unfinished tool execution",
        )
        self.events.append(
            run_id=run_id,
            event_type="error",
            payload={"message": error or "run failed"},
        )
        return updated

    def mark_waiting_approval(
        self,
        run_id: str,
        *,
        approval_id: str | None = None,
        pending_approval: dict[str, Any] | None = None,
        lease_owner: str | None = None,
    ) -> AgentRunResponse | None:
        """Park run for recoverable approval (ADR §4.8). Releases lease."""
        run = self.runs.get(run_id)
        if run is None:
            return None
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        pending = pending_approval or {}
        if approval_id and "approval_id" not in pending:
            pending = {**pending, "approval_id": approval_id}
        if lease_owner:
            released = self.runs.release_lease(
                run_id,
                lease_owner=lease_owner,
                status=AgentRunStatus.WAITING_APPROVAL.value,
            )
            if released is None:
                return None
        updated = self.runs.set_pending_approval(
            run_id,
            pending or None,
            status=AgentRunStatus.WAITING_APPROVAL.value,
        )
        if updated is None:
            return None
        self.events.append(
            run_id=run_id,
            event_type="waiting_approval",
            payload={
                "approval_id": pending.get("approval_id") or approval_id,
                "pending_approval": pending,
            },
        )
        return updated

    def mark_budget_exceeded(
        self,
        run_id: str,
        *,
        reason: str | None = None,
        usage: dict[str, Any] | None = None,
        lease_owner: str | None = None,
    ) -> AgentRunResponse | None:
        """Terminal budget_exceeded (ADR §4.9)."""
        run = self.runs.get(run_id)
        if run is None:
            return None
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        if lease_owner:
            updated = self.runs.release_lease(
                run_id,
                lease_owner=lease_owner,
                status=AgentRunStatus.BUDGET_EXCEEDED.value,
            )
        else:
            updated = self.runs.update_status(
                run_id, AgentRunStatus.BUDGET_EXCEEDED.value
            )
        if updated is None:
            return None
        self._reconcile_tool_ledger(
            run_id,
            run_status=AgentRunStatus.BUDGET_EXCEEDED.value,
            reason=reason or "budget exceeded with an unfinished tool execution",
        )
        self.events.append(
            run_id=run_id,
            event_type="budget_exceeded",
            payload={"reason": reason or "budget_exceeded", "usage": usage or {}},
        )
        return updated

    def mark_waiting_input(
        self,
        run_id: str,
        *,
        pending_input: dict[str, Any],
        lease_owner: str | None = None,
    ) -> AgentRunResponse | None:
        """Park a run for durable user input and release its execution lease."""
        if self.runs.get(run_id) is None:
            return None
        run = self.runs.get(run_id)
        if run is not None and run.status in TERMINAL_RUN_STATUSES:
            return run
        if lease_owner:
            released = self.runs.release_lease(
                run_id,
                lease_owner=lease_owner,
                status=AgentRunStatus.WAITING_INPUT.value,
            )
            if released is None:
                return None
        updated = self.runs.set_pending_input(
            run_id,
            pending_input,
            status=AgentRunStatus.WAITING_INPUT.value,
        )
        if updated is None:
            return None
        self.events.append(
            run_id=run_id,
            event_type="waiting_input",
            payload={"pending_input": pending_input},
        )
        return updated

    def list_waiting_approval(self) -> list[AgentRunResponse]:
        return self.runs.list_by_status(AgentRunStatus.WAITING_APPROVAL.value)

    def clear_pending_approval(
        self, run_id: str, *, status: str | None = None
    ) -> AgentRunResponse | None:
        return self.runs.set_pending_approval(run_id, None, status=status)

    # ── Tool ledger ───────────────────────────────────────────────────

    def prepare_tool(
        self,
        *,
        tool_call_id: str,
        run_id: str,
        idempotency_key: str,
        tool_name: str | None = None,
        arguments: dict | None = None,
        session_id: str | None = None,
        conversation_id: str | None = None,
        workspace_id: str | None = None,
        execution_id: str | None = None,
        summary: str | None = None,
    ) -> ToolExecutionResponse:
        return self.tools.prepare(
            tool_call_id=tool_call_id,
            run_id=run_id,
            idempotency_key=idempotency_key,
            tool_name=tool_name,
            arguments=arguments,
            session_id=session_id,
            conversation_id=conversation_id,
            workspace_id=workspace_id,
            execution_id=execution_id,
            summary=summary,
        )

    def get_tool(self, tool_call_id: str) -> ToolExecutionResponse | None:
        return self.tools.get(tool_call_id)

    def get_tool_by_idempotency(
        self, idempotency_key: str
    ) -> ToolExecutionResponse | None:
        return self.tools.get_by_idempotency_key(idempotency_key)

    def list_tools_for_run(self, run_id: str) -> list[ToolExecutionResponse]:
        return self.tools.list_by_run(run_id)

    def tool_can_auto_retry(self, tool_call_id: str) -> bool:
        return self.tools.can_auto_retry(tool_call_id)

    def mark_tool_executing(self, tool_call_id: str) -> ToolExecutionResponse | None:
        return self.tools.mark_executing(tool_call_id)

    def mark_tool_waiting_approval(
        self, tool_call_id: str
    ) -> ToolExecutionResponse | None:
        return self.tools.mark_waiting_approval(tool_call_id)

    def mark_tool_terminal(
        self,
        tool_call_id: str,
        status: str,
        *,
        summary: str | None = None,
        error: str | None = None,
        result_json: dict | list | None = None,
        execution_id: str | None = None,
    ) -> ToolExecutionResponse | None:
        return self.tools.mark_terminal(
            tool_call_id,
            status,
            summary=summary,
            error=error,
            result_json=result_json,
            execution_id=execution_id,
        )

    def get_run(self, run_id: str) -> AgentRunResponse | None:
        run = self.reap_expired_run(run_id)
        if run is None:
            return None
        if run.status in TERMINAL_RUN_STATUSES:
            # GET is an authoritative recovery seam. If a terminal transition
            # lost one tool write, a later snapshot repairs it before the
            # frontend renders the final state.
            self._reconcile_tool_ledger(
                run_id,
                run_status=run.status,
                reason="terminal run reconciliation",
            )
            run = self.runs.get(run_id)
        return run

    def reconcile_terminal_run(self, run_id: str) -> AgentRunResponse | None:
        """Explicit idempotent repair hook for workers and recovery jobs."""
        return self.get_run(run_id)

    def get_last_run_for_conversation(
        self, conversation_id: str
    ) -> AgentRunResponse | None:
        conv = self.conversations.get(conversation_id)
        if conv and conv.last_run_id:
            run = self.runs.get(conv.last_run_id)
            if run:
                return run
        runs = self.runs.list_by_conversation(conversation_id)
        return runs[0] if runs else None


agent_run_manager = AgentRunManager()
