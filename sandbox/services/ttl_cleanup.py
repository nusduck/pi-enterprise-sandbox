"""TTL cleanup stubs for draft conversations and audit retention.

Defaults (config):
- draft_ttl_hours = 24
- conversation_ttl_days = 90
- audit_ttl_days = 180

Legal-hold conversations are never deleted by draft cleanup.
Full multi-replica orphan repair and legal-hold UI are deferred.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

from sandbox.config import settings
from sandbox.repositories import ConversationRepository

logger = logging.getLogger("sandbox.ttl_cleanup")


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


def cleanup_expired_drafts(
    *,
    db_conversations: ConversationRepository | None = None,
    now: datetime | None = None,
    dry_run: bool = False,
) -> dict[str, Any]:
    """Delete expired draft conversations without legal_hold.

    Draft = empty messages list and updated_at older than draft_ttl_hours.
    Returns a report; when dry_run=True only lists candidates.
    """
    repo = db_conversations or ConversationRepository()
    cutoff = draft_cutoff_iso(now=now)
    candidates = repo.list_expired_drafts(
        older_than_iso=cutoff, exclude_legal_hold=True
    )
    deleted: list[str] = []
    if not dry_run:
        for conv in candidates:
            if repo.delete(conv.id):
                deleted.append(conv.id)
                logger.info("Deleted expired draft conversation %s", conv.id)
    return {
        "cutoff": cutoff,
        "candidates": [c.id for c in candidates],
        "deleted": deleted,
        "dry_run": dry_run,
        "draft_ttl_hours": settings.draft_ttl_hours,
        "conversation_ttl_days": settings.conversation_ttl_days,
        "audit_ttl_days": settings.audit_ttl_days,
    }


def cleanup_expired_audit_stub(
    *,
    now: datetime | None = None,
    dry_run: bool = True,
) -> dict[str, Any]:
    """Stub for audit/event retention purge (180d). No-op delete in MVP."""
    cutoff = audit_cutoff_iso(now=now)
    return {
        "cutoff": cutoff,
        "deleted": 0,
        "dry_run": dry_run,
        "note": "audit event purge not implemented in MVP; cutoff computed only",
        "audit_ttl_days": settings.audit_ttl_days,
    }
