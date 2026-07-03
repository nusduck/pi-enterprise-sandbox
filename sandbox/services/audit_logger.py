"""Audit Logger — structured logging of tool calls, executions, and errors."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from sandbox.config import settings
from sandbox.database import Database
from sandbox.repositories import AuditRepository
from sandbox.security.safe_env import sanitize_for_log
from sandbox.trace import get_trace_id

logger = logging.getLogger("sandbox.audit")


class AuditLogger:
    """Log all tool calls, execution results, and policy decisions to stdout and SQLite."""

    def __init__(self, database: Database | None = None) -> None:
        self.repository = AuditRepository(database)

    def log_tool_call(
        self,
        session_id: str,
        tool_name: str,
        caller_id: str,
        allowed: bool,
        risk_level: str,
        reason: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> None:
        entry = {
            "event": "tool_call",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": session_id,
            "tool_name": tool_name,
            "caller_id": caller_id,
            "allowed": allowed,
            "risk_level": risk_level,
            "reason": reason,
            "metadata": metadata or {},
        }
        self._write(entry)

    def log_execution(
        self,
        session_id: str,
        execution_id: str,
        run_type: str,
        exit_code: int | None,
        duration_ms: float,
        truncated: bool,
    ) -> None:
        entry = {
            "event": "execution",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": session_id,
            "execution_id": execution_id,
            "run_type": run_type,
            "exit_code": exit_code,
            "duration_ms": duration_ms,
            "truncated": truncated,
        }
        self._write(entry)

    def log_error(
        self,
        session_id: str,
        error_type: str,
        message: str,
    ) -> None:
        sanitized = sanitize_for_log(message, settings.sensitive_keys)
        entry = {
            "event": "error",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": session_id,
            "error_type": error_type,
            "message": sanitized,
        }
        self._write(entry)

    def log_session_lifecycle(
        self,
        session_id: str,
        action: str,
        metadata: dict[str, Any] | None = None,
    ) -> None:
        entry = {
            "event": "session_lifecycle",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "session_id": session_id,
            "action": action,
            "metadata": metadata or {},
        }
        self._write(entry)

    def _write(self, entry: dict[str, Any]) -> None:
        if not entry.get("trace_id"):
            entry["trace_id"] = get_trace_id()
        logger.info(json.dumps(entry, default=str))
        self.repository.insert(
            event_type=entry["event"],
            payload=entry,
            session_id=entry.get("session_id"),
            execution_id=entry.get("execution_id"),
            trace_id=entry.get("trace_id"),
            created_at=entry.get("timestamp"),
        )


audit_logger = AuditLogger()
