"""Process Manager — managed long-running / interactive OS processes.

B2 capability: spawn, track, log, stdin, signal, cancel, orphan detection.
Sync bash remains the short-command path (ExecutionManager); this service
owns processes that outlive a single tool HTTP request.
"""

from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
import time
import uuid
from datetime import timezone
from pathlib import Path, PurePosixPath
from typing import Any

from sandbox.config import settings
from sandbox.app.domain.ulid import new_ulid
from sandbox.isolation import IsolationBackend, LaunchSpec, build_isolation_backend
from sandbox.models import ProcessStatus
from sandbox.paths import SandboxPathScope, temp_id_for_workspace_id
from sandbox.security.path_validation import parse_sandbox_path
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.transient_execution_stream import (
    SOURCE_PROCESS,
    full_log_location,
    transient_execution_stream,
)
from sandbox.trace import get_trace_id
from sandbox.utils.resource_limits import (
    _ORPHAN_GROUP_GRACE_SECONDS,
    _READER_JOIN_SECONDS,
    _READER_STOP_JOIN_SECONDS,
    ResourceLimitError,
    apply_resource_limits,
    authoritative_pgid,
    child_resource_limit_kwargs,
    contains_network_command,
    stop_and_join_readers,
    StoppableStreamReader,
    terminate_process_group,
)
from sandbox.services.process_cursor import (
    INITIAL_CURSOR,
    StreamLogBuffer,
    encode_cursor,
    parse_cursor,
)
from sandbox.services.process_identity import (
    capture_process_identity,
    find_pid_namespace_init,
    identity_matches,
    read_pid_namespace_id,
    process_alive,
    safe_signal_identity,
)
from sandbox.services.process_handle_store import FormalProcessDualWriter
from sandbox.services.process_owner_access import OwnerScopedProcessAccess
from sandbox.services.child_workspace_quota import (
    ChildQuotaDecision,
    ChildWorkspaceQuotaWatch,
    assert_child_quota_admit,
    format_decision_message,
)
from sandbox.services.process_runtime_support import (
    DEFAULT_MAX_LOG_CHARS as _DEFAULT_MAX_LOG_CHARS,
    DEFAULT_WAIT_SECONDS as _DEFAULT_WAIT_SECONDS,
    LogBuffer as _LogBuffer,
    is_active as _is_active,
    is_terminal as _is_terminal,
    normalize_authoritative_user_id,
    now_iso as _now_iso,
    positive_int as _positive_int,
    resolve_process_timeout,
    resolve_signal as _resolve_signal,
    status_value as _status_value,
)

logger = logging.getLogger("sandbox.process_manager")


