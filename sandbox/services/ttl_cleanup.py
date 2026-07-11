"""TTL retention cleanup: drafts 24h, inactive 90d, events/audit 180d.

Legal Hold is enforced on every delete path (conversations with legal_hold=1
are never removed by cleanup; related agent_events / executions / audit rows
linked via those conversations are also retained).

Supports:
- ``now=`` controllable clock for tests
- ``dry_run=True`` (list/count candidates only; no mutation)
- Batch deletes with metrics reports (counts, cutoff, duration) — never logs
  message bodies or other sensitive content.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone
from typing import Any

from sandbox.config import settings
from sandbox.repositories import (
    AgentEventRepository,
    AgentRunRepository,
    AuditRepository,
    ConversationRepository,
    ExecutionRepository,
    ToolExecutionRepository,
)

logger = logging.getLogger("sandbox.ttl_cleanup")

# Bounded batch size so production runs are retryable without long locks.
DEFAULT_BATCH_SIZE = 100


def draft_cutoff_iso(*, now: datetime | None = None, hours: int | None = None) -> str:
    base = now or datetime.now(timezone.utc)
    ttl = hours if hours is not None else settings.draft_ttl_hours
    return (base - timedelta(hours=ttl)).isoformat()


def conversation_cutoff_iso(
    *, now: datetime | None = None, days: int | None = None
) -> str:
    base = now or datetime.now(timezone.utc)
    ttl = days if days is not None else settings.conversation_ttl_days
    return (base - timedelta(days=ttl)).isoformat()


def audit_cutoff_iso(*, now: datetime | None = None, days: int | None = None) -> str:
    base = now or datetime.now(timezone.utc)
    ttl = days if days is not None else settings.audit_ttl_days
    return (base - timedelta(days=ttl)).isoformat()


def _purge_conversation_children(
    conversation_id: str,
    *,
    runs: AgentRunRepository,
    events: AgentEventRepository,
    tools: ToolExecutionRepository,
) -> dict[str, int]:
    """Delete agent_events, tool_executions, agent_runs for a conversation."""
    run_ids = runs.list_run_ids_for_conversation(conversation_id)
    events_deleted = events.delete_by_run_ids(run_ids) if run_ids else 0
    tools_deleted = tools.delete_by_run_ids(run_ids) if run_ids else 0
    runs_deleted = runs.delete_by_conversation(conversation_id)
    return {
        "runs": runs_deleted,
        "events": events_deleted,
        "tools": tools_deleted,
    }


def _remove_conversation_workspace(conversation_id: str) -> bool:
    """Best-effort filesystem cleanup; never raises into the batch loop."""
    try:
        from sandbox.services.workspace_manager import workspace_manager

        workspace_manager.remove_conversation_workspace(conversation_id)
        return True
    except Exception:  # noqa: BLE001 — retention must continue
        logger.exception(
            "Failed to remove workspace for conversation_id=%s", conversation_id
        )
        return False


def cleanup_expired_drafts(
    *,
    db_conversations: ConversationRepository | None = None,
    runs: AgentRunRepository | None = None,
    events: AgentEventRepository | None = None,
    tools: ToolExecutionRepository | None = None,
    now: datetime | None = None,
    dry_run: bool = False,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> dict[str, Any]:
    """Delete expired draft conversations without legal_hold.

    Draft = empty messages list and updated_at older than draft_ttl_hours.
    Also purges child runs/events and conversation workspaces.
    """
    started = time.monotonic()
    repo = db_conversations or ConversationRepository()
    run_repo = runs or AgentRunRepository(repo.db)
    event_repo = events or AgentEventRepository(repo.db)
    tool_repo = tools or ToolExecutionRepository(repo.db)
    cutoff = draft_cutoff_iso(now=now)
    candidates = repo.list_expired_drafts(
        older_than_iso=cutoff,
        exclude_legal_hold=True,
        limit=batch_size,
    )
    deleted: list[str] = []
    workspaces_removed = 0
    children_purged = {"runs": 0, "events": 0, "tools": 0}
    if not dry_run:
        for conv in candidates:
            # Cascade children first so retry does not leave orphans
            purged = _purge_conversation_children(
                conv.id, runs=run_repo, events=event_repo, tools=tool_repo
            )
            for k, v in purged.items():
                children_purged[k] = children_purged.get(k, 0) + v
            if repo.delete(conv.id, respect_legal_hold=True):
                deleted.append(conv.id)
                if _remove_conversation_workspace(conv.id):
                    workspaces_removed += 1
                logger.info(
                    "Deleted expired draft conversation_id=%s",
                    conv.id,
                )
    duration_ms = (time.monotonic() - started) * 1000
    report = {
        "kind": "drafts",
        "cutoff": cutoff,
        "candidates": len(candidates),
        "candidate_ids": [c.id for c in candidates],
        "deleted": deleted if not dry_run else [],
        "deleted_count": len(deleted) if not dry_run else 0,
        "workspaces_removed": workspaces_removed,
        "children_purged": children_purged,
        "dry_run": dry_run,
        "duration_ms": round(duration_ms, 2),
        "draft_ttl_hours": settings.draft_ttl_hours,
        "conversation_ttl_days": settings.conversation_ttl_days,
        "audit_ttl_days": settings.audit_ttl_days,
        "batch_size": batch_size,
    }
    logger.info(
        "Draft cleanup cutoff=%s candidates=%d deleted=%d dry_run=%s duration_ms=%.1f",
        cutoff,
        report["candidates"],
        report["deleted_count"],
        dry_run,
        duration_ms,
    )
    return report


def cleanup_inactive_conversations(
    *,
    db_conversations: ConversationRepository | None = None,
    runs: AgentRunRepository | None = None,
    events: AgentEventRepository | None = None,
    tools: ToolExecutionRepository | None = None,
    now: datetime | None = None,
    dry_run: bool = False,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> dict[str, Any]:
    """Delete inactive conversations (90d) without legal_hold + workspaces."""
    started = time.monotonic()
    repo = db_conversations or ConversationRepository()
    run_repo = runs or AgentRunRepository(repo.db)
    event_repo = events or AgentEventRepository(repo.db)
    tool_repo = tools or ToolExecutionRepository(repo.db)
    cutoff = conversation_cutoff_iso(now=now)
    candidates = repo.list_inactive(
        older_than_iso=cutoff,
        exclude_legal_hold=True,
        limit=batch_size,
    )
    deleted: list[str] = []
    workspaces_removed = 0
    children_purged = {"runs": 0, "events": 0, "tools": 0}
    if not dry_run:
        for conv in candidates:
            purged = _purge_conversation_children(
                conv.id, runs=run_repo, events=event_repo, tools=tool_repo
            )
            for k, v in purged.items():
                children_purged[k] = children_purged.get(k, 0) + v
            if repo.delete(conv.id, respect_legal_hold=True):
                deleted.append(conv.id)
                if _remove_conversation_workspace(conv.id):
                    workspaces_removed += 1
                logger.info(
                    "Deleted inactive conversation_id=%s",
                    conv.id,
                )
    duration_ms = (time.monotonic() - started) * 1000
    report = {
        "kind": "inactive_conversations",
        "cutoff": cutoff,
        "candidates": len(candidates),
        "candidate_ids": [c.id for c in candidates],
        "deleted": deleted if not dry_run else [],
        "deleted_count": len(deleted) if not dry_run else 0,
        "workspaces_removed": workspaces_removed,
        "children_purged": children_purged,
        "dry_run": dry_run,
        "duration_ms": round(duration_ms, 2),
        "conversation_ttl_days": settings.conversation_ttl_days,
        "batch_size": batch_size,
    }
    logger.info(
        "Inactive cleanup cutoff=%s candidates=%d deleted=%d dry_run=%s duration_ms=%.1f",
        cutoff,
        report["candidates"],
        report["deleted_count"],
        dry_run,
        duration_ms,
    )
    return report


def cleanup_expired_audit(
    *,
    events: AgentEventRepository | None = None,
    executions: ExecutionRepository | None = None,
    audit: AuditRepository | None = None,
    now: datetime | None = None,
    dry_run: bool = False,
    batch_size: int = DEFAULT_BATCH_SIZE,
) -> dict[str, Any]:
    """Purge agent_events, executions, and audit_logs older than audit_ttl_days.

    Legal-hold-linked rows are excluded from every delete path.
    """
    started = time.monotonic()
    event_repo = events or AgentEventRepository()
    exec_repo = executions or ExecutionRepository(event_repo.db)
    audit_repo = audit or AuditRepository(event_repo.db)
    cutoff = audit_cutoff_iso(now=now)

    event_candidates = event_repo.count_older_than(
        cutoff, exclude_legal_hold=True
    )
    # executions have no legal-hold column; count via same filter as delete
    exec_candidates = 0
    with exec_repo.db.connect() as conn:
        row = conn.execute(
            """
            SELECT COUNT(*) AS n FROM executions
            WHERE created_at < ?
              AND session_id NOT IN (
                SELECT sandbox_session_id FROM conversations
                WHERE COALESCE(legal_hold, 0) = 1
                  AND sandbox_session_id IS NOT NULL
                  AND sandbox_session_id != ''
              )
            """,
            (cutoff,),
        ).fetchone()
        exec_candidates = int(row["n"] if row is not None else 0)
    audit_candidates = audit_repo.count_older_than(
        cutoff, exclude_legal_hold=True
    )

    events_deleted = 0
    executions_deleted = 0
    audit_deleted = 0
    if not dry_run:
        events_deleted = event_repo.delete_older_than(
            older_than_iso=cutoff,
            exclude_legal_hold=True,
            limit=batch_size,
        )
        executions_deleted = exec_repo.delete_older_than(
            older_than_iso=cutoff,
            exclude_legal_hold=True,
            limit=batch_size,
        )
        audit_deleted = audit_repo.delete_older_than(
            older_than_iso=cutoff,
            exclude_legal_hold=True,
            limit=batch_size,
        )
        logger.info(
            "Audit/event cleanup cutoff=%s events=%d executions=%d audit=%d",
            cutoff,
            events_deleted,
            executions_deleted,
            audit_deleted,
        )

    duration_ms = (time.monotonic() - started) * 1000
    report = {
        "kind": "audit_events",
        "cutoff": cutoff,
        "candidates": {
            "agent_events": event_candidates,
            "executions": exec_candidates,
            "audit_logs": audit_candidates,
        },
        "deleted": {
            "agent_events": events_deleted,
            "executions": executions_deleted,
            "audit_logs": audit_deleted,
        },
        "deleted_count": events_deleted + executions_deleted + audit_deleted,
        "dry_run": dry_run,
        "duration_ms": round(duration_ms, 2),
        "audit_ttl_days": settings.audit_ttl_days,
        "batch_size": batch_size,
    }
    logger.info(
        "Audit cleanup cutoff=%s deleted_total=%d dry_run=%s duration_ms=%.1f",
        cutoff,
        report["deleted_count"],
        dry_run,
        duration_ms,
    )
    return report


def cleanup_expired_audit_stub(
    *,
    now: datetime | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Backward-compatible alias; delegates to real audit cleanup."""
    return cleanup_expired_audit(now=now, dry_run=dry_run)


