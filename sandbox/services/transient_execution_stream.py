"""Bounded process-local execution events for the formal Sandbox runtime.

MySQL remains the authority for tool and process outcomes.  This hub exists
only to fan out output produced by the current Sandbox process; it is not a
restart-recovery store and it never opens a database connection.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

SOURCE_PROCESS = "process"
SOURCE_EXECUTION = "execution"

EVENT_STARTED = "execution_started"
EVENT_STDOUT_DELTA = "stdout_delta"
EVENT_STDERR_DELTA = "stderr_delta"
EVENT_COMPLETED = "execution_completed"
EVENT_FAILED = "execution_failed"
EVENT_CANCELLED = "execution_cancelled"

TERMINAL_EVENTS = frozenset({EVENT_COMPLETED, EVENT_FAILED, EVENT_CANCELLED})


def full_log_location(
    source_type: str,
    source_id: str,
    *,
    session_id: str | None = None,
) -> str:
    if source_type == SOURCE_PROCESS:
        return f"/processes/{source_id}/logs"
    if session_id:
        return f"/sessions/{session_id}/executions/{source_id}/logs"
    return f"/executions/{source_id}/logs"


class TransientExecutionStreamHub:
    """Bounded live fan-out; deliberately not a persistence backend."""

    def __init__(
        self,
        *,
        max_log_chars: int = 2_000_000,
        max_events_per_source: int = 2_000,
    ) -> None:
        self._lock = threading.RLock()
        self._events: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self._logs: dict[tuple[str, str], list[tuple[str, int, str]]] = {}
        self._log_offsets: dict[tuple[str, str], int] = {}
        self._subscribers: dict[
            tuple[str, str], set[Callable[[dict[str, Any]], None]]
        ] = {}
        self._terminal: dict[tuple[str, str], dict[str, Any]] = {}
        self._max_log_chars = max(1, int(max_log_chars))
        self._max_events_per_source = max(1, int(max_events_per_source))

    def emit(
        self,
        *,
        source_type: str,
        source_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        key = (source_type, source_id)
        body = dict(payload or {})
        body.setdefault("source_type", source_type)
        body.setdefault("source_id", source_id)
        if run_id:
            body.setdefault("run_id", run_id)
        with self._lock:
            events = self._events.setdefault(key, [])
            entry = {
                "event_id": f"live_{uuid.uuid4().hex}",
                "source_type": source_type,
                "source_id": source_id,
                "sequence": (events[-1]["sequence"] + 1) if events else 1,
                "type": event_type,
                "payload": body,
                "run_id": run_id,
                "created_at": datetime.now(timezone.utc).isoformat(),
            }
            events.append(entry)
            if len(events) > self._max_events_per_source:
                del events[: len(events) - self._max_events_per_source]
            if event_type in TERMINAL_EVENTS:
                self._terminal[key] = entry
            subscribers = tuple(self._subscribers.get(key, ()))
        self._fanout(key, entry, subscribers)
        return entry

    def emit_started(
        self,
        *,
        source_type: str,
        source_id: str,
        session_id: str | None = None,
        command: str | None = None,
        run_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = {"session_id": session_id, "command": command}
        payload.update(extra or {})
        return self.emit(
            source_type=source_type,
            source_id=source_id,
            event_type=EVENT_STARTED,
            payload=payload,
            run_id=run_id,
        )

    def emit_delta(
        self,
        *,
        source_type: str,
        source_id: str,
        stream: str,
        text: str,
        run_id: str | None = None,
        persist_chunk: bool = True,
    ) -> dict[str, Any] | None:
        del persist_chunk
        if not text:
            return None
        key = (source_type, source_id)
        with self._lock:
            offset = self._log_offsets.get(key, 0)
            remaining = self._max_log_chars - offset
            if remaining <= 0:
                return None
            chunk = text[:remaining]
            self._logs.setdefault(key, []).append((stream, offset, chunk))
            self._log_offsets[key] = offset + len(chunk)
        return self.emit(
            source_type=source_type,
            source_id=source_id,
            event_type=(
                EVENT_STDOUT_DELTA if stream == "stdout" else EVENT_STDERR_DELTA
            ),
            payload={
                "stream": stream,
                "text": chunk,
                "offset": offset,
                "end_offset": offset + len(chunk),
            },
            run_id=run_id,
        )

    def emit_terminal(
        self,
        *,
        source_type: str,
        source_id: str,
        status: str,
        exit_code: int | None = None,
        error: str | None = None,
        truncated: bool = False,
        log_total: int | None = None,
        session_id: str | None = None,
        run_id: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        status_l = (status or "").lower()
        event_type = (
            EVENT_CANCELLED
            if status_l in {"cancelled", "cancel_requested"}
            else EVENT_FAILED
            if status_l in {"failed", "timeout", "orphaned", "error"}
            else EVENT_COMPLETED
        )
        key = (source_type, source_id)
        with self._lock:
            total = self._log_offsets.get(key, 0) if log_total is None else log_total
        payload = {
            "status": status,
            "exit_code": exit_code,
            "error": error,
            "truncated": bool(truncated),
            "log_total": total,
            "full_log_location": full_log_location(
                source_type, source_id, session_id=session_id
            ),
        }
        payload.update(extra or {})
        return self.emit(
            source_type=source_type,
            source_id=source_id,
            event_type=event_type,
            payload=payload,
            run_id=run_id,
        )

    def list_events(
        self,
        source_type: str,
        source_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        with self._lock:
            result = [
                dict(event)
                for event in self._events.get((source_type, source_id), ())
                if int(event["sequence"]) > int(after_sequence)
            ]
        return result if limit is None else result[: max(0, int(limit))]

    def get_logs(
        self,
        source_type: str,
        source_id: str,
        *,
        offset: int = 0,
        limit: int | None = None,
        completed: bool = False,
        truncated: bool = False,
        session_id: str | None = None,
    ) -> dict[str, Any]:
        start = max(0, int(offset))
        remaining = max(0, int(limit if limit is not None else 50_000))
        stdout: list[str] = []
        stderr: list[str] = []
        next_offset = start
        key = (source_type, source_id)
        with self._lock:
            chunks = tuple(self._logs.get(key, ()))
            total = self._log_offsets.get(key, 0)
        for stream, chunk_start, text in chunks:
            chunk_end = chunk_start + len(text)
            if chunk_end <= start or remaining <= 0:
                continue
            local_start = max(0, start - chunk_start)
            selected = text[local_start : local_start + remaining]
            (stdout if stream == "stdout" else stderr).append(selected)
            remaining -= len(selected)
            next_offset = chunk_start + local_start + len(selected)
        return {
            "stdout": "".join(stdout),
            "stderr": "".join(stderr),
            "next_offset": next_offset if chunks else start,
            "completed": completed,
            "truncated": truncated,
            "log_total": total,
            "full_log_location": (
                full_log_location(source_type, source_id, session_id=session_id)
                if truncated
                else None
            ),
        }

    def subscribe(
        self,
        source_type: str,
        source_id: str,
        after_sequence: int,
        callback: Callable[[dict[str, Any]], None],
    ) -> Callable[[], None]:
        key = (source_type, source_id)
        for event in self.list_events(
            source_type, source_id, after_sequence=after_sequence
        ):
            callback(event)
        with self._lock:
            terminal = self._terminal.get(key)
            if terminal is None:
                self._subscribers.setdefault(key, set()).add(callback)
        if terminal is not None:
            callback(self._terminal_sentinel(key, terminal))
            return lambda: None

        def unsubscribe() -> None:
            with self._lock:
                subscribers = self._subscribers.get(key)
                if subscribers is None:
                    return
                subscribers.discard(callback)
                if not subscribers:
                    self._subscribers.pop(key, None)

        return unsubscribe

    def _fanout(
        self,
        key: tuple[str, str],
        entry: dict[str, Any],
        subscribers: tuple[Callable[[dict[str, Any]], None], ...],
    ) -> None:
        for callback in subscribers:
            try:
                callback(entry)
                if entry["type"] in TERMINAL_EVENTS:
                    callback(self._terminal_sentinel(key, entry))
            except Exception:
                continue
        if entry["type"] in TERMINAL_EVENTS:
            with self._lock:
                self._subscribers.pop(key, None)

    @staticmethod
    def _terminal_sentinel(
        key: tuple[str, str], entry: dict[str, Any]
    ) -> dict[str, Any]:
        return {
            "type": "__stream_terminal__",
            "source_type": key[0],
            "source_id": key[1],
            "terminal": entry,
        }


transient_execution_stream = TransientExecutionStreamHub()


__all__ = [
    "SOURCE_EXECUTION",
    "SOURCE_PROCESS",
    "TERMINAL_EVENTS",
    "TransientExecutionStreamHub",
    "full_log_location",
    "transient_execution_stream",
]
