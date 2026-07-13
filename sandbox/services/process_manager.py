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
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any

from sandbox.config import settings
from sandbox.database import Database
from sandbox.isolation import IsolationBackend, LaunchSpec, build_isolation_backend
from sandbox.models import (
    PROCESS_ACTIVE_STATUSES,
    PROCESS_TERMINAL_STATUSES,
    ProcessStatus,
)
from sandbox.repositories import ProcessRepository
from sandbox.paths import SandboxPathScope, temp_id_for_workspace_id
from sandbox.security.path_validation import parse_sandbox_path
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.execution_stream import (
    SOURCE_PROCESS,
    execution_stream,
    full_log_location,
)
from sandbox.trace import get_trace_id
from sandbox.utils.resource_limits import (
    apply_resource_limits,
    contains_network_command,
    terminate_process_group,
)

logger = logging.getLogger("sandbox.process_manager")

# Cap in-memory log buffers so a noisy process cannot OOM the runner.
_DEFAULT_MAX_LOG_CHARS = 500_000
_READER_JOIN_SECONDS = 2.0
_DEFAULT_WAIT_SECONDS = 3600.0


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _status_value(status: Any) -> str:
    if hasattr(status, "value"):
        return str(status.value)
    return str(status)


def _is_terminal(status: Any) -> bool:
    return status in PROCESS_TERMINAL_STATUSES or _status_value(status) in {
        _status_value(s) for s in PROCESS_TERMINAL_STATUSES if isinstance(s, str) or hasattr(s, "value")
    }


def _is_active(status: Any) -> bool:
    return status in PROCESS_ACTIVE_STATUSES or _status_value(status) in {
        _status_value(s) for s in PROCESS_ACTIVE_STATUSES if isinstance(s, str) or hasattr(s, "value")
    }


class _LogBuffer:
    """Interleaved stdout/stderr buffer with offset-based slice reads."""

    def __init__(self, max_chars: int = _DEFAULT_MAX_LOG_CHARS) -> None:
        self._lock = threading.Lock()
        self.max_chars = max_chars
        self.stdout = ""
        self.stderr = ""
        # (global_start_offset, stream, text)
        self._events: list[tuple[int, str, str]] = []
        self.total = 0
        self.truncated = False
        self._buffer_start = 0  # global offset of first retained event

    def append(self, stream: str, text: str) -> None:
        if not text:
            return
        with self._lock:
            # Oversized single chunk: keep only the tail within max_chars.
            if len(text) > self.max_chars:
                self.truncated = True
                text = text[-self.max_chars :]
            start = self.total
            self._events.append((start, stream, text))
            self.total += len(text)
            if stream == "stdout":
                self.stdout += text
            else:
                self.stderr += text
            self._trim_if_needed()

    def _trim_if_needed(self) -> None:
        retained = self.total - self._buffer_start
        if retained <= self.max_chars:
            return
        # Drop oldest events until under budget.
        self.truncated = True
        target_start = self.total - self.max_chars
        drop_idx = 0
        for i, (start, _stream, text) in enumerate(self._events):
            if start + len(text) <= target_start:
                drop_idx = i + 1
            else:
                # Partially drop within this event
                keep_from = target_start - start
                if keep_from > 0 and keep_from < len(text):
                    stream = _stream
                    new_text = text[keep_from:]
                    self._events[i] = (target_start, stream, new_text)
                    drop_idx = i
                else:
                    drop_idx = i
                break
        if drop_idx:
            self._events = self._events[drop_idx:]
        if self._events:
            self._buffer_start = self._events[0][0]
        else:
            self._buffer_start = self.total
        # Rebuild stream views from retained events
        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        for _start, stream, text in self._events:
            if stream == "stdout":
                stdout_parts.append(text)
            else:
                stderr_parts.append(text)
        self.stdout = "".join(stdout_parts)
        self.stderr = "".join(stderr_parts)

    def slice(self, offset: int, limit: int) -> tuple[str, str, int, bool]:
        """Return (stdout, stderr, next_offset, truncated) for [offset, offset+limit)."""
        with self._lock:
            if offset < 0:
                offset = 0
            if limit <= 0:
                limit = self.max_chars
            truncated = self.truncated or offset < self._buffer_start
            effective_offset = max(offset, self._buffer_start)
            stdout_parts: list[str] = []
            stderr_parts: list[str] = []
            consumed = 0
            next_off = effective_offset
            for start, stream, text in self._events:
                end = start + len(text)
                if end <= effective_offset:
                    continue
                local_start = max(0, effective_offset - start)
                chunk = text[local_start:]
                if consumed + len(chunk) > limit:
                    chunk = chunk[: limit - consumed]
                if not chunk:
                    break
                if stream == "stdout":
                    stdout_parts.append(chunk)
                else:
                    stderr_parts.append(chunk)
                consumed += len(chunk)
                next_off = start + local_start + len(chunk)
                if consumed >= limit:
                    break
            else:
                next_off = self.total
            return (
                "".join(stdout_parts),
                "".join(stderr_parts),
                next_off,
                truncated,
            )

    def snapshot_logs(self) -> tuple[str, str, int, bool]:
        with self._lock:
            return self.stdout, self.stderr, self.total, self.truncated


