"""In-memory approval manager for high-risk tool execution gates."""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sandbox.config import settings
from sandbox.models import RiskLevel


class ApprovalManager:
    def __init__(self) -> None:
        self._approvals: dict[str, dict[str, Any]] = {}
        self.timeout_seconds = getattr(settings, "approval_timeout_seconds", 300)

    def create(
        self,
        session_id: str,
        tool_name: str,
        risk_level: RiskLevel,
        reason: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        approval_id = f"approval_{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)
        entry = {
            "approval_id": approval_id,
            "session_id": session_id,
            "tool_name": tool_name,
            "risk_level": risk_level,
            "reason": reason,
            "payload": payload or {},
            "status": "pending_approval",
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=self.timeout_seconds)).isoformat(),
        }
        self._approvals[approval_id] = entry
        return entry

    def get(self, approval_id: str) -> dict[str, Any] | None:
        entry = self._approvals.get(approval_id)
        if entry is None:
            return None
        if entry["status"] == "pending_approval" and self._is_expired(entry):
            entry["status"] = "rejected"
            entry["reason"] = "approval timed out"
        return entry

    def decide(self, approval_id: str, decision: str) -> dict[str, Any] | None:
        entry = self.get(approval_id)
        if entry is None:
            return None
        if entry["status"] != "pending_approval":
            return entry
        entry["status"] = "approved" if decision == "approve" else "rejected"
        entry["decided_at"] = datetime.now(timezone.utc).isoformat()
        return entry

    @staticmethod
    def _is_expired(entry: dict[str, Any]) -> bool:
        return datetime.fromisoformat(entry["expires_at"]) < datetime.now(timezone.utc)


approval_manager = ApprovalManager()
