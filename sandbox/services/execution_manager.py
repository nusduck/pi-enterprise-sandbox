"""Execution Manager — run Python / Bash / Node commands in workspace."""

from __future__ import annotations

import os
import signal
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from typing import Any

from sandbox.config import settings
from sandbox.database import Database
from sandbox.models import ExecutionStatus
from sandbox.repositories import ExecutionRepository
from sandbox.security.safe_env import safe_env
from sandbox.trace import get_trace_id
from sandbox.utils.resource_limits import contains_network_command, run_with_timeout, terminate_process_group


_TERMINAL_STATUSES = frozenset({
    ExecutionStatus.SUCCESS,
    ExecutionStatus.FAILED,
    ExecutionStatus.TIMEOUT,
    ExecutionStatus.CANCELLED,
    ExecutionStatus.SUCCESS.value,
    ExecutionStatus.FAILED.value,
    ExecutionStatus.TIMEOUT.value,
    ExecutionStatus.CANCELLED.value,
})

_CANCELLABLE_STATUSES = frozenset({
    ExecutionStatus.PENDING,
    ExecutionStatus.RUNNING,
    ExecutionStatus.PENDING.value,
    ExecutionStatus.RUNNING.value,
})


class ExecutionManager:
    """Manage executions within sandbox sessions.

    Ensures serial execution per session (one running execution at a time)
    via an atomic check-and-set under a lock. Tracks live process groups so
    cancel() can terminate them.
    """

    def __init__(self, database: Database | None = None) -> None:
        self.repository = ExecutionRepository(database)
        self._executions: dict[str, dict] = {}
        # session_id -> current running execution_id or None
        self._session_locks: dict[str, str | None] = defaultdict(lambda: None)
        # Protects admission + status + process-handle maps
        self._lock = threading.RLock()
        self._active_procs: dict[str, Any] = {}
        self._cancel_requested: set[str] = set()
        # execution_ids whose run_* body has not yet finalized (owns lock release)
        self._runner_active: set[str] = set()
        self._total_count = self.repository.total_count()

    def is_session_busy(self, session_id: str) -> bool:
        with self._lock:
            return self._session_locks.get(session_id) is not None

    def get_running_execution_id(self, session_id: str) -> str | None:
        with self._lock:
            return self._session_locks.get(session_id)

    def _admit(self, session_id: str, execution_id: str, entry: dict) -> dict | None:
        """Atomically admit an execution for a session.

        Returns a conflict error dict if the session is busy, else None.
        """
        with self._lock:
            if self._session_locks.get(session_id) is not None:
                return {
                    "error": f"Session {session_id} already has a running execution",
                    "status": "conflict",
                }
            self._executions[execution_id] = entry
            self.repository.upsert(entry)
            self._session_locks[session_id] = execution_id
            self._runner_active.add(execution_id)
            self._total_count += 1
            return None

    def _register_proc(self, execution_id: str, proc: Any) -> None:
        with self._lock:
            self._active_procs[execution_id] = proc
            # If cancel raced ahead of spawn, kill immediately
            if execution_id in self._cancel_requested:
                terminate_process_group(proc, grace_seconds=0.5)

    def _finalize(
        self,
        session_id: str,
        execution_id: str,
        entry: dict,
        *,
        result: dict | None = None,
        error: str | None = None,
    ) -> dict:
        """Persist terminal status with cancel-wins race rule; release lock once."""
        with self._lock:
            self._active_procs.pop(execution_id, None)
            cancel_wins = execution_id in self._cancel_requested
            current = entry.get("status")
            already_terminal = current in _TERMINAL_STATUSES

            if cancel_wins or current in (
                ExecutionStatus.CANCELLED,
                ExecutionStatus.CANCELLED.value,
            ):
                # Cancel wins over SUCCESS/FAILED when cancel was requested
                # before finalize completed (or status already CANCELLED).
                entry["status"] = ExecutionStatus.CANCELLED
                if result:
                    if "stdout_preview" not in entry or entry.get("stdout_preview") in (None, ""):
                        entry["stdout_preview"] = result.get("stdout_preview", "")
                    if "stderr_preview" not in entry or entry.get("stderr_preview") in (None, ""):
                        entry["stderr_preview"] = result.get("stderr_preview", "")
                    entry.setdefault("duration_ms", result.get("duration_ms", 0.0))
                    entry.setdefault("truncated", result.get("truncated", False))
                if entry.get("exit_code") is None:
                    entry["exit_code"] = -signal.SIGTERM
            elif already_terminal:
                # cancel() already wrote a terminal status
                pass
            elif error is not None:
                entry.update({
                    "status": ExecutionStatus.FAILED,
                    "stderr_preview": error,
                    "exit_code": -1,
                })
            elif result is not None:
                status = (
                    ExecutionStatus.SUCCESS
                    if result.get("exit_code") == 0
                    else ExecutionStatus.FAILED
                )
                # Timeout convention from run_with_timeout uses -SIGKILL
                if result.get("exit_code") == -signal.SIGKILL:
                    status = ExecutionStatus.TIMEOUT
                entry.update({
                    "status": status,
                    "stdout_preview": result.get("stdout_preview", ""),
                    "stderr_preview": result.get("stderr_preview", ""),
                    "exit_code": result.get("exit_code"),
                    "duration_ms": result.get("duration_ms", 0.0),
                    "truncated": result.get("truncated", False),
                })

            self.repository.upsert(entry)
            if self._session_locks.get(session_id) == execution_id:
                self._session_locks[session_id] = None
            self._cancel_requested.discard(execution_id)
            self._runner_active.discard(execution_id)
            return entry

    def _new_entry(
        self,
        execution_id: str,
        session_id: str,
        run_type: str,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        return {
            "execution_id": execution_id,
            "session_id": session_id,
            "status": ExecutionStatus.RUNNING,
            "run_type": run_type,
            "trace_id": get_trace_id(),
            "created_at": now,
        }

    def _run_body(
        self,
        session_id: str,
        execution_id: str,
        entry: dict,
        cmd: list[str],
        workspace_path: str,
        timeout: int,
        env_overrides: dict[str, str] | None,
    ) -> dict[str, Any]:
        # Cancel may have won between admit and run body
        with self._lock:
            if execution_id in self._cancel_requested:
                return self._finalize(session_id, execution_id, entry)

        try:
            env_overrides = env_overrides or {}

            def _on_started(proc: Any) -> None:
                self._register_proc(execution_id, proc)

            result = run_with_timeout(
                cmd,
                timeout=timeout,
                max_output_chars=settings.max_output_chars,
                env=safe_env(
                    workspace_path=workspace_path,
                    overrides=env_overrides,
                ),
                cwd=workspace_path,
                max_process_count=settings.max_process_count,
                max_memory_mb=settings.max_memory_mb,
                max_cpu_seconds=settings.max_cpu_time_seconds,
                on_started=_on_started,
            )
            return self._finalize(session_id, execution_id, entry, result=result)
        except Exception as exc:
            return self._finalize(
                session_id,
                execution_id,
                entry,
                error=f"Execution error: {exc}",
            )

    # ── Python execution ─────────────────────────────────────────

    def run_python(
        self,
        session_id: str,
        code: str,
        workspace_path: str,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        execution_id = f"exec_{uuid.uuid4().hex[:10]}"
        timeout = timeout or settings.execution_timeout_seconds
        entry = self._new_entry(execution_id, session_id, "python")
        conflict = self._admit(session_id, execution_id, entry)
        if conflict is not None:
            return conflict

        code_path = f"{workspace_path}/tmp/{execution_id}.py"
        os.makedirs(os.path.dirname(code_path), exist_ok=True)
        with open(code_path, "w") as f:
            f.write(code)

        return self._run_body(
            session_id,
            execution_id,
            entry,
            ["python3", "-u", code_path],
            workspace_path,
            timeout,
            env_overrides,
        )

    # ── Command execution ────────────────────────────────────────

    def run_command(
        self,
        session_id: str,
        command: str,
        workspace_path: str,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        # Network check before admission so blocked commands never hold the lock
        if settings.default_deny_network and contains_network_command(command):
            return {
                "error": "Network access is disabled in the sandbox. Use sandbox tools for external access.",
                "status": "blocked",
                "exit_code": -1,
                "stderr_preview": "Network access is disabled in the sandbox. Use sandbox tools for external access.",
                "stdout_preview": "",
                "truncated": False,
            }

        execution_id = f"exec_{uuid.uuid4().hex[:10]}"
        timeout = timeout or settings.execution_timeout_seconds
        entry = self._new_entry(execution_id, session_id, "command")
        conflict = self._admit(session_id, execution_id, entry)
        if conflict is not None:
            return conflict

        return self._run_body(
            session_id,
            execution_id,
            entry,
            ["bash", "-c", command],
            workspace_path,
            timeout,
            env_overrides,
        )

    # ── Node.js execution ────────────────────────────────────────

    def run_node(
        self,
        session_id: str,
        code: str,
        workspace_path: str,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        execution_id = f"exec_{uuid.uuid4().hex[:10]}"
        timeout = timeout or settings.execution_timeout_seconds
        entry = self._new_entry(execution_id, session_id, "node")
        conflict = self._admit(session_id, execution_id, entry)
        if conflict is not None:
            return conflict

        code_path = f"{workspace_path}/tmp/{execution_id}.js"
        os.makedirs(os.path.dirname(code_path), exist_ok=True)
        with open(code_path, "w") as f:
            f.write(code)

        return self._run_body(
            session_id,
            execution_id,
            entry,
            ["node", code_path],
            workspace_path,
            timeout,
            env_overrides,
        )

    # ── Query / cancel ───────────────────────────────────────────

    def get(self, execution_id: str) -> dict | None:
        with self._lock:
            mem = self._executions.get(execution_id)
            if mem is not None:
                return mem
        return self.repository.get(execution_id)

    def cancel(self, execution_id: str) -> bool:
        """Terminate a running execution's process group and mark CANCELLED.

        Idempotent. Cancel wins over a concurrent completion that has not yet
        finalized under the lock. Session lock is released exactly once — by
        the runner's ``_finalize`` when still active, or here if the runner
        already finished without clearing a stale lock.
        """
        with self._lock:
            entry = self._executions.get(execution_id) or self.repository.get(execution_id)
            if entry is None:
                return False
            self._executions[execution_id] = entry
            status = entry.get("status")
            if status in _TERMINAL_STATUSES and execution_id not in self._cancel_requested:
                return False
            if status not in _CANCELLABLE_STATUSES and execution_id not in self._cancel_requested:
                return False
            self._cancel_requested.add(execution_id)
            proc = self._active_procs.get(execution_id)
            runner_active = execution_id in self._runner_active

        # Signal outside the lock so the runner can progress into finalize
        if proc is not None:
            terminate_process_group(proc, grace_seconds=2.0)

        with self._lock:
            entry = self._executions.get(execution_id) or entry
            status = entry.get("status")
            if status not in _TERMINAL_STATUSES:
                entry["status"] = ExecutionStatus.CANCELLED
                if entry.get("exit_code") is None:
                    entry["exit_code"] = -signal.SIGTERM
                self.repository.upsert(entry)

            # If the runner is still active it owns lock release via _finalize.
            # Only release here when there is no active runner (orphan / race).
            if not runner_active and execution_id not in self._runner_active:
                sid = entry.get("session_id")
                if sid and self._session_locks.get(sid) == execution_id:
                    self._session_locks[sid] = None
                self._cancel_requested.discard(execution_id)
                self._active_procs.pop(execution_id, None)
            return True

    def cancel_active(self, session_id: str) -> dict | None:
        """Cancel the session's active execution, if any.

        Returns the execution entry after cancel attempt, or None if idle.
        """
        exec_id = self.get_running_execution_id(session_id)
        if not exec_id:
            return None
        self.cancel(exec_id)
        return self.get(exec_id)

    @property
    def total_count(self) -> int:
        return self._total_count


execution_manager = ExecutionManager()
