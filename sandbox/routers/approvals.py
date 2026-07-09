"""Approval decision router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from sandbox.models import ApprovalDecisionRequest
from sandbox.services.approval_manager import approval_manager

router = APIRouter(tags=["approvals"])


def _serialize(entry: dict) -> dict:
    risk = entry.get("risk_level")
    risk_val = risk.value if hasattr(risk, "value") else risk
    return {
        "approval_id": entry["approval_id"],
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


@router.get("/approvals/{approval_id}")
def get_approval(approval_id: str):
    """Fetch approval status (used by agent tools while waiting for human)."""
    entry = approval_manager.get(approval_id)
    if entry is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    return _serialize(entry)


@router.post("/approve")
def decide_approval(body: ApprovalDecisionRequest):
    entry = approval_manager.decide(body.approval_id, body.decision)
    if entry is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    return _serialize(entry)
