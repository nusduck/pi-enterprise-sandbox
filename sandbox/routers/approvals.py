"""Approval decision router."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from sandbox.models import ApprovalDecisionRequest
from sandbox.services.approval_manager import approval_manager

router = APIRouter(tags=["approvals"])


@router.post("/approve")
def decide_approval(body: ApprovalDecisionRequest):
    entry = approval_manager.decide(body.approval_id, body.decision)
    if entry is None:
        raise HTTPException(status_code=404, detail="Approval not found")
    return {
        "approval_id": entry["approval_id"],
        "status": entry["status"],
        "risk_level": entry["risk_level"],
        "reason": entry.get("reason", ""),
    }
