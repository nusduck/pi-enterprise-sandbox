"""Approval decision router — owner-scoped under auth."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from sandbox.models import ApprovalCreateRequest, ApprovalDecisionRequest
from sandbox.security.ownership import require_owned_session
from sandbox.services.approval_manager import approval_manager

router = APIRouter(tags=["approvals"])


def _serialize(entry: dict) -> dict:
    risk = entry.get("risk_level")
    risk_val = risk.value if hasattr(risk, "value") else risk
    return {
        "approval_id": entry["approval_id"],
        "idempotency_key": entry.get("idempotency_key"),
        "session_id": entry.get("session_id"),
        "tool_name": entry.get("tool_name"),
        "status": entry["status"],
        "risk_level": risk_val,
        "reason": entry.get("reason", ""),
        "payload": entry.get("payload") or {},
        "created_at": entry.get("created_at"),
        "expires_at": entry.get("expires_at"),
        "decided_at": entry.get("decided_at"),
    }


def _require_approval_session_owner(entry: dict, request: Request | None) -> None:
    """Gate get/decide on the approval's bound sandbox session.

    When auth is disabled (offline suite), ``require_owned_session`` skips ACL.
    Missing session_id fail-closed under auth (no unscoped decide).
    """
    session_id = (entry.get("session_id") or "").strip()
    if not session_id:
        raise HTTPException(status_code=404, detail="Approval not found")
    require_owned_session(session_id, request)


@router.post("/approvals", status_code=201)
def create_approval(body: ApprovalCreateRequest, request: Request):
    """Persist a host-level approval without proxying the underlying tool call."""
    # Creator must own the target session (auth on) — no cross-session inject.
    require_owned_session(body.session_id, request)
    entry = approval_manager.create(
        session_id=body.session_id,
        tool_name=body.tool_name,
        risk_level=body.risk_level,
        reason=body.reason,
        payload=body.payload,
        idempotency_key=body.idempotency_key,
    )
    return _serialize(entry)


@router.get("/approvals/{approval_id}")
def get_approval(approval_id: str, request: Request):
    """Fetch approval status (used by agent tools while waiting for human)."""
    entry = approval_manager.get(approval_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    _require_approval_session_owner(entry, request)
    return _serialize(entry)


@router.post("/approve")
def decide_approval(body: ApprovalDecisionRequest, request: Request):
    """Decide pending approval — only the session owner (under auth)."""
    # Load first to bind session; 404 for missing before ACL details.
    pending = approval_manager.get(body.approval_id)
    if pending is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    _require_approval_session_owner(pending, request)
    entry = approval_manager.decide(body.approval_id, body.decision)
    if entry is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    return _serialize(entry)