class ProcessManager(OwnerScopedProcessAccess):
    """Manage long-running processes within sandbox sessions.

    Owner-scoped reads and control (``*_owned``) live in
    :class:`~sandbox.services.process_owner_access.OwnerScopedProcessAccess`.
    """

    def __init__(
        self,
        *,
        stream_hub: Any | None = None,
        isolation_backend: IsolationBackend | None = None,
        formal_dual_writer: FormalProcessDualWriter | None = None,
    ) -> None:
        self._stream = (
            stream_hub if stream_hub is not None else transient_execution_stream
        )
        self._isolation = isolation_backend or build_isolation_backend()
        self._formal = formal_dual_writer or FormalProcessDualWriter(None)
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._procs: dict[str, subprocess.Popen[Any]] = {}
        self._logs: dict[str, _LogBuffer] = {}
        # Independent stream cursors (stdout / stderr) — PR-08 process_read.
        self._stream_logs: dict[str, dict[str, StreamLogBuffer]] = {}
        self._done_events: dict[str, threading.Event] = {}
        # Per-process stoppable stdout/stderr readers (poll-based, explicit stop).
        self._readers: dict[str, tuple[StoppableStreamReader, StoppableStreamReader]] = {}
        self._reader_done: dict[str, tuple[threading.Event, threading.Event]] = {}
        # Authoritative process-group id captured at spawn (setsid leader).
        self._pgids: dict[str, int] = {}
        self._cancel_requested: set[str] = set()
        self._timeout_timers: dict[str, threading.Timer] = {}
        # Child workspace/temp total-quota samplers (process lifetime).
        self._quota_watches: dict[str, ChildWorkspaceQuotaWatch] = {}
        self._max_log_chars = max(
            getattr(settings, "max_output_chars", 50_000) * 10,
            _DEFAULT_MAX_LOG_CHARS,
        )
        self._refresh_limits_from_settings()
        self._orphans_marked = 0
        # Formal MySQL recovery runs after lifecycle composition; never touch
        # persistence while modules are being imported.
        with self._lock:
            self._evict_terminal_if_needed()

    def _refresh_limits_from_settings(self) -> None:
        """Load caps from settings (supports test monkeypatch after construct)."""
        self._max_managed = _positive_int(
            getattr(settings, "max_managed_processes", 32), 32
        )
        self._max_managed_per_session = _positive_int(
            getattr(settings, "max_managed_processes_per_session", 8), 8
        )
        self._max_managed_per_owner = _positive_int(
            getattr(settings, "max_managed_processes_per_owner", 16), 16
        )
        self._max_terminal = _positive_int(
            getattr(settings, "max_retained_terminal_processes", 256), 256
        )
        self._max_terminal_per_session = _positive_int(
            getattr(settings, "max_retained_terminal_processes_per_session", 64),
            64,
        )

    def _count_active_locked(
        self,
        *,
        session_id: str | None = None,
        owner_key: str | None = None,
    ) -> int:
        """Count non-terminal managed processes occupying a concurrency slot.

        Includes CREATED (admitted, not yet spawned) so concurrent starts cannot
        overshoot global / session / owner caps.
        """
        n = 0
        for _pid, entry in self._entries.items():
            if not _is_active(entry.get("status")):
                continue
            if session_id is not None and entry.get("session_id") != session_id:
                continue
            if owner_key is not None and entry.get("owner_key") != owner_key:
                continue
            n += 1
        return n

    def _owner_key_for(self, context: SandboxExecutionContext, session_id: str) -> str:
        """Authoritative owner binding for active quotas.

        Prefer non-empty ``context.user_id`` from the trusted session
        (``SessionResponse.user_id`` via :meth:`SandboxExecutionContext.from_session`).
        Never take owner identity from process API bodies.

        Legacy/test contexts without ``user_id`` fall back to an explicitly
        named workspace key (not a silent alias for tenant/user). There is no
        org-level cap here — context does not carry organization_id.
        """
        user_id = normalize_authoritative_user_id(getattr(context, "user_id", None))
        if user_id:
            return f"user:{user_id}"
        workspace_id = (context.workspace_id or "").strip()
        if workspace_id:
            return f"workspace:{workspace_id}"
        return f"session:{session_id}"

    def _clear_reader_handles_locked(self, process_id: str) -> None:
        """Drop reader thread/event/pgid maps for *process_id* (must hold lock)."""
        self._readers.pop(process_id, None)
        self._reader_done.pop(process_id, None)
        self._pgids.pop(process_id, None)

    def _drop_terminal_memory_locked(self, process_id: str) -> bool:
        """Drop in-memory structures for a terminal process. Never touches live procs."""
        if process_id in self._procs:
            return False
        # Never drop while reader threads are still live (reaper must join first).
        readers = self._readers.get(process_id)
        if readers is not None and any(t.is_alive() for t in readers):
            return False
        entry = self._entries.get(process_id)
        if entry is None:
            # Still clean dangling maps if any
            self._logs.pop(process_id, None)
            self._stream_logs.pop(process_id, None)
            self._done_events.pop(process_id, None)
            self._clear_reader_handles_locked(process_id)
            timer = self._timeout_timers.pop(process_id, None)
            if timer is not None:
                timer.cancel()
            self._cancel_requested.discard(process_id)
            return False
        if not _is_terminal(entry.get("status")):
            return False
        self._entries.pop(process_id, None)
        self._logs.pop(process_id, None)
        self._stream_logs.pop(process_id, None)
        self._done_events.pop(process_id, None)
        self._clear_reader_handles_locked(process_id)
        timer = self._timeout_timers.pop(process_id, None)
        if timer is not None:
            timer.cancel()
        self._cancel_requested.discard(process_id)
        return True

    def _persist(self, entry: dict[str, Any]) -> None:
        """Persist to the configured authority before exposing runtime state."""
        if not self._formal.enabled:
            raise RuntimeError("process persistence is not installed")
        self._formal.upsert_from_runtime(entry)

    def _persist_reap_soft(self, process_id: str, entry: dict[str, Any]) -> None:
        """Best-effort persist from the reaper thread — must never block completion.

        By the time the reaper runs, the OS-level process has already exited;
        there is nothing left to fail closed on. Unlike :meth:`_persist` on the
        start/cancel paths, a persistence error here must not stop the terminal
        state from finalizing in memory or the matching ``_done_events`` entry
        from being set — otherwise callers blocked in :meth:`wait` hang for the
        full wait timeout even though the process is already done. Log and
        swallow instead.
        """
        try:
            self._persist(entry)
        except Exception:
            logger.exception(
                "reap: persist failed for %s; finalizing in-memory only",
                process_id,
            )

    def set_formal_repository(
        self,
        repo: Any | None,
        *,
        conn_factory: Any | None = None,
        authoritative: bool = True,
    ) -> None:
        """Install or clear the lifespan-owned formal process repository."""
        self._formal = FormalProcessDualWriter(
            repo,
            conn_factory=conn_factory,
            authoritative=authoritative,
        )

    def _stream_buffers_locked(self, process_id: str) -> dict[str, StreamLogBuffer]:
        bufs = self._stream_logs.get(process_id)
        if bufs is None:
            cap = max(self._max_log_chars // 2, 64_000)
            bufs = {
                "stdout": StreamLogBuffer(cap),
                "stderr": StreamLogBuffer(cap),
            }
            self._stream_logs[process_id] = bufs
        return bufs

    def _cursors_for(self, process_id: str) -> tuple[str, str]:
        with self._lock:
            bufs = self._stream_logs.get(process_id)
            if not bufs:
                return INITIAL_CURSOR, INITIAL_CURSOR
            out = bufs["stdout"]
            err = bufs["stderr"]
            return (
                encode_cursor(out.generation, out.total),
                encode_cursor(err.generation, err.total),
            )

    def _terminal_sort_key(self, entry: dict[str, Any]) -> str:
        return str(
            entry.get("finished_at")
            or entry.get("updated_at")
            or entry.get("created_at")
            or ""
        )

    def _evict_terminal_if_needed(self) -> None:
        """Bound terminal in-memory maps; active processes are never evicted.

        Must be called with ``self._lock`` held. Process logs are live-only by
        design, so an evicted entry cannot be rehydrated through this manager.
        """
        self._refresh_limits_from_settings()

        def _terminal_candidates() -> list[tuple[str, dict[str, Any]]]:
            out: list[tuple[str, dict[str, Any]]] = []
            for pid, entry in self._entries.items():
                if pid in self._procs:
                    continue
                if _is_terminal(entry.get("status")):
                    out.append((pid, entry))
            return out

        # Per-session bound first (owner/session protection).
        if self._max_terminal_per_session > 0:
            by_session: dict[str, list[tuple[str, dict[str, Any]]]] = {}
            for pid, entry in _terminal_candidates():
                sid = str(entry.get("session_id") or "")
                by_session.setdefault(sid, []).append((pid, entry))
            for _sid, items in by_session.items():
                if len(items) <= self._max_terminal_per_session:
                    continue
                items.sort(key=lambda pair: self._terminal_sort_key(pair[1]))
                overflow = len(items) - self._max_terminal_per_session
                for pid, _entry in items[:overflow]:
                    self._drop_terminal_memory_locked(pid)

        # Global bound.
        if self._max_terminal > 0:
            items = _terminal_candidates()
            if len(items) > self._max_terminal:
                items.sort(key=lambda pair: self._terminal_sort_key(pair[1]))
                overflow = len(items) - self._max_terminal
                for pid, _entry in items[:overflow]:
                    self._drop_terminal_memory_locked(pid)

    # ── Orphan detection ─────────────────────────────────────────────

    def mark_orphans(self) -> int:
        """Reconcile active formal process rows after a worker restart."""
        with self._lock:
            return self.recover_formal_orphans()

    def recover_formal_orphans(self) -> int:
        """Resolve formal MySQL process rows left active by a runner restart."""
        recovered = 0
        now = _now_iso()
        for record in self._formal.list_active_for_recovery():
            command_json = (
                dict(record.command_json)
                if isinstance(record.command_json, dict)
                else {}
            )
            start_identity = command_json.get("start_identity")
            pgid = command_json.get("pgid")
            namespace_pid = command_json.get("namespace_pid")
            namespace_start_identity = command_json.get("namespace_start_identity")
            namespace_pgid = command_json.get("namespace_pgid")
            try:
                pgid_i = int(pgid) if pgid is not None else None
            except (TypeError, ValueError):
                pgid_i = None
            try:
                namespace_pid_i = int(namespace_pid) if namespace_pid is not None else None
            except (TypeError, ValueError):
                namespace_pid_i = None
            try:
                namespace_pgid_i = int(namespace_pgid) if namespace_pgid is not None else None
            except (TypeError, ValueError):
                namespace_pgid_i = None

            signaled = False
            # The namespace init is the recovery authority. Killing it (rather
            # than its process group) makes Linux tear down every descendant,
            # including descendants that called setsid().
            if namespace_pid_i is not None and namespace_start_identity:
                result = safe_signal_identity(
                    pid=namespace_pid_i,
                    pgid=None,
                    start_identity=str(namespace_start_identity),
                    signum=signal.SIGTERM,
                )
                if result.get("signaled"):
                    signaled = True
                    if identity_matches(namespace_pid_i, str(namespace_start_identity)):
                        safe_signal_identity(
                            pid=namespace_pid_i,
                            pgid=None,
                            start_identity=str(namespace_start_identity),
                            signum=signal.SIGKILL,
                        )
            if record.pid is not None and start_identity:
                result = safe_signal_identity(
                    pid=int(record.pid),
                    pgid=pgid_i,
                    start_identity=str(start_identity),
                    signum=signal.SIGTERM,
                )
                if result.get("signaled"):
                    signaled = True
                    if identity_matches(int(record.pid), str(start_identity)):
                        safe_signal_identity(
                            pid=int(record.pid),
                            pgid=pgid_i,
                            start_identity=str(start_identity),
                            signum=signal.SIGKILL,
                        )
            elif record.pid is not None and process_alive(record.pid):
                logger.warning(
                    "formal process %s active after restart without "
                    "start_identity; not signaling pid %s",
                    record.process_id,
                    record.pid,
                )

            self._formal.upsert_from_runtime(
                {
                    "process_id": record.process_id,
                    "org_id": record.org_id,
                    "user_id": record.user_id,
                    "sandbox_session_id": record.sandbox_session_id,
                    "session_id": record.sandbox_session_id,
                    "run_id": record.run_id,
                    "execution_id": record.execution_id,
                    "command": command_json.get("command") or "",
                    "cwd": command_json.get("cwd"),
                    "pgid": pgid_i,
                    "start_identity": start_identity,
                    "namespace_pid": namespace_pid_i,
                    "namespace_pgid": namespace_pgid_i,
                    "namespace_start_identity": namespace_start_identity,
                    "pid_namespace": command_json.get("pid_namespace"),
                    "timeout_seconds": command_json.get("timeout_seconds"),
                    "background": bool(command_json.get("background")),
                    "status": ProcessStatus.LOST.value,
                    "pid": record.pid,
                    "exit_code": -signal.SIGTERM if signaled else -1,
                    "stdout_path": record.stdout_path,
                    "stderr_path": record.stderr_path,
                    "started_at": record.started_at,
                    "finished_at": record.ended_at or now,
                    "created_at": record.created_at,
                }
            )
            recovered += 1

        self._orphans_marked += recovered
        if recovered:
            logger.info(
                "Marked %d formal process execution(s) as LOST after restart",
                recovered,
            )
        return recovered

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
        # Compatibility for internal service tests. Public REST callers
        # always resolve this context from the trusted session binding.
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
            user_id=None,  # legacy/test path: workspace-scoped owner fallback
        )

    # ── Start ────────────────────────────────────────────────────────

    def start(
        self,
        *,
        session_id: str,
        command: str,
        workspace_path: str | None = None,
        cwd: str | None = None,
        env: dict[str, str] | None = None,
        timeout: int | None = None,
        background: bool = False,
        run_id: str | None = None,
        context: SandboxExecutionContext | None = None,
        org_id: str | None = None,
        conversation_id: str | None = None,
        sandbox_session_id: str | None = None,
        execution_id: str | None = None,
    ) -> dict[str, Any]:
        """Spawn a managed process. Returns start payload or error dict.

        Returns immediately with a process handle (does not wait for exit).
        """
        if not command or not str(command).strip():
            return {"error": "command is required", "status": "invalid"}

        if settings.default_deny_network and contains_network_command(command):
            return {
                "error": (
                    "Network access is disabled in the sandbox. "
                    "Use sandbox tools for external access."
                ),
                "status": "blocked",
            }

        effective_timeout, timeout_error = resolve_process_timeout(timeout)
        if timeout_error is not None or effective_timeout is None:
            return {
                "error": timeout_error or "invalid timeout",
                "status": "invalid",
            }

        try:
            context = self._coerce_context(session_id, workspace_path, context)
            sandbox_cwd = parse_sandbox_path(cwd or ".")
        except (PermissionError, ValueError) as exc:
            return {"error": str(exc), "status": "invalid"}
        logical_cwd = sandbox_cwd.as_public()
        owner_key = self._owner_key_for(context, session_id)

        # Child quota monitoring admit (bounded measure; fail-closed).
        admit = assert_child_quota_admit(
            context.physical_workspace,
            context.physical_temp,
            workspace_id=context.workspace_id,
        )
        if not admit.allow:
            return {
                "error": format_decision_message(admit),
                "status": "quota_exceeded",
                "code": admit.code or "workspace_quota_enforcement_failed",
            }

        process_id = (
            new_ulid()
            if self._formal.authoritative
            else f"proc_{uuid.uuid4().hex[:12]}"
        )
        now = _now_iso()
        user_id = normalize_authoritative_user_id(
            getattr(context, "user_id", None)
        )
        entry: dict[str, Any] = {
            "process_id": process_id,
            "session_id": session_id,
            "sandbox_session_id": sandbox_session_id or session_id,
            "workspace_id": context.workspace_id,
            "user_id": user_id,
            "org_id": (org_id or "").strip() or None,
            "conversation_id": (conversation_id or "").strip() or None,
            "execution_id": execution_id or process_id,
            "owner_key": owner_key,
            "run_id": run_id,
            "command": command,
            "cwd": logical_cwd,
            "env_json": None,
            "status": ProcessStatus.CREATED.value,
            "pid": None,
            "pgid": None,
            "start_identity": None,
            "namespace_pid": None,
            "namespace_pgid": None,
            "namespace_start_identity": None,
            "pid_namespace": None,
            "exit_code": None,
            "background": bool(background),
            "timeout_seconds": effective_timeout,
            "error": None,
            "stdout_log": "",
            "stderr_log": "",
            "log_truncated": False,
            "log_total": 0,
            "started_at": None,
            "finished_at": None,
            "created_at": now,
            "updated_at": now,
            "trace_id": get_trace_id(),
            "isolation_backend": self._isolation.name,
        }
        if env:
            import json

            entry["env_json"] = json.dumps(env, ensure_ascii=False)

        with self._lock:
            self._refresh_limits_from_settings()
            active_global = self._count_active_locked()
            if self._max_managed > 0 and active_global >= self._max_managed:
                return {
                    "error": f"Max managed processes ({self._max_managed}) reached",
                    "status": "conflict",
                }
            active_session = self._count_active_locked(session_id=session_id)
            if (
                self._max_managed_per_session > 0
                and active_session >= self._max_managed_per_session
            ):
                return {
                    "error": (
                        f"Max managed processes for session "
                        f"({self._max_managed_per_session}) reached"
                    ),
                    "status": "conflict",
                }
            active_owner = self._count_active_locked(owner_key=owner_key)
            if (
                self._max_managed_per_owner > 0
                and active_owner >= self._max_managed_per_owner
            ):
                return {
                    "error": (
                        f"Max managed processes for owner "
                        f"({self._max_managed_per_owner}) reached"
                    ),
                    "status": "conflict",
                }
            self._entries[process_id] = entry
            self._logs[process_id] = _LogBuffer(self._max_log_chars)
            self._stream_buffers_locked(process_id)
            self._done_events[process_id] = threading.Event()
            self._persist(entry)

        # Hard RLIMIT_* + setsid only in child preexec (same path as bash/python).
        _limit_kwargs = child_resource_limit_kwargs(settings)

        try:
            prepared = self._isolation.prepare(
                LaunchSpec(
                    context=context,
                    argv=["bash", "-c", command],
                    relative_cwd=PurePosixPath(sandbox_cwd.relative),
                    cwd_scope=sandbox_cwd.scope,
                    env_overrides=env or {},
                    network_mode=settings.network_mode,
                    # Durable Process Handles persist PID/start identity in
                    # MySQL. They must survive the API process briefly so
                    # restart recovery can TERM/KILL the verified orphan and
                    # mark the formal row LOST.
                    die_with_parent=False,
                    as_pid_1=True,
                    max_process_count=_limit_kwargs["max_process_count"],
                )
            )
            entry["isolation_backend"] = prepared.backend
            if prepared.nproc_limit_applied_inside_namespace:
                _limit_kwargs["max_process_count"] = 0
        except (OSError, PermissionError, ValueError) as exc:
            return self._fail_start(entry, f"Isolation preparation failed: {exc}")

        def _preexec() -> None:
            apply_resource_limits(**_limit_kwargs)

        try:
            proc = subprocess.Popen(
                prepared.argv,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=prepared.cwd,
                env=prepared.env,
                preexec_fn=_preexec,
                bufsize=0,
            )
        except FileNotFoundError as exc:
            return self._fail_start(entry, f"Command not found: {exc}")
        except (ResourceLimitError, subprocess.SubprocessError, OSError) as exc:
            # Fail-closed: child never ran without requested hard limits.
            return self._fail_start(entry, f"Spawn failed: {exc}")

        # Capture pgid while leader pid is still valid (setsid in preexec).
        pgid = authoritative_pgid(proc)
        # Retry capture: process table can lag a few ms after spawn (macOS ps).
        start_identity = None
        for _attempt in range(10):
            os_ident = capture_process_identity(proc.pid, pgid=pgid)
            if os_ident is not None and os_ident.start_identity:
                start_identity = os_ident.start_identity
                break
            time.sleep(0.02)
        if start_identity is None:
            logger.warning(
                "process %s pid=%s: no re-verifiable start_identity; "
                "cancel/kill without live handle will fail closed "
                "(live Popen retained for reaper)",
                process_id,
                proc.pid,
            )

        namespace_pid = None
        namespace_pgid = None
        namespace_start_identity = None
        pid_namespace = None
        if prepared.backend == "bubblewrap":
            namespace_pid = find_pid_namespace_init(proc.pid)
            if namespace_pid is not None:
                try:
                    namespace_pgid = os.getpgid(namespace_pid)
                except (ProcessLookupError, PermissionError, OSError):
                    namespace_pgid = None
                namespace_start_identity = capture_process_identity(
                    namespace_pid,
                    pgid=namespace_pgid,
                )
                if namespace_start_identity is not None:
                    namespace_start_identity = namespace_start_identity.start_identity
                pid_namespace = read_pid_namespace_id(namespace_pid)
            if namespace_pid is None or namespace_start_identity is None:
                logger.warning(
                    "process %s pid=%s: unable to capture PID-namespace init identity",
                    process_id,
                    proc.pid,
                )

        started = _now_iso()
        with self._lock:
            # Cancel may have raced before spawn completed
            if process_id in self._cancel_requested:
                terminate_process_group(proc, grace_seconds=0.5, pgid=pgid)
                entry["status"] = ProcessStatus.CANCELLED.value
                entry["pid"] = proc.pid
                entry["pgid"] = pgid
                entry["start_identity"] = start_identity
                entry["namespace_pid"] = namespace_pid
                entry["namespace_pgid"] = namespace_pgid
                entry["namespace_start_identity"] = namespace_start_identity
                entry["pid_namespace"] = pid_namespace
                entry["started_at"] = started
                entry["finished_at"] = _now_iso()
                entry["exit_code"] = -signal.SIGTERM
                entry["updated_at"] = entry["finished_at"]
                self._persist(entry)
                self._done_events[process_id].set()
                self._clear_reader_handles_locked(process_id)
                self._evict_terminal_if_needed()
                return {
                    "process_id": process_id,
                    "status": ProcessStatus.CANCELLED.value,
                    "started_at": started,
                    "stdout_cursor": INITIAL_CURSOR,
                    "stderr_cursor": INITIAL_CURSOR,
                }

            entry["status"] = ProcessStatus.RUNNING.value
            entry["pid"] = proc.pid
            entry["pgid"] = pgid
            entry["start_identity"] = start_identity
            entry["namespace_pid"] = namespace_pid
            entry["namespace_pgid"] = namespace_pgid
            entry["namespace_start_identity"] = namespace_start_identity
            entry["pid_namespace"] = pid_namespace
            entry["started_at"] = started
            entry["updated_at"] = started
            self._procs[process_id] = proc
            self._pgids[process_id] = namespace_pgid or pgid
            self._persist(entry)

        # B3: lifecycle start event for Agent / SSE consumers
        try:
            self._stream.emit_started(
                source_type=SOURCE_PROCESS,
                source_id=process_id,
                session_id=session_id,
                command=command,
                run_id=run_id,
                extra={"pid": proc.pid, "background": bool(background)},
            )
        except Exception:
            logger.debug("execution_started emit failed for %s", process_id, exc_info=True)

        # Stoppable poll-based readers + reaper. Track handles so reaper can
        # join (bounded) before snapshot; escaped setsid writers cannot hang.
        r_out = StoppableStreamReader(
            proc.stdout,
            name=f"stdout-{process_id}",
            on_text=self._make_stream_sink(process_id, "stdout", run_id),
        )
        r_err = StoppableStreamReader(
            proc.stderr,
            name=f"stderr-{process_id}",
            on_text=self._make_stream_sink(process_id, "stderr", run_id),
        )
        with self._lock:
            self._readers[process_id] = (r_out, r_err)
            self._reader_done[process_id] = (r_out.done_event, r_err.done_event)
        r_out.start()
        r_err.start()
        threading.Thread(
            target=self._reap,
            args=(process_id, proc),
            name=f"proc-reap-{process_id}",
            daemon=True,
        ).start()

        # Always install a finite wall-clock timer (timeout is resolved above).
        timer = threading.Timer(
            float(effective_timeout), self._on_timeout, args=(process_id,)
        )
        timer.daemon = True
        with self._lock:
            self._timeout_timers[process_id] = timer
        timer.start()

        # Monitor workspace/temp (bounded); kill on over-quota or measure failure.
        watch = ChildWorkspaceQuotaWatch(
            workspace_path=context.physical_workspace,
            temp_path=context.physical_temp,
            workspace_id=context.workspace_id,
            on_violation=lambda decision, pid=process_id: self._on_quota_violation(
                pid, decision
            ),
        )
        with self._lock:
            self._quota_watches[process_id] = watch
        watch.start()

        return {
            "process_id": process_id,
            "status": ProcessStatus.RUNNING.value,
            "started_at": started,
            "timeout_seconds": effective_timeout,
            "stdout_cursor": INITIAL_CURSOR,
            "stderr_cursor": INITIAL_CURSOR,
        }

    def _stop_quota_watch(self, process_id: str) -> ChildWorkspaceQuotaWatch | None:
        with self._lock:
            watch = self._quota_watches.pop(process_id, None)
        if watch is not None:
            watch.stop()
        return watch

    def _on_quota_violation(
        self, process_id: str, decision: ChildQuotaDecision
    ) -> None:
        msg = format_decision_message(decision)
        code = decision.code or "workspace_quota_enforcement_failed"
        logger.warning(
            "process %s child quota violation code=%s: %s", process_id, code, msg
        )
        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None or _is_terminal(entry.get("status")):
                return
            entry["status"] = ProcessStatus.FAILED.value
            entry["error"] = msg
            entry["quota_code"] = code
            entry["updated_at"] = _now_iso()
            proc = self._procs.get(process_id)
            pgid = self._pgids.get(process_id)
            self._persist(entry)
        if proc is not None:
            terminate_process_group(proc, grace_seconds=0.5, pgid=pgid)

    def _fail_start(self, entry: dict[str, Any], error: str) -> dict[str, Any]:
        now = _now_iso()
        entry["status"] = ProcessStatus.FAILED.value
        entry["error"] = error
        entry["finished_at"] = now
        entry["updated_at"] = now
        entry["exit_code"] = -1
        with self._lock:
            self._persist(entry)
            done = self._done_events.get(entry["process_id"])
            if done:
                done.set()
            self._evict_terminal_if_needed()
        # B3: surface failed start on the event stream
        try:
            self._stream.emit_started(
                source_type=SOURCE_PROCESS,
                source_id=entry["process_id"],
                session_id=entry.get("session_id"),
                command=entry.get("command"),
                run_id=entry.get("run_id"),
            )
            self._emit_terminal_for(entry["process_id"], entry)
        except Exception:
            logger.debug("fail_start stream emit failed", exc_info=True)
        return {
            "process_id": entry["process_id"],
            "status": ProcessStatus.FAILED.value,
            "started_at": entry.get("started_at") or now,
            "error": error,
        }

    # ── Stream readers / reaper ──────────────────────────────────────

    def _make_stream_sink(
        self,
        process_id: str,
        name: str,
        run_id: str | None,
    ) -> Any:
        """Return ``on_text`` callback for a stoppable stream reader."""

        def _on_text(text: str) -> None:
            if not text:
                return
            with self._lock:
                buf = self._logs.get(process_id)
                if buf is not None:
                    buf.append(name, text)
                streams = self._stream_logs.get(process_id)
                if streams is not None and name in streams:
                    streams[name].append(text)
            try:
                self._stream.emit_delta(
                    source_type=SOURCE_PROCESS,
                    source_id=process_id,
                    stream=name,
                    text=text,
                    run_id=run_id,
                    persist_chunk=True,
                )
            except Exception:
                logger.debug(
                    "delta emit failed %s/%s", process_id, name, exc_info=True
                )

        return _on_text

    def _join_readers(
        self,
        process_id: str,
        proc: subprocess.Popen[Any],
    ) -> bool:
        """Join stdout/stderr readers after the leader exits.

        Mirrors ``run_with_timeout``: bounded natural drain → kill saved
        process group for same-group orphans → explicit ``request_stop`` for
        escaped ``setsid`` writers. Every join has a hard upper bound; never
        bare ``Thread.join()``. Returns True when both readers have exited.
        """
        with self._lock:
            readers = list(self._readers.get(process_id) or ())
            pgid = self._pgids.get(process_id)

        if not readers:
            return True

        def _bounded_join(window: float) -> None:
            deadline = time.monotonic() + max(0.0, float(window))
            for r in readers:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    r.join(timeout=0.0)
                    continue
                r.join(timeout=remaining)

        # 1) Natural drain — well-behaved children close pipes on exit.
        _bounded_join(_READER_JOIN_SECONDS)

        if any(r.is_alive() for r in readers):
            # 2) Same-group orphans still holding pipes.
            terminate_process_group(
                proc,
                grace_seconds=_ORPHAN_GROUP_GRACE_SECONDS,
                pgid=pgid,
            )
            _bounded_join(_READER_JOIN_SECONDS)

        if any(r.is_alive() for r in readers):
            terminate_process_group(
                proc,
                grace_seconds=0.0,
                pgid=pgid,
            )
            _bounded_join(_READER_JOIN_SECONDS)

        if any(r.is_alive() for r in readers):
            # 3) Escaped setsid writers: stop readers (poll loop exits promptly).
            # Never bare-join — that hangs when pipes stay open forever.
            stop_and_join_readers(readers, timeout=_READER_STOP_JOIN_SECONDS)

        drained = not any(r.is_alive() for r in readers)
        if not drained:
            logger.error(
                "process %s reader threads still alive after drain; "
                "terminal snapshot may be incomplete",
                process_id,
            )
        return drained

    def _emit_terminal_for(self, process_id: str, entry: dict[str, Any]) -> None:
        """Best-effort B3 terminal event (idempotent via separate sequence)."""
        try:
            buf = self._logs.get(process_id)
            truncated = bool(entry.get("log_truncated"))
            total = int(entry.get("log_total") or 0)
            if buf is not None:
                _out, _err, total, truncated = buf.snapshot_logs()
            self._stream.emit_terminal(
                source_type=SOURCE_PROCESS,
                source_id=process_id,
                status=_status_value(entry.get("status")),
                exit_code=entry.get("exit_code"),
                error=entry.get("error"),
                truncated=truncated,
                log_total=total,
                session_id=entry.get("session_id"),
                run_id=entry.get("run_id"),
            )
        except Exception:
            logger.debug("terminal emit failed for %s", process_id, exc_info=True)

    def _reap(self, process_id: str, proc: subprocess.Popen[Any]) -> None:
        exit_code: int | None = None
        try:
            exit_code = proc.wait()
        except Exception:
            logger.exception("wait failed for %s", process_id)
            exit_code = -1

        # Drain stdout/stderr fully before snapshot / DB upsert / eviction.
        readers_drained = self._join_readers(process_id, proc)
        quota_watch = self._stop_quota_watch(process_id)

        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None:
                self._clear_reader_handles_locked(process_id)
                return
            # Cancel timeout timer
            timer = self._timeout_timers.pop(process_id, None)
            if timer is not None:
                timer.cancel()

            self._procs.pop(process_id, None)
            current = _status_value(entry.get("status"))

            # Persist log snapshot only after readers finished (or drain failed).
            buf = self._logs.get(process_id)
            if buf is not None:
                stdout, stderr, total, truncated = buf.snapshot_logs()
                entry["stdout_log"] = stdout
                entry["stderr_log"] = stderr
                entry["log_total"] = total
                entry["log_truncated"] = truncated or (not readers_drained)
            elif not readers_drained:
                entry["log_truncated"] = True

            if not readers_drained:
                # Do not silently present incomplete terminal logs as complete.
                note = "log drain incomplete: reader threads did not exit"
                prev_err = entry.get("error")
                entry["error"] = f"{prev_err}; {note}" if prev_err else note

            if current in (
                ProcessStatus.CANCELLED.value,
                ProcessStatus.TIMEOUT.value,
                ProcessStatus.ORPHANED.value,
                ProcessStatus.LOST.value,
            ):
                # Already finalized by cancel/timeout/orphan path
                if entry.get("exit_code") is None:
                    entry["exit_code"] = exit_code
                entry["updated_at"] = _now_iso()
                if not entry.get("finished_at"):
                    entry["finished_at"] = entry["updated_at"]
                self._persist_reap_soft(process_id, entry)
                self._done_events[process_id].set()
                # Still emit terminal for SSE if not already (timeout/cancel may have)
                terminal_entry = dict(entry)
            elif process_id in self._cancel_requested or current == ProcessStatus.CANCEL_REQUESTED.value:
                entry["status"] = ProcessStatus.CANCELLED.value
                entry["exit_code"] = exit_code if exit_code is not None else -signal.SIGTERM
                now = _now_iso()
                entry["finished_at"] = now
                entry["updated_at"] = now
                self._persist_reap_soft(process_id, entry)
                self._cancel_requested.discard(process_id)
                self._done_events[process_id].set()
                terminal_entry = dict(entry)
            elif (
                exit_code == 0
                and readers_drained
                and not (quota_watch is not None and quota_watch.exceeded)
                and current != ProcessStatus.FAILED.value
            ):
                entry["status"] = ProcessStatus.COMPLETED.value
                entry["exit_code"] = 0
                now = _now_iso()
                entry["finished_at"] = now
                entry["updated_at"] = now
                self._persist_reap_soft(process_id, entry)
                self._cancel_requested.discard(process_id)
                self._done_events[process_id].set()
                terminal_entry = dict(entry)
            elif exit_code == 0 and not readers_drained:
                # Exit 0 but incomplete drain → failed, not silent completed.
                entry["status"] = ProcessStatus.FAILED.value
                entry["exit_code"] = 0
                now = _now_iso()
                entry["finished_at"] = now
                entry["updated_at"] = now
                self._persist_reap_soft(process_id, entry)
                self._cancel_requested.discard(process_id)
                self._done_events[process_id].set()
                terminal_entry = dict(entry)
            else:
                entry["status"] = ProcessStatus.FAILED.value
                entry["exit_code"] = exit_code
                now = _now_iso()
                entry["finished_at"] = now
                entry["updated_at"] = now
                self._persist_reap_soft(process_id, entry)
                self._cancel_requested.discard(process_id)
                self._done_events[process_id].set()
                terminal_entry = dict(entry)

            # Readers joined (or marked incomplete); drop handles before eviction.
            self._clear_reader_handles_locked(process_id)
            self._evict_terminal_if_needed()

        self._emit_terminal_for(process_id, terminal_entry)

    def _on_timeout(self, process_id: str) -> None:
        entry_snap: dict[str, Any] | None = None
        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None or _is_terminal(entry.get("status")):
                return
            entry["status"] = ProcessStatus.TIMEOUT.value
            entry["updated_at"] = _now_iso()
            proc = self._procs.get(process_id)
            pgid = self._pgids.get(process_id)
            entry_snap = {
                "pid": entry.get("pid"),
                "pgid": entry.get("pgid") or pgid,
                "start_identity": entry.get("start_identity"),
            }
            self._persist(entry)

        if proc is not None:
            terminate_process_group(proc, grace_seconds=1.0, pgid=pgid)
        elif entry_snap is not None:
            # No live handle: identity-safe signal only (never blind PID kill).
            safe_signal_identity(
                pid=entry_snap.get("pid"),
                pgid=entry_snap.get("pgid"),
                start_identity=entry_snap.get("start_identity"),
                signum=signal.SIGKILL,
            )

        with self._lock:
            entry = self._entries.get(process_id)
            if entry is not None and not entry.get("finished_at"):
                entry["finished_at"] = _now_iso()
                entry["exit_code"] = entry.get("exit_code")
                if entry.get("exit_code") is None:
                    entry["exit_code"] = -signal.SIGKILL
                entry["updated_at"] = entry["finished_at"]
                self._persist(entry)

    # ── Query ────────────────────────────────────────────────────────

    def get(self, process_id: str) -> dict[str, Any] | None:
        with self._lock:
            mem = self._entries.get(process_id)
            return self._public_view(mem) if mem is not None else None

    def _public_view(self, entry: dict[str, Any]) -> dict[str, Any]:
        process_id = entry["process_id"]
        stdout_c, stderr_c = self._cursors_for(process_id)
        started = entry.get("started_at")
        elapsed = None
        if started:
            try:
                from datetime import datetime as _dt

                t0 = _dt.fromisoformat(str(started).replace("Z", "+00:00"))
                elapsed = max(0, int((_dt.now(timezone.utc) - t0).total_seconds()))
            except Exception:
                elapsed = None
        return {
            "process_id": entry["process_id"],
            "session_id": entry["session_id"],
            "run_id": entry.get("run_id"),
            "command": entry.get("command", ""),
            "status": _status_value(entry.get("status")),
            "pid": entry.get("pid"),
            "exit_code": entry.get("exit_code"),
            "background": bool(entry.get("background")),
            "cwd": entry.get("cwd"),
            "error": entry.get("error"),
            "timeout_seconds": entry.get("timeout_seconds"),
            "started_at": entry.get("started_at"),
            "finished_at": entry.get("finished_at"),
            "created_at": entry.get("created_at", ""),
            "updated_at": entry.get("updated_at", ""),
            "trace_id": entry.get("trace_id"),
            "stdout_cursor": stdout_c if _is_active(entry.get("status")) else stdout_c,
            "stderr_cursor": stderr_c,
            "elapsed_seconds": elapsed,
            # Do not expose start_identity / org internals on public view.
        }

    def logs(
        self,
        process_id: str,
        *,
        offset: int = 0,
        limit: int | None = None,
    ) -> dict[str, Any] | None:
        entry = self.get(process_id)
        if entry is None:
            return None
        lim = limit if limit is not None else settings.max_output_chars
        completed = _is_terminal(entry.get("status"))
        with self._lock:
            buf = self._logs.get(process_id)
            if buf is not None:
                stdout, stderr, next_offset, truncated = buf.slice(offset, lim)
                log_total = buf.total
            else:
                stdout = ""
                stderr = ""
                next_offset = offset
                truncated = False
                log_total = 0
                buf = None

        # Prefer durable chunks when memory buffer missed history (restart / truncate).
        if (not stdout and not stderr) or truncated:
            try:
                durable = self._stream.get_logs(
                    SOURCE_PROCESS,
                    process_id,
                    offset=offset,
                    limit=lim,
                    completed=completed,
                    truncated=truncated,
                    session_id=entry.get("session_id"),
                )
                if durable["stdout"] or durable["stderr"]:
                    stdout = durable["stdout"] or stdout
                    stderr = durable["stderr"] or stderr
                    next_offset = durable["next_offset"]
            except Exception:
                logger.debug("durable log read failed for %s", process_id, exc_info=True)

        loc = full_log_location(
            SOURCE_PROCESS, process_id, session_id=entry.get("session_id")
        )
        return {
            "stdout": stdout,
            "stderr": stderr,
            "next_offset": next_offset,
            "completed": completed,
            "truncated": truncated,
            "full_log_location": loc if truncated else None,
            "log_total": log_total,
        }

    def list_events(
        self,
        process_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[dict[str, Any]] | None:
        if self.get(process_id) is None:
            return None
        return self._stream.list_events(
            SOURCE_PROCESS,
            process_id,
            after_sequence=after_sequence,
            limit=limit,
        )

    def subscribe_events(
        self,
        process_id: str,
        after_sequence: int,
        callback: Any,
    ) -> Any:
        """Subscribe to live process events; returns unsubscribe callable or None."""
        if self.get(process_id) is None:
            return None
        return self._stream.subscribe(
            SOURCE_PROCESS, process_id, after_sequence, callback
        )

    def wait(
        self,
        process_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any] | None:
        entry = self.get(process_id)
        if entry is None:
            return None
        if _is_terminal(entry.get("status")):
            return entry
        with self._lock:
            done = self._done_events.get(process_id)
        if done is None:
            # No sync object: re-read (may have become terminal / DB-only).
            return self.get(process_id)
        wait_s = _DEFAULT_WAIT_SECONDS if timeout is None else max(0.0, float(timeout))
        done.wait(timeout=wait_s)
        return self.get(process_id)

    # ── Stdin / signal / cancel ──────────────────────────────────────

    def write_stdin(
        self,
        process_id: str,
        data: str,
        *,
        eof: bool = False,
    ) -> dict[str, Any]:
        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None:
                return {"error": "not found", "status": "not_found"}
            if _is_terminal(entry.get("status")):
                return {"error": "process is not running", "status": "terminal"}
            proc = self._procs.get(process_id)
            if proc is None or proc.stdin is None:
                return {"error": "stdin not available", "status": "unavailable"}

        try:
            if data:
                payload = data.encode("utf-8")
                proc.stdin.write(payload)
                proc.stdin.flush()
            if eof:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
        except BrokenPipeError:
            return {"error": "broken pipe", "status": "failed"}
        except Exception as exc:
            return {"error": f"stdin write failed: {exc}", "status": "failed"}

        with self._lock:
            # Soft hint that process may have been waiting for input
            if _status_value(entry.get("status")) == ProcessStatus.WAITING_INPUT.value:
                entry["status"] = ProcessStatus.RUNNING.value
                entry["updated_at"] = _now_iso()
                self._persist(entry)

        return {"ok": True, "status": _status_value(entry.get("status"))}

    def signal_process(self, process_id: str, sig: str | int = "SIGTERM") -> dict[str, Any]:
        try:
            signum = _resolve_signal(sig)
        except ValueError as exc:
            return {"error": str(exc), "status": "invalid"}

        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None:
                return {"error": "not found", "status": "not_found"}
            if _is_terminal(entry.get("status")):
                # Idempotent: already terminal is not an error for kill semantics.
                return {
                    "ok": True,
                    "status": _status_value(entry.get("status")),
                    "signal": signum,
                    "idempotent": True,
                }
            proc = self._procs.get(process_id)
            pgid = self._pgids.get(process_id) or entry.get("pgid")
            pid = entry.get("pid") or (proc.pid if proc else None)
            start_identity = entry.get("start_identity")

        if proc is None and pid is None:
            return {"error": "no live process handle", "status": "unavailable"}

        delivered = False
        try:
            if proc is not None:
                # Live Popen handle: we own the process; signal without identity.
                # Keep the handle so the reaper can finalize (do not drop it).
                try:
                    if pgid is not None:
                        os.killpg(int(pgid), signum)
                    else:
                        os.killpg(os.getpgid(proc.pid), signum)
                    delivered = True
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        proc.send_signal(signum)
                        delivered = True
                    except (ProcessLookupError, PermissionError, OSError) as exc:
                        return {
                            "error": f"signal failed: {exc}",
                            "status": "failed",
                            "signaled": False,
                        }
            else:
                # No handle: only signal if durable identity still matches.
                if not process_alive(pid):
                    # Already gone — ok without signal delivery.
                    with self._lock:
                        entry["updated_at"] = _now_iso()
                        if not _is_terminal(entry.get("status")):
                            entry["status"] = ProcessStatus.CANCELLED.value
                            entry["finished_at"] = entry.get("finished_at") or _now_iso()
                            if entry.get("exit_code") is None:
                                entry["exit_code"] = -signum
                            self._persist(entry)
                            done = self._done_events.get(process_id)
                            if done:
                                done.set()
                    return {
                        "ok": True,
                        "status": _status_value(entry.get("status")),
                        "signal": signum,
                        "already_dead": True,
                    }
                r = safe_signal_identity(
                    pid=pid,
                    pgid=int(pgid) if pgid is not None else None,
                    start_identity=start_identity,
                    signum=signum,
                )
                if not r.get("signaled"):
                    # Never claim success when identity is unverifiable / mismatch.
                    return {
                        "error": "process identity mismatch, missing, or gone",
                        "status": "unavailable",
                        "reason": r.get("reason"),
                        "ok": False,
                        "signaled": False,
                    }
                delivered = True
        except (ProcessLookupError, PermissionError, OSError) as exc:
            return {
                "error": f"signal failed: {exc}",
                "status": "failed",
                "ok": False,
                "signaled": False,
            }

        if not delivered:
            return {
                "error": "signal not delivered",
                "status": "failed",
                "ok": False,
                "signaled": False,
            }

        with self._lock:
            entry["updated_at"] = _now_iso()
            # SIGKILL via signal API escalates cancel request.
            if signum == signal.SIGKILL:
                self._cancel_requested.add(process_id)
                if not _is_terminal(entry.get("status")):
                    entry["status"] = ProcessStatus.CANCEL_REQUESTED.value
            self._persist(entry)

        return {
            "ok": True,
            "status": _status_value(entry.get("status")),
            "signal": signum,
            "signaled": True,
        }

    def cancel(self, process_id: str) -> bool:
        """Request cancel: kill process group, mark cancelled only when safe.

        Idempotent: repeated cancel on terminal process returns True without
        re-signaling.

        Rules (PR-08 fail-closed):
        - Live Popen handle → terminate via handle; keep handle for reaper;
          return True (request delivered). Reaper writes terminal status.
        - No handle + process dead → write CANCELLED, return True.
        - No handle + re-verifiable identity match → signal; if still alive
          after KILL attempt, do **not** write false CANCELLED; return False.
        - No handle + no identity / mismatch → never signal, never claim
          CANCELLED while alive; return False.
        """
        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None:
                return False
            status = entry.get("status")
            if _is_terminal(status):
                return True
            if not _is_active(status) and process_id not in self._cancel_requested:
                return False

            self._cancel_requested.add(process_id)
            entry["status"] = ProcessStatus.CANCEL_REQUESTED.value
            entry["updated_at"] = _now_iso()
            self._persist(entry)
            proc = self._procs.get(process_id)
            pgid = self._pgids.get(process_id) or entry.get("pgid")
            start_identity = entry.get("start_identity")
            pid = entry.get("pid")
            timer = self._timeout_timers.pop(process_id, None)
            if timer is not None:
                timer.cancel()

        via_handle = False
        identity_signaled = False
        if proc is not None:
            # Own the live handle: terminate group; reaper finalizes terminal.
            terminate_process_group(proc, grace_seconds=2.0, pgid=pgid)
            via_handle = True
        else:
            if pid is not None and not process_alive(pid):
                # Already reaped externally.
                with self._lock:
                    entry = self._entries.get(process_id) or entry
                    if not _is_terminal(entry.get("status")):
                        entry["status"] = ProcessStatus.CANCELLED.value
                        if entry.get("exit_code") is None:
                            entry["exit_code"] = -signal.SIGTERM
                        entry["finished_at"] = entry.get("finished_at") or _now_iso()
                        entry["updated_at"] = _now_iso()
                        self._persist(entry)
                        done = self._done_events.get(process_id)
                        if done:
                            done.set()
                return True

            r = safe_signal_identity(
                pid=pid,
                pgid=int(pgid) if pgid is not None else None,
                start_identity=start_identity,
                signum=signal.SIGTERM,
            )
            if r.get("signaled"):
                identity_signaled = True
                # Escalate if still the same process.
                if identity_matches(pid, start_identity):
                    safe_signal_identity(
                        pid=pid,
                        pgid=int(pgid) if pgid is not None else None,
                        start_identity=start_identity,
                        signum=signal.SIGKILL,
                    )
            else:
                # Cannot verify / cannot signal: leave cancel_requested, no fake end.
                with self._lock:
                    entry = self._entries.get(process_id) or entry
                    if not _is_terminal(entry.get("status")):
                        entry["status"] = ProcessStatus.CANCEL_REQUESTED.value
                        prev = entry.get("error")
                        note = (
                            "cancel not delivered: "
                            f"{r.get('reason') or 'identity_unverified'}"
                        )
                        entry["error"] = f"{prev}; {note}" if prev else note
                        entry["updated_at"] = _now_iso()
                        self._persist(entry)
                return False

        with self._lock:
            entry = self._entries.get(process_id) or entry
            still_have_handle = process_id in self._procs

            if via_handle and still_have_handle:
                # Reaper will mark CANCELLED; do not invent terminal state.
                return True

            if still_have_handle:
                return True

            # No live handle: only write CANCELLED if the OS process is gone
            # or we successfully identity-signaled and it is no longer alive.
            alive = process_alive(pid) if pid is not None else False
            if alive and not identity_signaled:
                entry["status"] = ProcessStatus.CANCEL_REQUESTED.value
                note = "cancel incomplete: process still alive"
                prev = entry.get("error")
                entry["error"] = f"{prev}; {note}" if prev else note
                entry["updated_at"] = _now_iso()
                self._persist(entry)
                return False

            if alive and identity_signaled:
                # Brief grace: re-check once more under identity.
                if identity_matches(pid, start_identity) and process_alive(pid):
                    entry["status"] = ProcessStatus.CANCEL_REQUESTED.value
                    note = "cancel signaled but process still alive"
                    prev = entry.get("error")
                    entry["error"] = f"{prev}; {note}" if prev else note
                    entry["updated_at"] = _now_iso()
                    self._persist(entry)
                    return False

            if not _is_terminal(entry.get("status")) or _status_value(
                entry.get("status")
            ) == ProcessStatus.CANCEL_REQUESTED.value:
                entry["status"] = ProcessStatus.CANCELLED.value
                if entry.get("exit_code") is None:
                    entry["exit_code"] = -signal.SIGTERM
                entry["finished_at"] = entry.get("finished_at") or _now_iso()
                entry["updated_at"] = _now_iso()
                self._persist(entry)
                done = self._done_events.get(process_id)
                if done:
                    done.set()
            return True

    def read_stream(
        self,
        process_id: str,
        *,
        stream: str = "stdout",
        cursor: str | None = INITIAL_CURSOR,
        limit: int = 8192,
    ) -> dict[str, Any] | None:
        """Incremental cursor read for one stream (process_read contract).

        Never loads entire log history into a new buffer beyond retained window.
        """
        entry = self.get(process_id)
        if entry is None:
            return None
        stream_name = "stderr" if str(stream).lower() == "stderr" else "stdout"
        try:
            cur = parse_cursor(cursor)
        except ValueError as exc:
            return {
                "process_id": process_id,
                "stream": stream_name,
                "error": str(exc),
                "status": "invalid",
            }
        lim = max(1, min(int(limit or 8192), 65_536))
        completed = _is_terminal(entry.get("status"))
        with self._lock:
            bufs = self._stream_logs.get(process_id)
            if bufs is None:
                bufs = self._stream_buffers_locked(process_id)
            sbuf = bufs[stream_name]
            result = sbuf.read(cur, limit=lim)

        return {
            "process_id": process_id,
            "stream": stream_name,
            "cursor": result["cursor"],
            "next_cursor": result["next_cursor"],
            "data": result["data"],
            "truncated": bool(result.get("truncated")),
            "completed": completed,
            "status": entry.get("status"),
            "dropped": bool(result.get("dropped")),
            "log_total": int(result.get("log_total") or 0),
        }

    def cancel_for_session(
        self,
        session_id: str,
        *,
        foreground_only: bool = False,
        return_details: bool = False,
    ) -> list[str] | dict[str, list[str]]:
        """Cancel processes owned by a session.

        Returns only process_ids for which cancel was **delivered** (or already
        terminal). Undelivered actives are omitted from the success list.

        When ``return_details=True``, returns
        ``{"cancelled": [...], "failed": [...]}`` so callers can surface partial
        batch failure without inventing terminal success.
        """
        cancelled: list[str] = []
        failed: list[str] = []
        with self._lock:
            candidates = [
                e
                for e in self._entries.values()
                if e.get("session_id") == session_id and _is_active(e.get("status"))
            ]
        for entry in candidates:
            if foreground_only and entry.get("background"):
                continue
            pid = entry["process_id"]
            if self.cancel(pid):
                cancelled.append(pid)
            else:
                failed.append(pid)
        if return_details:
            return {"cancelled": cancelled, "failed": failed}
        return cancelled

    def cancel_for_workspace(
        self,
        workspace_id: str,
        *,
        wait_timeout: float = 5.0,
    ) -> list[str]:
        """Cancel every live process currently mounted on a workspace.

        Workspace identity can span multiple restored Agent sessions, so
        lifecycle cleanup must not stop at a single ``session_id``.
        """
        with self._lock:
            candidates = [
                e
                for e in self._entries.values()
                if e.get("workspace_id") == workspace_id
                and _is_active(e.get("status"))
            ]

        cancelled: list[str] = []
        for entry in candidates:
            process_id = entry["process_id"]
            if self.cancel(process_id):
                cancelled.append(process_id)

        if cancelled and wait_timeout > 0:
            deadline = time.monotonic() + wait_timeout
            for process_id in cancelled:
                remaining = max(0.0, deadline - time.monotonic())
                self.wait(process_id, timeout=remaining)
        return cancelled

    def cancel_for_run(
        self,
        run_id: str,
        *,
        return_details: bool = False,
    ) -> list[str] | dict[str, list[str]]:
        """Cancel all processes associated with an agent run.

        Success list contains only delivered cancels (see ``cancel_for_session``).
        """
        cancelled: list[str] = []
        failed: list[str] = []
        with self._lock:
            candidates = [
                e
                for e in self._entries.values()
                if e.get("run_id") == run_id and _is_active(e.get("status"))
            ]
        for entry in candidates:
            pid = entry["process_id"]
            if self.cancel(pid):
                cancelled.append(pid)
            else:
                failed.append(pid)
        if return_details:
            return {"cancelled": cancelled, "failed": failed}
        return cancelled

    @property
    def total_count(self) -> int:
        with self._lock:
            return len(self._entries)

    @property
    def orphans_marked(self) -> int:
        return self._orphans_marked


process_manager = ProcessManager()
