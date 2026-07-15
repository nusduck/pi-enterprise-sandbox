"""Approval manager for high-risk tool execution gates.

Uses SQLite/Postgres when a Database is provided; keeps an in-memory cache
for hot-path lookups. Unit tests may construct an in-memory-only manager by
passing ``database=None``.
"""

from __future__ import annotations

import hashlib
import json
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
        self._idempotency_keys: dict[tuple[str, str], str] = {}
        self.timeout_seconds = getattr(settings, "approval_timeout_seconds", 300)

    def create(
        self,
        session_id: str,
        tool_name: str,
        risk_level: RiskLevel,
        reason: str,
        payload: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
        operation_fingerprint: str | None = None,
    ) -> dict[str, Any]:
        approval_id = f"approval_{uuid.uuid4().hex[:12]}"
        key = str(idempotency_key).strip() if idempotency_key else None
        fingerprint = operation_fingerprint or self._fingerprint(
            session_id=session_id,
            tool_name=tool_name,
            payload=payload or {},
        )
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
            "idempotency_key": key,
            "operation_fingerprint": fingerprint,
        }
        if self.repository is not None:
            stored = self.repository.create_or_get(entry)
            self._remember(stored)
            return self.get(stored["approval_id"]) or stored

        if key:
            existing_id = self._idempotency_keys.get((session_id, key))
            if existing_id:
                existing = self.get(existing_id)
                if existing is not None:
                    if existing.get("operation_fingerprint") != fingerprint:
                        raise ValueError(
                            "idempotency_key is already bound to a different operation"
                        )
                    return existing
        self._remember(entry)
        return entry

    def get(self, approval_id: str) -> dict[str, Any] | None:
        entry = self._approvals.get(approval_id)
        if entry is None and self.repository is not None:
            entry = self.repository.get(approval_id)
            if entry is not None:
                self._remember(entry)
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
        self._remember(entry)
        if self.repository is not None:
            self.repository.upsert(entry)

    def _remember(self, entry: dict[str, Any]) -> None:
        self._approvals[entry["approval_id"]] = entry
        key = entry.get("idempotency_key")
        if key:
            self._idempotency_keys[(entry["session_id"], str(key))] = entry["approval_id"]

    @staticmethod
    def _fingerprint(
        *, session_id: str, tool_name: str, payload: dict[str, Any]
    ) -> str:
        canonical = json.dumps(
            {
                "session_id": session_id,
                "tool_name": tool_name,
                "payload": payload,
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        return hashlib.sha256(canonical.encode("utf-8")).hexdigest()

    @staticmethod
    def _is_expired(entry: dict[str, Any]) -> bool:
        expires_at = entry.get("expires_at")
        if not expires_at:
            return False
        return datetime.fromisoformat(expires_at) < datetime.now(timezone.utc)


approval_manager = ApprovalManager(database=default_database)
