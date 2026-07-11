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
    ToolExecutionResponse,
)
from sandbox.repositories import (
    AgentEventRepository,
    AgentRunRepository,
    ConversationRepository,
    ToolExecutionRepository,
)


class AgentRunManager:
    def __init__(
        self,
        runs: AgentRunRepository | None = None,
        events: AgentEventRepository | None = None,
        tools: ToolExecutionRepository | None = None,
        conversations: ConversationRepository | None = None,
    ) -> None:
        self.runs = runs or AgentRunRepository()
        self.events = events or AgentEventRepository()
        self.tools = tools or ToolExecutionRepository()
        self.conversations = conversations or ConversationRepository()

    def start_run(
        self,
        *,
        conversation_id: str,
        owner_user_id: str | None = None,
        organization_id: str | None = None,
        sandbox_session_id: str | None = None,
        workspace_id: str | None = None,
        model_id: str | None = None,
        lease_owner: str | None = None,
        lease_seconds: int = 120,
    ) -> AgentRunResponse:
        """Create a run, claim lease, and stamp conversation.last_run_id."""
        run_id = f"run_{uuid.uuid4().hex}"
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
                "created_at": now.isoformat(),
                "updated_at": now.isoformat(),
            }
        )
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
        assert claimed is not None

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

    def release_lease(
        self,
        run_id: str,
        *,
        lease_owner: str,
        status: str = AgentRunStatus.COMPLETED.value,
    ) -> AgentRunResponse | None:
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
        return self.events.append(
            run_id=run_id,
            event_type=event_type,
            payload=payload,
            event_id=event_id,
            schema_version=schema_version,
        )

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
    ) -> AgentRunResponse | None:
        """Mark run + conversation interrupted; append interrupt event."""
        run = self.runs.get(run_id)
        if run is None:
            return None
        updated = self.runs.mark_interrupted(run_id)
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
    ) -> AgentRunResponse | None:
        run = self.runs.get(run_id)
        if run is None:
            return None
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
        self.events.append(
            run_id=run_id,
            event_type="done",
            payload={"status": AgentRunStatus.COMPLETED.value},
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
        if lease_owner:
            updated = self.runs.release_lease(
                run_id,
                lease_owner=lease_owner,
                status=AgentRunStatus.FAILED.value,
            )
        else:
            updated = self.runs.update_status(run_id, AgentRunStatus.FAILED.value)
        self.events.append(
            run_id=run_id,
            event_type="error",
            payload={"message": error or "run failed"},
        )
        return updated

    # ── Tool ledger ───────────────────────────────────────────────────

    def prepare_tool(
        self,
        *,
        tool_call_id: str,
        run_id: str,
        idempotency_key: str,
        summary: str | None = None,
    ) -> ToolExecutionResponse:
        return self.tools.prepare(
            tool_call_id=tool_call_id,
            run_id=run_id,
            idempotency_key=idempotency_key,
            summary=summary,
        )

    def tool_can_auto_retry(self, tool_call_id: str) -> bool:
        return self.tools.can_auto_retry(tool_call_id)

    def mark_tool_executing(self, tool_call_id: str) -> ToolExecutionResponse | None:
        return self.tools.mark_executing(tool_call_id)

    def mark_tool_terminal(
        self,
        tool_call_id: str,
        status: str,
        *,
        summary: str | None = None,
    ) -> ToolExecutionResponse | None:
        return self.tools.mark_terminal(tool_call_id, status, summary=summary)

    def get_run(self, run_id: str) -> AgentRunResponse | None:
        return self.runs.get(run_id)

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