_SIGNAL_MAP: dict[str, int] = {
    "SIGTERM": signal.SIGTERM,
    "SIGINT": signal.SIGINT,
    "SIGKILL": signal.SIGKILL,
    "SIGHUP": signal.SIGHUP,
    "SIGUSR1": getattr(signal, "SIGUSR1", signal.SIGTERM),
    "SIGUSR2": getattr(signal, "SIGUSR2", signal.SIGTERM),
    "15": signal.SIGTERM,
    "2": signal.SIGINT,
    "9": signal.SIGKILL,
}


def _resolve_signal(sig: str | int) -> int:
    if isinstance(sig, int):
        return sig
    raw = str(sig or "SIGTERM").strip().upper()
    if raw in _SIGNAL_MAP:
        return _SIGNAL_MAP[raw]
    if raw.isdigit():
        return int(raw)
    # Allow "TERM" / "INT" short forms
    long_name = raw if raw.startswith("SIG") else f"SIG{raw}"
    if long_name in _SIGNAL_MAP:
        return _SIGNAL_MAP[long_name]
    raise ValueError(f"Unknown signal: {sig}")


class ProcessManager:
    """Manage long-running processes within sandbox sessions."""

    def __init__(
        self,
        database: Database | None = None,
        *,
        stream_hub: Any | None = None,
        isolation_backend: IsolationBackend | None = None,
    ) -> None:
        self.repository = ProcessRepository(database)
        self._stream = stream_hub if stream_hub is not None else execution_stream
        self._isolation = isolation_backend or build_isolation_backend()
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, Any]] = {}
        self._procs: dict[str, subprocess.Popen[Any]] = {}
        self._logs: dict[str, _LogBuffer] = {}
        self._done_events: dict[str, threading.Event] = {}
        self._cancel_requested: set[str] = set()
        self._timeout_timers: dict[str, threading.Timer] = {}
        self._max_log_chars = max(
            getattr(settings, "max_output_chars", 50_000) * 10,
            _DEFAULT_MAX_LOG_CHARS,
        )
        self._max_managed = int(getattr(settings, "max_managed_processes", 32) or 32)
        self._orphans_marked = 0
        # Mark any pre-existing active rows as orphaned (runner restart).
        self._mark_orphans_from_db()

    # ── Orphan detection ─────────────────────────────────────────────

    def _mark_orphans_from_db(self) -> int:
        """On startup, non-terminal process rows cannot have live handles."""
        count = 0
        try:
            active = self.repository.list_active()
        except Exception:
            # Table may not exist yet during very early import; lifespan re-runs.
            logger.exception("process orphan scan failed (table may be missing)")
            return 0
        now = _now_iso()
        for row in active:
            pid = row["process_id"]
            row["status"] = ProcessStatus.ORPHANED.value
            row["finished_at"] = row.get("finished_at") or now
            row["updated_at"] = now
            row["error"] = row.get("error") or "orphaned: runner restart"
            try:
                self.repository.upsert(row)
            except Exception:
                logger.exception("failed to mark process %s orphaned", pid)
                continue
            self._entries[pid] = row
            self._logs[pid] = _LogBuffer(self._max_log_chars)
            # Seed log buffer from persisted snapshots (best-effort).
            buf = self._logs[pid]
            if row.get("stdout_log"):
                buf.append("stdout", row["stdout_log"])
            if row.get("stderr_log"):
                buf.append("stderr", row["stderr_log"])
            self._done_events[pid] = threading.Event()
            self._done_events[pid].set()
            count += 1
        self._orphans_marked = count
        if count:
            logger.info("Marked %d process execution(s) as orphaned", count)
        return count

    def mark_orphans(self) -> int:
        """Public re-scan (e.g. lifespan). Idempotent for already-orphaned rows."""
        with self._lock:
            return self._mark_orphans_from_db()

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
        # Compatibility for internal service tests. Public REST/MCP callers
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
    ) -> dict[str, Any]:
        """Spawn a managed process. Returns start payload or error dict."""
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

        try:
            context = self._coerce_context(session_id, workspace_path, context)
            sandbox_cwd = parse_sandbox_path(cwd or ".")
        except (PermissionError, ValueError) as exc:
            return {"error": str(exc), "status": "invalid"}
        logical_cwd = sandbox_cwd.as_public()

        process_id = f"proc_{uuid.uuid4().hex[:12]}"
        now = _now_iso()
        entry: dict[str, Any] = {
            "process_id": process_id,
            "session_id": session_id,
            "workspace_id": context.workspace_id,
            "run_id": run_id,
            "command": command,
            "cwd": logical_cwd,
            "env_json": None,
            "status": ProcessStatus.CREATED.value,
            "pid": None,
            "exit_code": None,
            "background": bool(background),
            "timeout_seconds": timeout,
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
            active_count = sum(
                1
                for e in self._entries.values()
                if _is_active(e.get("status")) and e.get("process_id") in self._procs
            )
            if self._max_managed > 0 and active_count >= self._max_managed:
                return {
                    "error": f"Max managed processes ({self._max_managed}) reached",
                    "status": "conflict",
                }
            self._entries[process_id] = entry
            self._logs[process_id] = _LogBuffer(self._max_log_chars)
            self._done_events[process_id] = threading.Event()
            self.repository.upsert(entry)

        def _preexec() -> None:
            apply_resource_limits(
                max_process_count=settings.max_process_count,
                max_memory_mb=settings.max_memory_mb,
                max_cpu_seconds=settings.max_cpu_time_seconds,
            )

        try:
            prepared = self._isolation.prepare(
                LaunchSpec(
                    context=context,
                    argv=["bash", "-c", command],
                    relative_cwd=PurePosixPath(sandbox_cwd.relative),
                    cwd_scope=sandbox_cwd.scope,
                    env_overrides=env or {},
                    network_mode=settings.network_mode,
                )
            )
            entry["isolation_backend"] = prepared.backend
        except (OSError, PermissionError, ValueError) as exc:
            return self._fail_start(entry, f"Isolation preparation failed: {exc}")

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
        except OSError as exc:
            return self._fail_start(entry, f"Spawn failed: {exc}")

        started = _now_iso()
        with self._lock:
            # Cancel may have raced before spawn completed
            if process_id in self._cancel_requested:
                terminate_process_group(proc, grace_seconds=0.5)
                entry["status"] = ProcessStatus.CANCELLED.value
                entry["pid"] = proc.pid
                entry["started_at"] = started
                entry["finished_at"] = _now_iso()
                entry["exit_code"] = -signal.SIGTERM
                entry["updated_at"] = entry["finished_at"]
                self.repository.upsert(entry)
                self._done_events[process_id].set()
                return {
                    "process_id": process_id,
                    "status": ProcessStatus.CANCELLED.value,
                    "started_at": started,
                }

            entry["status"] = ProcessStatus.RUNNING.value
            entry["pid"] = proc.pid
            entry["started_at"] = started
            entry["updated_at"] = started
            self._procs[process_id] = proc
            self.repository.upsert(entry)

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

        # Reader threads + reaper
        threading.Thread(
            target=self._read_stream,
            args=(process_id, proc.stdout, "stdout", run_id),
            name=f"proc-stdout-{process_id}",
            daemon=True,
        ).start()
        threading.Thread(
            target=self._read_stream,
            args=(process_id, proc.stderr, "stderr", run_id),
            name=f"proc-stderr-{process_id}",
            daemon=True,
        ).start()
        threading.Thread(
            target=self._reap,
            args=(process_id, proc),
            name=f"proc-reap-{process_id}",
            daemon=True,
        ).start()

        if timeout is not None and timeout > 0:
            timer = threading.Timer(float(timeout), self._on_timeout, args=(process_id,))
            timer.daemon = True
            with self._lock:
                self._timeout_timers[process_id] = timer
            timer.start()

        return {
            "process_id": process_id,
            "status": ProcessStatus.RUNNING.value,
            "started_at": started,
        }

    def _fail_start(self, entry: dict[str, Any], error: str) -> dict[str, Any]:
        now = _now_iso()
        entry["status"] = ProcessStatus.FAILED.value
        entry["error"] = error
        entry["finished_at"] = now
        entry["updated_at"] = now
        entry["exit_code"] = -1
        with self._lock:
            self.repository.upsert(entry)
            done = self._done_events.get(entry["process_id"])
            if done:
                done.set()
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

    def _read_stream(
        self,
        process_id: str,
        stream: Any,
        name: str,
        run_id: str | None = None,
    ) -> None:
        try:
            while True:
                chunk = stream.read(4096)
                if not chunk:
                    break
                text = chunk.decode("utf-8", errors="replace")
                buf = self._logs.get(process_id)
                if buf is not None:
                    buf.append(name, text)
                # B3: live delta + durable chunk
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
        except Exception:
            logger.debug("stream reader %s/%s ended with error", process_id, name, exc_info=True)
        finally:
            try:
                stream.close()
            except Exception:
                pass

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

        # Give readers a moment to drain pipes
        time.sleep(0.05)

        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None:
                return
            # Cancel timeout timer
            timer = self._timeout_timers.pop(process_id, None)
            if timer is not None:
                timer.cancel()

            self._procs.pop(process_id, None)
            current = _status_value(entry.get("status"))

            # Persist log snapshot
            buf = self._logs.get(process_id)
            if buf is not None:
                stdout, stderr, total, truncated = buf.snapshot_logs()
                entry["stdout_log"] = stdout
                entry["stderr_log"] = stderr
                entry["log_total"] = total
                entry["log_truncated"] = truncated

            if current in (
                ProcessStatus.CANCELLED.value,
                ProcessStatus.TIMEOUT.value,
                ProcessStatus.ORPHANED.value,
            ):
                # Already finalized by cancel/timeout/orphan path
                if entry.get("exit_code") is None:
                    entry["exit_code"] = exit_code
                entry["updated_at"] = _now_iso()
                if not entry.get("finished_at"):
                    entry["finished_at"] = entry["updated_at"]
                self.repository.upsert(entry)
                self._done_events[process_id].set()
                # Still emit terminal for SSE if not already (timeout/cancel may have)
                terminal_entry = dict(entry)
            elif process_id in self._cancel_requested or current == ProcessStatus.CANCEL_REQUESTED.value:
                entry["status"] = ProcessStatus.CANCELLED.value
                entry["exit_code"] = exit_code if exit_code is not None else -signal.SIGTERM
                now = _now_iso()
                entry["finished_at"] = now
                entry["updated_at"] = now
                self.repository.upsert(entry)
                self._cancel_requested.discard(process_id)
                self._done_events[process_id].set()
                terminal_entry = dict(entry)
            elif exit_code == 0:
                entry["status"] = ProcessStatus.COMPLETED.value
                entry["exit_code"] = 0
                now = _now_iso()
                entry["finished_at"] = now
                entry["updated_at"] = now
                self.repository.upsert(entry)
                self._cancel_requested.discard(process_id)
                self._done_events[process_id].set()
                terminal_entry = dict(entry)
            else:
                entry["status"] = ProcessStatus.FAILED.value
                entry["exit_code"] = exit_code
                now = _now_iso()
                entry["finished_at"] = now
                entry["updated_at"] = now
                self.repository.upsert(entry)
                self._cancel_requested.discard(process_id)
                self._done_events[process_id].set()
                terminal_entry = dict(entry)

        self._emit_terminal_for(process_id, terminal_entry)

    def _on_timeout(self, process_id: str) -> None:
        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None or _is_terminal(entry.get("status")):
                return
            entry["status"] = ProcessStatus.TIMEOUT.value
            entry["updated_at"] = _now_iso()
            proc = self._procs.get(process_id)
            self.repository.upsert(entry)

        if proc is not None:
            terminate_process_group(proc, grace_seconds=1.0)

        with self._lock:
            entry = self._entries.get(process_id)
            if entry is not None and not entry.get("finished_at"):
                entry["finished_at"] = _now_iso()
                entry["exit_code"] = entry.get("exit_code")
                if entry.get("exit_code") is None:
                    entry["exit_code"] = -signal.SIGKILL
                entry["updated_at"] = entry["finished_at"]
                self.repository.upsert(entry)

    # ── Query ────────────────────────────────────────────────────────

    def get(self, process_id: str) -> dict[str, Any] | None:
        with self._lock:
            mem = self._entries.get(process_id)
            if mem is not None:
                return self._public_view(mem)
        row = self.repository.get(process_id)
        if row is None:
            return None
        with self._lock:
            self._entries.setdefault(process_id, row)
            if process_id not in self._logs:
                buf = _LogBuffer(self._max_log_chars)
                if row.get("stdout_log"):
                    buf.append("stdout", row["stdout_log"])
                if row.get("stderr_log"):
                    buf.append("stderr", row["stderr_log"])
                self._logs[process_id] = buf
            if process_id not in self._done_events:
                ev = threading.Event()
                if _is_terminal(row.get("status")):
                    ev.set()
                self._done_events[process_id] = ev
        return self._public_view(row)

    def _public_view(self, entry: dict[str, Any]) -> dict[str, Any]:
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
            "started_at": entry.get("started_at"),
            "finished_at": entry.get("finished_at"),
            "created_at": entry.get("created_at", ""),
            "updated_at": entry.get("updated_at", ""),
            "trace_id": entry.get("trace_id"),
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
        with self._lock:
            buf = self._logs.get(process_id)
            if buf is None:
                stdout = ""
                stderr = ""
                next_offset = offset
                truncated = False
            else:
                stdout, stderr, next_offset, truncated = buf.slice(offset, lim)
            completed = _is_terminal(entry.get("status"))

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
        with self._lock:
            buf2 = self._logs.get(process_id)
            log_total = buf2.total if buf2 is not None else 0
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
        with self._lock:
            done = self._done_events.get(process_id)
        if done is None:
            return entry
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
            entry = self._entries.get(process_id) or self.repository.get(process_id)
            if entry is None:
                return {"error": "not found", "status": "not_found"}
            self._entries[process_id] = entry
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
                self.repository.upsert(entry)

        return {"ok": True, "status": _status_value(entry.get("status"))}

    def signal_process(self, process_id: str, sig: str | int = "SIGTERM") -> dict[str, Any]:
        try:
            signum = _resolve_signal(sig)
        except ValueError as exc:
            return {"error": str(exc), "status": "invalid"}

        with self._lock:
            entry = self._entries.get(process_id) or self.repository.get(process_id)
            if entry is None:
                return {"error": "not found", "status": "not_found"}
            self._entries[process_id] = entry
            if _is_terminal(entry.get("status")):
                return {"error": "process is not running", "status": "terminal"}
            proc = self._procs.get(process_id)
            pid = entry.get("pid") or (proc.pid if proc else None)

        if proc is None and pid is None:
            return {"error": "no live process handle", "status": "unavailable"}

        try:
            if proc is not None:
                try:
                    os.killpg(os.getpgid(proc.pid), signum)
                except (ProcessLookupError, PermissionError, OSError):
                    proc.send_signal(signum)
            else:
                os.kill(int(pid), signum)
        except (ProcessLookupError, PermissionError, OSError) as exc:
            return {"error": f"signal failed: {exc}", "status": "failed"}

        with self._lock:
            entry["updated_at"] = _now_iso()
            # SIGTERM/SIGINT via signal API is not full cancel unless SIGKILL
            if signum == signal.SIGKILL:
                self._cancel_requested.add(process_id)
                entry["status"] = ProcessStatus.CANCEL_REQUESTED.value
            self.repository.upsert(entry)

        return {
            "ok": True,
            "status": _status_value(entry.get("status")),
            "signal": signum,
        }

    def cancel(self, process_id: str) -> bool:
        """Request cancel: SIGTERM process group, mark cancel_requested → cancelled."""
        with self._lock:
            entry = self._entries.get(process_id) or self.repository.get(process_id)
            if entry is None:
                return False
            self._entries[process_id] = entry
            status = entry.get("status")
            if _is_terminal(status) and process_id not in self._cancel_requested:
                return False
            if not _is_active(status) and process_id not in self._cancel_requested:
                return False

            self._cancel_requested.add(process_id)
            entry["status"] = ProcessStatus.CANCEL_REQUESTED.value
            entry["updated_at"] = _now_iso()
            self.repository.upsert(entry)
            proc = self._procs.get(process_id)
            timer = self._timeout_timers.pop(process_id, None)
            if timer is not None:
                timer.cancel()

        if proc is not None:
            terminate_process_group(proc, grace_seconds=2.0)

        with self._lock:
            entry = self._entries.get(process_id) or entry
            if not _is_terminal(entry.get("status")) or _status_value(
                entry.get("status")
            ) == ProcessStatus.CANCEL_REQUESTED.value:
                # If reaper already finished, ensure terminal cancelled
                if process_id not in self._procs:
                    entry["status"] = ProcessStatus.CANCELLED.value
                    if entry.get("exit_code") is None:
                        entry["exit_code"] = -signal.SIGTERM
                    entry["finished_at"] = entry.get("finished_at") or _now_iso()
                    entry["updated_at"] = _now_iso()
                    self.repository.upsert(entry)
                    done = self._done_events.get(process_id)
                    if done:
                        done.set()
                else:
                    # Still reaping — leave cancel_requested; reaper finalizes
                    pass
            return True

    def cancel_for_session(
        self,
        session_id: str,
        *,
        foreground_only: bool = False,
    ) -> list[str]:
        """Cancel processes owned by a session. Returns cancelled process_ids."""
        cancelled: list[str] = []
        with self._lock:
            candidates = [
                e
                for e in self._entries.values()
                if e.get("session_id") == session_id and _is_active(e.get("status"))
            ]
        # Also pull from DB in case entries were not in memory
        try:
            for row in self.repository.list_by_session(session_id):
                if _is_active(row.get("status")):
                    if not any(c["process_id"] == row["process_id"] for c in candidates):
                        candidates.append(row)
        except Exception:
            logger.exception("list_by_session failed during cancel")

        for entry in candidates:
            if foreground_only and entry.get("background"):
                continue
            if self.cancel(entry["process_id"]):
                cancelled.append(entry["process_id"])
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

    def cancel_for_run(self, run_id: str) -> list[str]:
        """Cancel all processes associated with an agent run."""
        cancelled: list[str] = []
        with self._lock:
            candidates = [
                e
                for e in self._entries.values()
                if e.get("run_id") == run_id and _is_active(e.get("status"))
            ]
        try:
            for row in self.repository.list_by_run(run_id):
                if _is_active(row.get("status")):
                    if not any(c["process_id"] == row["process_id"] for c in candidates):
                        candidates.append(row)
        except Exception:
            logger.exception("list_by_run failed during cancel")

        for entry in candidates:
            if self.cancel(entry["process_id"]):
                cancelled.append(entry["process_id"])
        return cancelled

    @property
    def total_count(self) -> int:
        try:
            return self.repository.total_count()
        except Exception:
            return len(self._entries)

    @property
    def orphans_marked(self) -> int:
        return self._orphans_marked


process_manager = ProcessManager()
