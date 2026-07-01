"""Execution Manager — run Python / Bash / Node commands in workspace."""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from sandbox.config import settings
from sandbox.models import ExecutionResponse, ExecutionStatus
from sandbox.security.safe_env import safe_env
from sandbox.utils.resource_limits import run_with_timeout


class ExecutionManager:
    """Manage executions within sandbox sessions.

    Ensures serial execution per session (one running execution at a time).
    """

    def __init__(self) -> None:
        self._executions: dict[str, dict] = {}
        # session_id -> current running execution_id or None
        self._session_locks: dict[str, str | None] = defaultdict(lambda: None)
        self._total_count = 0

    def is_session_busy(self, session_id: str) -> bool:
        return self._session_locks.get(session_id) is not None

    def get_running_execution_id(self, session_id: str) -> str | None:
        return self._session_locks.get(session_id)

    # ── Python execution ─────────────────────────────────────────

    def run_python(
        self,
        session_id: str,
        code: str,
        workspace_path: str,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if self.is_session_busy(session_id):
            return {
                "error": f"Session {session_id} already has a running execution",
                "status": "conflict",
            }

        execution_id = f"exec_{uuid.uuid4().hex[:10]}"
        timeout = timeout or settings.execution_timeout_seconds
        now = datetime.now(timezone.utc).isoformat()

        entry = {
            "execution_id": execution_id,
            "session_id": session_id,
            "status": ExecutionStatus.RUNNING,
            "created_at": now,
        }
        self._executions[execution_id] = entry
        self._session_locks[session_id] = execution_id
        self._total_count += 1

        try:
            # Write code to a temp file and execute it
            code_path = f"{workspace_path}/tmp/{execution_id}.py"
            with open(code_path, "w") as f:
                f.write(code)

            result = run_with_timeout(
                ["python3", "-u", code_path],  # -u for unbuffered output
                timeout=timeout,
                max_output_chars=settings.max_output_chars,
                env=safe_env(
                    workspace_path=workspace_path,
                    overrides=env_overrides,
                ),
                cwd=workspace_path,
            )

            status = ExecutionStatus.SUCCESS if result["exit_code"] == 0 else ExecutionStatus.FAILED
            entry.update({
                "status": status,
                "stdout_preview": result["stdout_preview"],
                "stderr_preview": result["stderr_preview"],
                "exit_code": result["exit_code"],
                "duration_ms": result["duration_ms"],
                "truncated": result["truncated"],
            })
        except Exception as exc:
            entry.update({
                "status": ExecutionStatus.FAILED,
                "stderr_preview": f"Execution error: {exc}",
                "exit_code": -1,
            })
        finally:
            self._session_locks[session_id] = None

        return entry

    # ── Command execution ────────────────────────────────────────

    def run_command(
        self,
        session_id: str,
        command: str,
        workspace_path: str,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        if self.is_session_busy(session_id):
            return {
                "error": f"Session {session_id} already has a running execution",
                "status": "conflict",
            }

        execution_id = f"exec_{uuid.uuid4().hex[:10]}"
        timeout = timeout or settings.execution_timeout_seconds
        now = datetime.now(timezone.utc).isoformat()

        entry = {
            "execution_id": execution_id,
            "session_id": session_id,
            "status": ExecutionStatus.RUNNING,
            "created_at": now,
        }
        self._executions[execution_id] = entry
        self._session_locks[session_id] = execution_id
        self._total_count += 1

        try:
            result = run_with_timeout(
                ["bash", "-c", command],
                timeout=timeout,
                max_output_chars=settings.max_output_chars,
                env=safe_env(
                    workspace_path=workspace_path,
                    overrides=env_overrides,
                ),
                cwd=workspace_path,
            )

            status = ExecutionStatus.SUCCESS if result["exit_code"] == 0 else ExecutionStatus.FAILED
            entry.update({
                "status": status,
                "stdout_preview": result["stdout_preview"],
                "stderr_preview": result["stderr_preview"],
                "exit_code": result["exit_code"],
                "duration_ms": result["duration_ms"],
                "truncated": result["truncated"],
            })
        except Exception as exc:
            entry.update({
                "status": ExecutionStatus.FAILED,
                "stderr_preview": f"Execution error: {exc}",
                "exit_code": -1,
            })
        finally:
            self._session_locks[session_id] = None

        return entry

    # ── Query ────────────────────────────────────────────────────

    def get(self, execution_id: str) -> dict | None:
        return self._executions.get(execution_id)

    def cancel(self, execution_id: str) -> bool:
        """Mark an execution as cancelled (actual process kill is handled
        elsewhere; this is a metadata update)."""
        entry = self._executions.get(execution_id)
        if entry is None or entry["status"] not in (
            ExecutionStatus.PENDING,
            ExecutionStatus.RUNNING,
        ):
            return False
        entry["status"] = ExecutionStatus.CANCELLED
        # Release session lock if this was the running execution
        sid = entry["session_id"]
        if self._session_locks.get(sid) == execution_id:
            self._session_locks[sid] = None
        return True

    @property
    def total_count(self) -> int:
        return self._total_count


execution_manager = ExecutionManager()
