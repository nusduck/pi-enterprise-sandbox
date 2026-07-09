"""Approval manager for high-risk tool execution gates.

Uses SQLite/Postgres when a Database is provided; keeps an in-memory cache
for hot-path lookups. Unit tests may construct an in-memory-only manager by
passing ``database=None``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sandbox.config import settings
from sandbox.database import Database, database as default_database
from sandbox.models import RiskLevel
from sandbox.repositories import ApprovalRepository


class ApprovalManager:
    def __init__(self, database: Database | None = None) -> None:
        # ``database is None`` → pure in-memory (no repository).
        # Explicit Database (incl. module default) → persist + optional cache.
        self.repository = ApprovalRepository(database) if database is not None else None
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
            "risk_level": risk_level.value if hasattr(risk_level, "value") else str(risk_level),
            "reason": reason,
            "payload": payload or {},
            "status": "pending_approval",
            "created_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=self.timeout_seconds)).isoformat(),
            "decided_at": None,
        }
        if self.repository is not None:
            self.repository.upsert(entry)
        self._approvals[approval_id] = entry
        return entry

    def get(self, approval_id: str) -> dict[str, Any] | None:
        entry = self._approvals.get(approval_id)
        if entry is None and self.repository is not None:
            entry = self.repository.get(approval_id)
            if entry is not None:
                self._approvals[approval_id] = entry
        if entry is None:
            return None

        if entry["status"] == "pending_approval" and self._is_expired(entry):
            entry["status"] = "rejected"
            entry["reason"] = "approval timed out"
            entry["decided_at"] = datetime.now(timezone.utc).isoformat()
            self._persist(entry)
        return entry

    def decide(self, approval_id: str, decision: str) -> dict[str, Any] | None:
        entry = self.get(approval_id)
        if entry is None:
            return None
        if entry["status"] != "pending_approval":
            return entry
        entry["status"] = "approved" if decision == "approve" else "rejected"
        entry["decided_at"] = datetime.now(timezone.utc).isoformat()
        self._persist(entry)
        return entry

    def _persist(self, entry: dict[str, Any]) -> None:
        self._approvals[entry["approval_id"]] = entry
        if self.repository is not None:
            self.repository.upsert(entry)

    @staticmethod
    def _is_expired(entry: dict[str, Any]) -> bool:
        expires_at = entry.get("expires_at")
        if not expires_at:
            return False
        return datetime.fromisoformat(expires_at) < datetime.now(timezone.utc)


approval_manager = ApprovalManager(database=default_database)
