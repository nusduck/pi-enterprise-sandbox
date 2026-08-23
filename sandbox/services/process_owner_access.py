"""Owner-scoped read and control facade over the live process registry.

Split out of ``process_manager`` so the lifecycle machinery (spawn, reap,
quota, isolation) stays separable from the question these methods all answer:
may *this* tenant see or touch *this* process, and what is the honest answer
when the row outlived its live handle.

Every method starts from :meth:`get_owned`, which checks the formal ledger and
the in-memory entry against org, user and SandboxSession before anything is
read or signalled. Not-yours and not-there are deliberately the same answer.
"""

from __future__ import annotations

from typing import Any

from sandbox.services.process_cursor import (
    INITIAL_CURSOR,
    encode_cursor,
    parse_cursor,
)
from sandbox.services.process_runtime_support import is_terminal as _is_terminal


class OwnerScopedProcessAccess:
    """Mixin half of :class:`~sandbox.services.process_manager.ProcessManager`."""

    def get_owned(
        self,
        process_id: str,
        *,
        org_id: str,
        user_id: str,
        sandbox_session_id: str,
    ) -> dict[str, Any] | None:
        """Read only after formal owner and SandboxSession scope validation."""
        formal = self._formal.get_owned(
            process_id,
            org_id=org_id,
            user_id=user_id,
            sandbox_session_id=sandbox_session_id,
        )
        if formal is None:
            return None
        with self._lock:
            entry = self._entries.get(process_id)
            if entry is not None:
                if (
                    entry.get("org_id") != org_id
                    or entry.get("user_id") != user_id
                    or entry.get("sandbox_session_id") != sandbox_session_id
                ):
                    return None
                return self._public_view(entry)
        command_json = formal.command_json if isinstance(formal.command_json, dict) else {}
        return {
            "process_id": formal.process_id,
            "session_id": formal.sandbox_session_id,
            "run_id": formal.run_id,
            "command": str(command_json.get("command") or ""),
            "status": formal.status,
            "pid": formal.pid,
            "exit_code": formal.exit_code,
            "background": bool(command_json.get("background")),
            "cwd": command_json.get("cwd"),
            "error": None,
            "timeout_seconds": command_json.get("timeout_seconds"),
            "started_at": formal.started_at,
            "finished_at": formal.ended_at,
            "created_at": formal.created_at,
            "updated_at": formal.ended_at or formal.started_at or formal.created_at,
            "trace_id": None,
            "stdout_cursor": INITIAL_CURSOR,
            "stderr_cursor": INITIAL_CURSOR,
            "elapsed_seconds": None,
        }

    def read_stream_owned(
        self,
        process_id: str,
        *,
        org_id: str,
        user_id: str,
        sandbox_session_id: str,
        stream: str,
        cursor: str,
        limit: int,
    ) -> dict[str, Any] | None:
        owned = self.get_owned(
            process_id,
            org_id=org_id,
            user_id=user_id,
            sandbox_session_id=sandbox_session_id,
        )
        if owned is None:
            return None
        with self._lock:
            live = process_id in self._entries
        if live:
            return self.read_stream(
                process_id, stream=stream, cursor=cursor, limit=limit
            )
        # Formal schema keeps process metadata, not inline log bodies.  After a
        # restart/eviction return an explicit bounded empty/truncated slice.
        try:
            parsed = parse_cursor(cursor)
        except ValueError as exc:
            return {"process_id": process_id, "stream": stream, "error": str(exc), "status": "invalid"}
        normalized = encode_cursor(parsed.generation, parsed.offset)
        return {
            "process_id": process_id,
            "stream": stream,
            "cursor": normalized,
            "next_cursor": normalized,
            "data": "",
            "truncated": True,
            "completed": _is_terminal(owned.get("status")),
            "status": owned.get("status"),
            "dropped": True,
            "log_total": 0,
        }

    def signal_process_owned(
        self,
        process_id: str,
        sig: str | int,
        *,
        org_id: str,
        user_id: str,
        sandbox_session_id: str,
    ) -> dict[str, Any]:
        owned = self.get_owned(
            process_id,
            org_id=org_id,
            user_id=user_id,
            sandbox_session_id=sandbox_session_id,
        )
        if owned is None:
            return {"error": "not found", "status": "not_found", "ok": False}
        with self._lock:
            if process_id not in self._entries:
                # No live Popen/start identity is available after restart. Never
                # signal a PID using processId/formal metadata alone.
                return {"error": "process control unavailable", "status": "unavailable", "ok": False, "signaled": False}
        return self.signal_process(process_id, sig)

    def logs_owned(
        self,
        process_id: str,
        *,
        org_id: str,
        user_id: str,
        sandbox_session_id: str,
        offset: int = 0,
        limit: int | None = None,
    ) -> dict[str, Any] | None:
        """Buffered log slice, gated on the same ownership check as get_owned."""
        owned = self.get_owned(
            process_id,
            org_id=org_id,
            user_id=user_id,
            sandbox_session_id=sandbox_session_id,
        )
        if owned is None:
            return None
        logs = self.logs(process_id, offset=offset, limit=limit)
        if logs is not None:
            return logs
        # Known to the formal ledger but no longer in memory (restart/eviction):
        # an empty completed slice, never a 404 that would read as "not yours".
        return {
            "stdout": "",
            "stderr": "",
            "next_offset": offset,
            "completed": _is_terminal(owned.get("status")),
            "truncated": True,
            "full_log_location": None,
            "log_total": 0,
        }

    def write_stdin_owned(
        self,
        process_id: str,
        data: str,
        *,
        org_id: str,
        user_id: str,
        sandbox_session_id: str,
        eof: bool = False,
    ) -> dict[str, Any]:
        owned = self.get_owned(
            process_id,
            org_id=org_id,
            user_id=user_id,
            sandbox_session_id=sandbox_session_id,
        )
        if owned is None:
            return {"error": "not found", "status": "not_found", "ok": False}
        with self._lock:
            if process_id not in self._entries:
                # No live handle after a restart: writing to a rebuilt pid would
                # be writing to whatever now owns it.
                return {
                    "error": "process control unavailable",
                    "status": "unavailable",
                    "ok": False,
                }
        return self.write_stdin(process_id, data, eof=eof)

    def cancel_owned(
        self,
        process_id: str,
        *,
        org_id: str,
        user_id: str,
        sandbox_session_id: str,
    ) -> dict[str, Any]:
        owned = self.get_owned(
            process_id,
            org_id=org_id,
            user_id=user_id,
            sandbox_session_id=sandbox_session_id,
        )
        if owned is None:
            return {"error": "not found", "status": "not_found", "ok": False}
        if _is_terminal(owned.get("status")):
            # Idempotent: cancelling a finished process is not an error.
            return {"ok": True, "cancelled": True, "status": owned.get("status")}
        with self._lock:
            if process_id not in self._entries:
                return {
                    "error": "process control unavailable",
                    "status": "unavailable",
                    "ok": False,
                }
        cancelled = self.cancel(process_id)
        current = self.get(process_id) or owned
        return {
            "ok": bool(cancelled),
            "cancelled": bool(cancelled),
            "status": current.get("status"),
        }
