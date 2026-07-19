"""Structured Sandbox audit logging with lifecycle-installed persistence."""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from sandbox.config import settings
from sandbox.security.safe_env import sanitize_for_log
from sandbox.trace import get_trace_id

logger = logging.getLogger("sandbox.audit")


class AuditPersistenceError(RuntimeError):
    """The authoritative audit sink is missing or rejected the event."""


class AuditLogger:
    """Write audit events to stdout and the configured persistence sink.

    The formal MySQL repository is installed from the internal-plane lifecycle
    and shares its already prepared database handle. A production logger
    without that lifecycle-installed formal sink fails closed.
    """

    def __init__(
        self,
        repository: Any | None = None,
        *,
        conn_factory: Any | None = None,
        authoritative: bool | None = None,
    ) -> None:
        self.repository = repository
        self._conn_factory = conn_factory
        self._mode = "formal" if repository is not None else "unconfigured"
        # Local development may intentionally run without the internal plane;
        # production/plane-enabled deployments must never lose audit writes.
        self._authoritative = (
            bool(settings.is_production or settings.internal_plane_enabled)
            if authoritative is None
            else bool(authoritative)
        )

    def reset_for_config(self, *, authoritative: bool | None = None) -> None:
        self.repository = None
        self._conn_factory = None
        self._mode = "unconfigured"
        self._authoritative = (
            bool(settings.is_production or settings.internal_plane_enabled)
            if authoritative is None
            else bool(authoritative)
        )

    def set_formal_repository(
        self,
        repository: Any | None,
        *,
        conn_factory: Any | None = None,
        authoritative: bool = True,
    ) -> None:
        self.repository = repository
        self._conn_factory = conn_factory
        self._mode = "formal" if repository is not None else "unconfigured"
        self._authoritative = bool(authoritative)

    def log_tool_call(
        self,
        session_id: str,
        tool_name: str,
        caller_id: str,
        allowed: bool,
        risk_level: str,
        reason: str = "",
        metadata: dict[str, Any] | None = None,
        *,
        org_id: str | None = None,
        user_id: str | None = None,
    ) -> None:
        self._write(
            {
                "event": "tool_call",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "session_id": session_id,
                "tool_name": tool_name,
                "caller_id": caller_id,
                "allowed": allowed,
                "risk_level": risk_level,
                "reason": reason,
                "metadata": metadata or {},
                "org_id": org_id,
                "user_id": user_id,
            }
        )

    def log_execution(
        self,
        session_id: str,
        execution_id: str,
        run_type: str,
        exit_code: int | None,
        duration_ms: float,
        truncated: bool,
        *,
        org_id: str | None = None,
        user_id: str | None = None,
    ) -> None:
        self._write(
            {
                "event": "execution",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "session_id": session_id,
                "execution_id": execution_id,
                "run_type": run_type,
                "exit_code": exit_code,
                "duration_ms": duration_ms,
                "truncated": truncated,
                "org_id": org_id,
                "user_id": user_id,
            }
        )

    def log_error(
        self,
        session_id: str,
        error_type: str,
        message: str,
        *,
        org_id: str | None = None,
        user_id: str | None = None,
    ) -> None:
        sanitized = sanitize_for_log(message, settings.sensitive_keys)
        self._write(
            {
                "event": "error",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "session_id": session_id,
                "error_type": error_type,
                "message": sanitized,
                "org_id": org_id,
                "user_id": user_id,
            }
        )

    def log_session_lifecycle(
        self,
        session_id: str,
        action: str,
        metadata: dict[str, Any] | None = None,
        *,
        org_id: str | None = None,
        user_id: str | None = None,
    ) -> None:
        self._write(
            {
                "event": "session_lifecycle",
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "session_id": session_id,
                "action": action,
                "metadata": metadata or {},
                "org_id": org_id,
                "user_id": user_id,
            }
        )

    def _write(self, entry: dict[str, Any]) -> None:
        if not entry.get("trace_id"):
            entry["trace_id"] = get_trace_id()
        logger.info(json.dumps(entry, default=str))

        if self._mode == "formal" and self.repository is not None:
            self._write_formal(entry)
            return
        if self._authoritative:
            raise AuditPersistenceError("Formal audit persistence unavailable")

    def _write_formal(self, entry: dict[str, Any]) -> None:
        org_id = str(entry.get("org_id") or "").strip()
        user_id = str(entry.get("user_id") or "").strip()
        if not org_id or not user_id or self._conn_factory is None:
            raise AuditPersistenceError("Formal audit owner scope unavailable")

        from sandbox.app.domain.ulid import new_ulid

        payload = {
            "audit_id": new_ulid(),
            "org_id": org_id,
            "user_id": user_id,
            "event_type": entry["event"],
            "sandbox_session_id": entry.get("session_id"),
            "execution_id": entry.get("execution_id"),
            "process_id": entry.get("process_id"),
            "trace_id": entry.get("trace_id"),
            "payload_json": entry,
            "created_at": entry.get("timestamp"),
        }
        try:
            maybe = self._conn_factory()
            if hasattr(maybe, "__enter__"):
                with maybe as conn:
                    self.repository.insert(conn, payload)
                    conn.commit()
                return
            try:
                self.repository.insert(maybe, payload)
                maybe.commit()
            except Exception:
                if hasattr(maybe, "rollback"):
                    maybe.rollback()
                raise
            finally:
                if hasattr(maybe, "close"):
                    maybe.close()
        except Exception as exc:
            raise AuditPersistenceError("Formal audit write failed") from exc


audit_logger = AuditLogger()


__all__ = ["AuditLogger", "AuditPersistenceError", "audit_logger"]
