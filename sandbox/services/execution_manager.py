"""Execution Manager — run Python / Bash / Node commands in workspace."""

from __future__ import annotations

import signal
import threading
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from sandbox.config import settings
from sandbox.database import Database
from sandbox.isolation import IsolationBackend, LaunchSpec, build_isolation_backend
from sandbox.models import ExecutionStatus
from sandbox.paths import temp_id_for_workspace_id
from sandbox.repositories import ExecutionRepository
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.execution_stream import (
    SOURCE_EXECUTION,
    execution_stream,
    full_log_location,
)
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

    def __init__(
        self,
        database: Database | None = None,
        *,
        stream_hub: Any | None = None,
        isolation_backend: IsolationBackend | None = None,
    ) -> None:
        self.repository = ExecutionRepository(database)
        self._stream = stream_hub if stream_hub is not None else execution_stream
        self._isolation = isolation_backend or build_isolation_backend()
        self._executions: dict[str, dict] = {}
        # workspace_id -> current running execution_id or None
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
            return self.get_running_execution_id(session_id) is not None

    def is_workspace_busy(self, workspace_id: str) -> bool:
        """Return whether a synchronous execution owns this workspace lock."""
        with self._lock:
            execution_id = self._session_locks.get(workspace_id)
            return bool(execution_id and execution_id in self._runner_active)

    def get_running_execution_id(self, session_id: str) -> str | None:
        with self._lock:
            for execution_id, entry in self._executions.items():
                if (
                    entry.get("session_id") == session_id
                    and execution_id in self._runner_active
                ):
                    return execution_id
            return None

    def _admit(
        self,
        workspace_id: str,
        execution_id: str,
        entry: dict,
    ) -> dict | None:
        """Atomically admit an execution for a workspace.

        Returns a conflict error dict if the session is busy, else None.
        """
        with self._lock:
            if self._session_locks.get(workspace_id) is not None:
                return {
                    "error": f"Workspace {workspace_id} already has a running execution",
                    "status": "conflict",
                }
            self._executions[execution_id] = entry
            self.repository.upsert(entry)
            self._session_locks[workspace_id] = execution_id
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
            workspace_id = entry.get("workspace_id") or session_id
            if self._session_locks.get(workspace_id) == execution_id:
                self._session_locks[workspace_id] = None
            self._cancel_requested.discard(execution_id)
            self._runner_active.discard(execution_id)
            return entry

    def _new_entry(
        self,
        execution_id: str,
        session_id: str,
        run_type: str,
        *,
        workspace_id: str | None = None,
        run_id: str | None = None,
        command: str | None = None,
    ) -> dict[str, Any]:
        now = datetime.now(timezone.utc).isoformat()
        return {
            "execution_id": execution_id,
            "session_id": session_id,
            "workspace_id": workspace_id or session_id,
            "status": ExecutionStatus.RUNNING,
            "run_type": run_type,
            "trace_id": get_trace_id(),
            "created_at": now,
            "run_id": run_id,
            "command": command,
            "isolation_backend": self._isolation.name,
        }

    @staticmethod
    def _coerce_context(
        session_id: str,
        workspace_path: str | None,
        context: SandboxExecutionContext | None,
    ) -> SandboxExecutionContext:
        if context is not None:
            if context.session_id != session_id:
                raise ValueError("Execution context does not belong to session")
            return context
        if not workspace_path:
            raise ValueError("Execution context is required")
        # Internal compatibility for existing unit/service callers. Public
        # routers and internal callers resolve context from the trusted session binding.
        workspace = Path(workspace_path).resolve()
        workspace_id = workspace.name or session_id
        temp_id = temp_id_for_workspace_id(workspace_id)
        temp = (settings.temp_path / temp_id).resolve()
        workspace.mkdir(parents=True, exist_ok=True)
        temp.mkdir(parents=True, exist_ok=True)
        return SandboxExecutionContext(
            session_id=session_id,
            workspace_id=workspace_id,
            temp_id=temp_id,
            physical_workspace=workspace,
            physical_temp=temp,
        )

    def _run_body(
        self,
        session_id: str,
        execution_id: str,
        entry: dict,
        cmd: list[str],
        context: SandboxExecutionContext,
        timeout: int,
        env_overrides: dict[str, str] | None,
    ) -> dict[str, Any]:
        # Cancel may have won between admit and run body
        with self._lock:
            if execution_id in self._cancel_requested:
                finalized = self._finalize(session_id, execution_id, entry)
                self._emit_terminal(entry, finalized)
                return finalized

        run_id = entry.get("run_id")
        try:
            # B3: execution_started before spawn
            try:
                self._stream.emit_started(
                    source_type=SOURCE_EXECUTION,
                    source_id=execution_id,
                    session_id=session_id,
                    command=entry.get("command") or " ".join(cmd),
                    run_id=run_id,
                    extra={"run_type": entry.get("run_type")},
                )
            except Exception:
                pass

            env_overrides = env_overrides or {}

            prepared = self._isolation.prepare(
                LaunchSpec(
                    context=context,
                    argv=cmd,
                    relative_cwd=PurePosixPath("."),
                    env_overrides=env_overrides,
                    network_mode=settings.network_mode,
                )
            )
            entry["isolation_backend"] = prepared.backend

            def _on_started(proc: Any) -> None:
                self._register_proc(execution_id, proc)

            def _on_output(stream: str, text: str) -> None:
                try:
                    self._stream.emit_delta(
                        source_type=SOURCE_EXECUTION,
                        source_id=execution_id,
                        stream=stream,
                        text=text,
                        run_id=run_id,
                        persist_chunk=True,
                    )
                except Exception:
                    pass

            result = run_with_timeout(
                prepared.argv,
                timeout=timeout,
                max_output_chars=settings.max_output_chars,
                env=prepared.env,
                cwd=prepared.cwd,
                max_process_count=settings.max_process_count,
                max_memory_mb=settings.max_memory_mb,
                max_cpu_seconds=settings.max_cpu_time_seconds,
                on_started=_on_started,
                on_output=_on_output,
            )
            finalized = self._finalize(session_id, execution_id, entry, result=result)
            self._emit_terminal(entry, finalized)
            return finalized
        except Exception as exc:
            finalized = self._finalize(
                session_id,
                execution_id,
                entry,
                error=f"Execution error: {exc}",
            )
            self._emit_terminal(entry, finalized)
            return finalized

    def _emit_terminal(self, entry: dict, finalized: dict) -> None:
        try:
            status = finalized.get("status")
            status_s = status.value if hasattr(status, "value") else str(status or "")
            truncated = bool(finalized.get("truncated"))
            self._stream.emit_terminal(
                source_type=SOURCE_EXECUTION,
                source_id=entry["execution_id"],
                status=status_s.lower() if status_s else "failed",
                exit_code=finalized.get("exit_code"),
                error=finalized.get("stderr_preview") if status_s in (
                    "FAILED", "failed", "TIMEOUT", "timeout", "CANCELLED", "cancelled"
                ) else None,
                truncated=truncated,
                session_id=entry.get("session_id"),
                run_id=entry.get("run_id"),
                extra={
                    "run_type": entry.get("run_type"),
                    "duration_ms": finalized.get("duration_ms"),
                },
            )
        except Exception:
            pass

    # ── Python execution ─────────────────────────────────────────

    def run_python(
        self,
        session_id: str,
        code: str,
        workspace_path: str | None = None,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
        run_id: str | None = None,
        *,
        context: SandboxExecutionContext | None = None,
    ) -> dict[str, Any]:
        context = self._coerce_context(session_id, workspace_path, context)
        execution_id = f"exec_{uuid.uuid4().hex[:10]}"
        timeout = timeout or settings.execution_timeout_seconds
        entry = self._new_entry(
            execution_id,
            session_id,
            "python",
            workspace_id=context.workspace_id,
            run_id=run_id,
            command="python3",
        )
        conflict = self._admit(context.workspace_id, execution_id, entry)
        if conflict is not None:
            return conflict

        code_dir = context.physical_temp / ".pi-executions"
        code_dir.mkdir(parents=True, exist_ok=True)
        code_path = code_dir / f"{execution_id}.py"
        with code_path.open("w", encoding="utf-8") as f:
            f.write(code)
        payload_path = (
            f"/tmp/.pi-executions/{execution_id}.py"
            if self._isolation.name == "bubblewrap"
            else str(code_path)
        )
        try:
            return self._run_body(
                session_id,
                execution_id,
                entry,
                ["python3", "-u", payload_path],
                context,
                timeout,
                env_overrides,
            )
        finally:
            code_path.unlink(missing_ok=True)

    # ── Command execution ────────────────────────────────────────

    def run_command(
        self,
        session_id: str,
        command: str,
        workspace_path: str | None = None,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
        run_id: str | None = None,
        *,
        context: SandboxExecutionContext | None = None,
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

        context = self._coerce_context(session_id, workspace_path, context)
        execution_id = f"exec_{uuid.uuid4().hex[:10]}"
        timeout = timeout or settings.execution_timeout_seconds
        entry = self._new_entry(
            execution_id,
            session_id,
            "command",
            workspace_id=context.workspace_id,
            run_id=run_id,
            command=command,
        )
        conflict = self._admit(context.workspace_id, execution_id, entry)
        if conflict is not None:
            return conflict

        return self._run_body(
            session_id,
            execution_id,
            entry,
            ["bash", "-c", command],
            context,
            timeout,
            env_overrides,
        )

    # ── Node.js execution ────────────────────────────────────────

    def run_node(
        self,
        session_id: str,
        code: str,
        workspace_path: str | None = None,
        timeout: int | None = None,
        env_overrides: dict[str, str] | None = None,
        run_id: str | None = None,
        *,
        context: SandboxExecutionContext | None = None,
    ) -> dict[str, Any]:
        context = self._coerce_context(session_id, workspace_path, context)
        execution_id = f"exec_{uuid.uuid4().hex[:10]}"
        timeout = timeout or settings.execution_timeout_seconds
        entry = self._new_entry(
            execution_id,
            session_id,
            "node",
            workspace_id=context.workspace_id,
            run_id=run_id,
            command="node",
        )
        conflict = self._admit(context.workspace_id, execution_id, entry)
        if conflict is not None:
            return conflict

        code_dir = context.physical_temp / ".pi-executions"
        code_dir.mkdir(parents=True, exist_ok=True)
        code_path = code_dir / f"{execution_id}.js"
        with code_path.open("w", encoding="utf-8") as f:
            f.write(code)
        payload_path = (
            f"/tmp/.pi-executions/{execution_id}.js"
            if self._isolation.name == "bubblewrap"
            else str(code_path)
        )
        try:
            return self._run_body(
                session_id,
                execution_id,
                entry,
                ["node", payload_path],
                context,
                timeout,
                env_overrides,
            )
        finally:
            code_path.unlink(missing_ok=True)

    # ── Query / cancel ───────────────────────────────────────────

    def get(self, execution_id: str) -> dict | None:
        with self._lock:
            mem = self._executions.get(execution_id)
            if mem is not None:
                return mem
        return self.repository.get(execution_id)

    def logs(
        self,
        execution_id: str,
        *,
        offset: int = 0,
        limit: int | None = None,
    ) -> dict[str, Any] | None:
        entry = self.get(execution_id)
        if entry is None:
            return None
        status = entry.get("status")
        completed = status in _TERMINAL_STATUSES
        truncated = bool(entry.get("truncated"))
        lim = limit if limit is not None else settings.max_output_chars
        result = self._stream.get_logs(
            SOURCE_EXECUTION,
            execution_id,
            offset=offset,
            limit=lim,
            completed=completed,
            truncated=truncated,
            session_id=entry.get("session_id"),
        )
        # Fallback: if no chunks yet but previews exist (edge race), surface them
        if not result["stdout"] and not result["stderr"] and offset == 0:
            result["stdout"] = entry.get("stdout_preview") or ""
            result["stderr"] = entry.get("stderr_preview") or ""
            result["next_offset"] = len(result["stdout"]) + len(result["stderr"])
        if truncated and not result.get("full_log_location"):
            result["full_log_location"] = full_log_location(
                SOURCE_EXECUTION,
                execution_id,
                session_id=entry.get("session_id"),
            )
        return result

    def list_events(
        self,
        execution_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[dict[str, Any]] | None:
        if self.get(execution_id) is None:
            return None
        return self._stream.list_events(
            SOURCE_EXECUTION,
            execution_id,
            after_sequence=after_sequence,
            limit=limit,
        )

    def subscribe_events(
        self,
        execution_id: str,
        after_sequence: int,
        callback: Any,
    ) -> Any:
        if self.get(execution_id) is None:
            return None
        return self._stream.subscribe(
            SOURCE_EXECUTION, execution_id, after_sequence, callback
        )

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
                lock_key = entry.get("workspace_id") or entry.get("session_id")
                if lock_key and self._session_locks.get(lock_key) == execution_id:
                    self._session_locks[lock_key] = None
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

    def cancel_active_workspace(self, workspace_id: str) -> dict | None:
        """Cancel the execution mounted on a stable workspace, if any."""
        with self._lock:
            execution_id = self._session_locks.get(workspace_id)
        if not execution_id:
            return None
        self.cancel(execution_id)
        return self.get(execution_id)

    @property
    def total_count(self) -> int:
        return self._total_count


execution_manager = ExecutionManager()
