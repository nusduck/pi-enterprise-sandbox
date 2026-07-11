"""Trace query router — owner/org scoped when auth is enabled."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request

from sandbox.config import settings
from sandbox.database import database
from sandbox.repositories import AuditRepository, ExecutionRepository, SessionRepository
from sandbox.security.ownership import Actor, require_actor

router = APIRouter(prefix="/traces", tags=["traces"])


def _resolve_session_org(session: Any) -> str | None:
    """Organization for a session: metadata first, then owner user record."""
    meta = getattr(session, "metadata", None) or {}
    if not isinstance(meta, dict):
        meta = {}
    org_id = meta.get("organization_id")
    if org_id:
        return str(org_id)
    user_id = getattr(session, "user_id", None)
    if not user_id:
        return None
    try:
        from sandbox.repositories import UserRepository

        user = UserRepository(database).get_by_id(str(user_id))
        if user and user.get("organization_id"):
            return str(user["organization_id"])
    except Exception:  # noqa: BLE001 — best-effort enrichment
        return None
    return None


def _session_visible_to_actor(session: Any, actor: Actor) -> bool:
    """Return True if actor may see resources tied to this session.

    Same rules as resource ownership:
    - missing owner → inaccessible when auth is on (no leak via legacy rows)
    - cross-org → deny
    - admin may see same-org sessions
    - user must match session.user_id
    """
    if session is None:
        return False
    user_id = getattr(session, "user_id", None)
    if not user_id:
        return False
    org_id = _resolve_session_org(session)
    if org_id and str(org_id) != str(actor.organization_id):
        return False
    if actor.is_admin:
        # Same-org admin (or admin of owner when org unknown → require ownership)
        if org_id:
            return True
        return str(user_id) == str(actor.user_id)
    return str(user_id) == str(actor.user_id)


def _filter_trace_items(
    items: list[dict[str, Any]],
    *,
    actor: Actor,
    sessions: SessionRepository,
    cache: dict[str, Any],
) -> list[dict[str, Any]]:
    visible: list[dict[str, Any]] = []
    for item in items:
        sid = item.get("session_id")
        if not sid:
            # No session linkage → cannot authorize; omit (existence non-disclosure)
            continue
        if sid not in cache:
            cache[sid] = sessions.get(sid)
        if _session_visible_to_actor(cache[sid], actor):
            visible.append(item)
    return visible


@router.get("/{trace_id}")
def get_trace(trace_id: str, request: Request):
    """Return executions + audit logs for a trace, filtered by owner/org.

    When auth is enabled:
    - requires an actor (JWT or service + acting headers)
    - cross-user / cross-org traces return 404 (not 403)
    - admins only see same-organization data
    When auth is disabled, returns all matching rows (open dev mode).
    """
    executions = ExecutionRepository(database).list_by_trace_id(trace_id)
    audit_logs = AuditRepository(database).list_by_trace_id(trace_id)

    if settings.auth_enabled:
        actor = require_actor(request)
        sessions = SessionRepository(database)
        cache: dict[str, Any] = {}
        executions = _filter_trace_items(
            executions, actor=actor, sessions=sessions, cache=cache
        )
        audit_logs = _filter_trace_items(
            audit_logs, actor=actor, sessions=sessions, cache=cache
        )
        if not executions and not audit_logs:
            raise HTTPException(status_code=404, detail="Trace not found")

    session_ids = sorted(
        {
            item["session_id"]
            for item in executions + audit_logs
            if item.get("session_id")
        }
    )
    return {
        "trace_id": trace_id,
        "sessions": session_ids,
        "executions": executions,
        "audit_logs": audit_logs,
    }