def run_retention_cleanup(
    *,
    now: datetime | None = None,
    dry_run: bool = False,
    batch_size: int = DEFAULT_BATCH_SIZE,
    db: Any | None = None,
) -> dict[str, Any]:
    """Run all retention passes (drafts → inactive → audit/events).

    Order matters: drafts first (24h), then inactive conversations (90d),
    then free-standing events/executions/audit (180d).
    """
    started = time.monotonic()
    conv_repo = ConversationRepository(db) if db is not None else ConversationRepository()
    run_repo = AgentRunRepository(conv_repo.db)
    event_repo = AgentEventRepository(conv_repo.db)
    tool_repo = ToolExecutionRepository(conv_repo.db)
    exec_repo = ExecutionRepository(conv_repo.db)
    audit_repo = AuditRepository(conv_repo.db)

    drafts = cleanup_expired_drafts(
        db_conversations=conv_repo,
        runs=run_repo,
        events=event_repo,
        tools=tool_repo,
        now=now,
        dry_run=dry_run,
        batch_size=batch_size,
    )
    inactive = cleanup_inactive_conversations(
        db_conversations=conv_repo,
        runs=run_repo,
        events=event_repo,
        tools=tool_repo,
        now=now,
        dry_run=dry_run,
        batch_size=batch_size,
    )
    audit = cleanup_expired_audit(
        events=event_repo,
        executions=exec_repo,
        audit=audit_repo,
        now=now,
        dry_run=dry_run,
        batch_size=batch_size,
    )
    duration_ms = (time.monotonic() - started) * 1000
    summary = {
        "drafts": drafts,
        "inactive_conversations": inactive,
        "audit_events": audit,
        "dry_run": dry_run,
        "duration_ms": round(duration_ms, 2),
        "deleted_total": (
            drafts.get("deleted_count", 0)
            + inactive.get("deleted_count", 0)
            + audit.get("deleted_count", 0)
        ),
    }
    logger.info(
        "Retention pass complete deleted_total=%d dry_run=%s duration_ms=%.1f",
        summary["deleted_total"],
        dry_run,
        duration_ms,
    )
    return summary
