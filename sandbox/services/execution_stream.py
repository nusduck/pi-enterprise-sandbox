"""Execution event stream hub (B3) — persist, SSE fan-out, sequence resume.

Event types (ADR §4.3):
  execution_started | stdout_delta | stderr_delta
  execution_completed | execution_failed | execution_cancelled

Transport:
  - Durable rows in ``execution_events`` + ``execution_log_chunks``
  - In-process subscriber fan-out for live SSE
  - Optional dual-write into agent_events when ``run_id`` is set
"""

from __future__ import annotations

import json
import logging
import threading
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from sandbox.database import Database, SQLiteBackend, PostgreSQLBackend, database

logger = logging.getLogger("sandbox.execution_stream")

SOURCE_PROCESS = "process"
SOURCE_EXECUTION = "execution"

EVENT_STARTED = "execution_started"
EVENT_STDOUT_DELTA = "stdout_delta"
EVENT_STDERR_DELTA = "stderr_delta"
EVENT_COMPLETED = "execution_completed"
EVENT_FAILED = "execution_failed"
EVENT_CANCELLED = "execution_cancelled"

TERMINAL_EVENTS = frozenset({EVENT_COMPLETED, EVENT_FAILED, EVENT_CANCELLED})

# Max characters retained per source in durable chunks (hard cap for noisy procs).
_DEFAULT_MAX_DURABLE_LOG_CHARS = 2_000_000
_MAX_APPEND_RETRIES = 8

Subscriber = Callable[[dict[str, Any]], None]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _json_loads(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    try:
        data = json.loads(value)
        return data if isinstance(data, dict) else {}
    except (TypeError, json.JSONDecodeError):
        return {}


def full_log_location(source_type: str, source_id: str, *, session_id: str | None = None) -> str:
    """Canonical pull API path for full logs (used when truncated=true)."""
    if source_type == SOURCE_PROCESS:
        return f"/processes/{source_id}/logs"
    if session_id:
        return f"/sessions/{session_id}/executions/{source_id}/logs"
    return f"/executions/{source_id}/logs"


class ExecutionEventRepository:
    """Append-only sequenced events + durable log chunks per execution source."""

    def __init__(self, db: Database | None = None) -> None:
        self.db = db or database

    def append_event(
        self,
        *,
        source_type: str,
        source_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        run_id: str | None = None,
        event_id: str | None = None,
    ) -> dict[str, Any]:
        """Allocate next sequence and insert. Retries on unique conflict."""
        now = _now_iso()
        eid = event_id or f"eevt_{uuid.uuid4().hex}"
        payload_dict = dict(payload or {})
        payload_json = _json_dumps(payload_dict)
        last_error: BaseException | None = None

        for attempt in range(_MAX_APPEND_RETRIES):
            try:
                return self._append_once(
                    source_type=source_type,
                    source_id=source_id,
                    event_type=event_type,
                    payload_json=payload_json,
                    payload_dict=payload_dict,
                    run_id=run_id,
                    eid=eid,
                    now=now,
                )
            except Exception as exc:
                if not self._is_unique_violation(exc):
                    raise
                last_error = exc
                if attempt + 1 >= _MAX_APPEND_RETRIES:
                    break
        raise RuntimeError(
            f"execution event append failed after {_MAX_APPEND_RETRIES} retries "
            f"for {source_type}/{source_id}"
        ) from last_error

    def _append_once(
        self,
        *,
        source_type: str,
        source_id: str,
        event_type: str,
        payload_json: str,
        payload_dict: dict[str, Any],
        run_id: str | None,
        eid: str,
        now: str,
    ) -> dict[str, Any]:
        with self.db.connect() as conn:
            backend = conn.backend
            try:
                if isinstance(backend, SQLiteBackend):
                    conn.execute("BEGIN IMMEDIATE")
                elif isinstance(backend, PostgreSQLBackend):
                    # Advisory lock key from source identity (best-effort serialize).
                    pass

                row = conn.execute(
                    """
                    SELECT COALESCE(MAX(sequence), 0) AS max_seq
                    FROM execution_events
                    WHERE source_type = ? AND source_id = ?
                    """,
                    (source_type, source_id),
                ).fetchone()
                try:
                    max_seq = int(row["max_seq"] if row is not None else 0)
                except (KeyError, IndexError, TypeError):
                    max_seq = int(row[0]) if row is not None else 0
                sequence = max_seq + 1

                conn.execute(
                    """
                    INSERT INTO execution_events (
                        event_id, source_type, source_id, sequence,
                        event_type, payload, run_id, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        eid,
                        source_type,
                        source_id,
                        sequence,
                        event_type,
                        payload_json,
                        run_id,
                        now,
                    ),
                )
                conn.commit()
            except Exception:
                try:
                    conn.rollback()
                except Exception:
                    pass
                raise

        return {
            "event_id": eid,
            "source_type": source_type,
            "source_id": source_id,
            "sequence": sequence,
            "type": event_type,
            "payload": payload_dict,
            "run_id": run_id,
            "created_at": now,
        }

    @staticmethod
    def _is_unique_violation(exc: BaseException) -> bool:
        name = type(exc).__name__
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            return True
        # psycopg2
        pgcode = getattr(exc, "pgcode", None)
        if pgcode == "23505":
            return True
        if name in ("IntegrityError", "UniqueViolation"):
            return True
        return False

    def list_events(
        self,
        source_type: str,
        source_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        with self.db.connect() as conn:
            if limit is not None:
                rows = conn.execute(
                    """
                    SELECT * FROM execution_events
                    WHERE source_type = ? AND source_id = ? AND sequence > ?
                    ORDER BY sequence ASC
                    LIMIT ?
                    """,
                    (source_type, source_id, after_sequence, limit),
                ).fetchall()
            else:
                rows = conn.execute(
                    """
                    SELECT * FROM execution_events
                    WHERE source_type = ? AND source_id = ? AND sequence > ?
                    ORDER BY sequence ASC
                    """,
                    (source_type, source_id, after_sequence),
                ).fetchall()
        return [self._event_row(r) for r in rows if r is not None]

    def max_sequence(self, source_type: str, source_id: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT COALESCE(MAX(sequence), 0) AS max_seq
                FROM execution_events
                WHERE source_type = ? AND source_id = ?
                """,
                (source_type, source_id),
            ).fetchone()
        if row is None:
            return 0
        try:
            return int(row["max_seq"])
        except (KeyError, IndexError, TypeError):
            return int(row[0])

    def append_log_chunk(
        self,
        *,
        source_type: str,
        source_id: str,
        stream: str,
        offset_start: int,
        data: str,
    ) -> None:
        if not data:
            return
        now = _now_iso()
        with self.db.connect() as conn:
            conn.execute(
                """
                INSERT INTO execution_log_chunks (
                    source_type, source_id, stream, offset_start,
                    data, char_len, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(source_type, source_id, stream, offset_start) DO NOTHING
                """,
                (
                    source_type,
                    source_id,
                    stream,
                    int(offset_start),
                    data,
                    len(data),
                    now,
                ),
            )
            conn.commit()

    def read_logs(
        self,
        source_type: str,
        source_id: str,
        *,
        offset: int = 0,
        limit: int | None = None,
    ) -> dict[str, Any]:
        """Reconstruct interleaved stdout/stderr from durable chunks.

        Global offset is across the interleaved event order stored as
        chunk offset_start values (same coordinate system as process log buffer).
        """
        lim = limit if limit is not None else 50_000
        if offset < 0:
            offset = 0
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                SELECT stream, offset_start, data, char_len
                FROM execution_log_chunks
                WHERE source_type = ? AND source_id = ?
                ORDER BY offset_start ASC
                """,
                (source_type, source_id),
            ).fetchall()

        stdout_parts: list[str] = []
        stderr_parts: list[str] = []
        consumed = 0
        next_off = offset
        total = 0
        for row in rows:
            try:
                stream = row["stream"]
                start = int(row["offset_start"])
                data = row["data"] or ""
                char_len = int(row["char_len"] or len(data))
            except (KeyError, IndexError, TypeError):
                stream = row[0]
                start = int(row[1])
                data = row[2] or ""
                char_len = int(row[3] or len(data))
            end = start + char_len
            total = max(total, end)
            if end <= offset:
                continue
            local_start = max(0, offset - start)
            chunk = data[local_start:]
            if consumed + len(chunk) > lim:
                chunk = chunk[: lim - consumed]
            if not chunk:
                break
            if stream == "stdout":
                stdout_parts.append(chunk)
            else:
                stderr_parts.append(chunk)
            consumed += len(chunk)
            next_off = start + local_start + len(chunk)
            if consumed >= lim:
                break
        else:
            if rows:
                next_off = total

        return {
            "stdout": "".join(stdout_parts),
            "stderr": "".join(stderr_parts),
            "next_offset": next_off,
            "log_total": total,
            "truncated": False,  # caller may override from live buffer
        }

    def log_total(self, source_type: str, source_id: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                SELECT COALESCE(MAX(offset_start + char_len), 0) AS total
                FROM execution_log_chunks
                WHERE source_type = ? AND source_id = ?
                """,
                (source_type, source_id),
            ).fetchone()
        if row is None:
            return 0
        try:
            return int(row["total"])
        except (KeyError, IndexError, TypeError):
            return int(row[0] or 0)

    @staticmethod
    def _event_row(row: Any) -> dict[str, Any]:
        return {
            "event_id": row["event_id"],
            "source_type": row["source_type"],
            "source_id": row["source_id"],
            "sequence": int(row["sequence"]),
            "type": row["event_type"],
            "payload": _json_loads(row["payload"]),
            "run_id": row["run_id"],
            "created_at": row["created_at"],
        }


class ExecutionStreamHub:
    """In-process pub/sub over durable execution events."""

    def __init__(
        self,
        database: Database | None = None,
        *,
        max_durable_log_chars: int = _DEFAULT_MAX_DURABLE_LOG_CHARS,
    ) -> None:
        self.repository = ExecutionEventRepository(database)
        self._lock = threading.RLock()
        # (source_type, source_id) -> set of subscribers
        self._subs: dict[tuple[str, str], set[Subscriber]] = {}
        # Track terminal state for SSE end
        self._terminal: dict[tuple[str, str], dict[str, Any]] = {}
        # Per-source log offset counters for durable chunks
        self._log_offsets: dict[tuple[str, str], int] = {}
        self._max_durable_log_chars = max_durable_log_chars

    # ── Emit ─────────────────────────────────────────────────────────

    def emit(
        self,
        *,
        source_type: str,
        source_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        run_id: str | None = None,
    ) -> dict[str, Any]:
        """Persist execution-stream event and fan out (no agent_runs dual-write)."""
        body = dict(payload or {})
        body.setdefault("source_type", source_type)
        body.setdefault("source_id", source_id)
        if run_id:
            body.setdefault("run_id", run_id)

        entry = self.repository.append_event(
            source_type=source_type,
            source_id=source_id,
            event_type=event_type,
            payload=body,
            run_id=run_id,
        )

        # PR-13: never dual-write to legacy Sandbox agent_runs (Agent MySQL is sole
        # Run event authority). run_id may still be recorded on execution events
        # for correlation only.

        key = (source_type, source_id)
        if event_type in TERMINAL_EVENTS:
            with self._lock:
                self._terminal[key] = entry

        self._fanout(key, entry)
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
        payload: dict[str, Any] = {
            "session_id": session_id,
            "command": command,
        }
        if extra:
            payload.update(extra)
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
        """Record stdout/stderr delta. Returns event or None if empty text."""
        if not text:
            return None
        key = (source_type, source_id)
        with self._lock:
            offset = self._log_offsets.get(key, 0)
            # Cap durable log growth
            if offset >= self._max_durable_log_chars:
                # Still emit a truncated delta marker once? Skip further chunks.
                return None
            remaining = self._max_durable_log_chars - offset
            if len(text) > remaining:
                text = text[:remaining]
            self._log_offsets[key] = offset + len(text)

        if persist_chunk:
            try:
                self.repository.append_log_chunk(
                    source_type=source_type,
                    source_id=source_id,
                    stream=stream,
                    offset_start=offset,
                    data=text,
                )
            except Exception:
                logger.exception(
                    "failed to persist log chunk %s/%s@%s",
                    source_type,
                    source_id,
                    offset,
                )

        event_type = EVENT_STDOUT_DELTA if stream == "stdout" else EVENT_STDERR_DELTA
        return self.emit(
            source_type=source_type,
            source_id=source_id,
            event_type=event_type,
            payload={
                "stream": stream,
                "text": text,
                "offset": offset,
                "end_offset": offset + len(text),
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
        if status_l in ("cancelled", "cancel_requested"):
            event_type = EVENT_CANCELLED
        elif status_l in ("failed", "timeout", "orphaned", "error"):
            event_type = EVENT_FAILED
        else:
            event_type = EVENT_COMPLETED

        loc = full_log_location(source_type, source_id, session_id=session_id)
        total = log_total
        if total is None:
            total = self.repository.log_total(source_type, source_id)

        payload: dict[str, Any] = {
            "status": status,
            "exit_code": exit_code,
            "error": error,
            "truncated": bool(truncated),
            "log_total": total,
            "full_log_location": loc,
        }
        if extra:
            payload.update(extra)
        return self.emit(
            source_type=source_type,
            source_id=source_id,
            event_type=event_type,
            payload=payload,
            run_id=run_id,
        )

    # ── Query / subscribe ────────────────────────────────────────────

    def list_events(
        self,
        source_type: str,
        source_id: str,
        *,
        after_sequence: int = 0,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        return self.repository.list_events(
            source_type,
            source_id,
            after_sequence=after_sequence,
            limit=limit,
        )

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
        raw = self.repository.read_logs(
            source_type, source_id, offset=offset, limit=limit
        )
        loc = full_log_location(source_type, source_id, session_id=session_id)
        return {
            "stdout": raw["stdout"],
            "stderr": raw["stderr"],
            "next_offset": raw["next_offset"],
            "completed": completed,
            "truncated": truncated,
            "log_total": raw["log_total"],
            "full_log_location": loc if truncated else None,
        }

    def is_terminal(self, source_type: str, source_id: str) -> bool:
        key = (source_type, source_id)
        with self._lock:
            if key in self._terminal:
                return True
        # Check durable store for terminal event
        events = self.repository.list_events(
            source_type, source_id, after_sequence=0
        )
        for ev in reversed(events):
            if ev["type"] in TERMINAL_EVENTS:
                with self._lock:
                    self._terminal[key] = ev
                return True
        return False

    def subscribe(
        self,
        source_type: str,
        source_id: str,
        after_sequence: int,
        callback: Subscriber,
    ) -> Callable[[], None]:
        """Replay events with sequence > after_sequence, then live updates.

        If already terminal after replay, callback receives a sentinel
        ``{"type": "__stream_terminal__", ...}`` immediately.
        """
        key = (source_type, source_id)

        # Replay from durable store first
        for entry in self.list_events(
            source_type, source_id, after_sequence=after_sequence
        ):
            try:
                callback(entry)
            except Exception:
                logger.debug("subscriber error during replay", exc_info=True)

        terminal = self.is_terminal(source_type, source_id)
        if terminal:
            with self._lock:
                term = self._terminal.get(key)
            try:
                callback(
                    {
                        "type": "__stream_terminal__",
                        "source_type": source_type,
                        "source_id": source_id,
                        "terminal": term,
                    }
                )
            except Exception:
                pass
            return lambda: None

        with self._lock:
            self._subs.setdefault(key, set()).add(callback)

        def _unsub() -> None:
            with self._lock:
                subs = self._subs.get(key)
                if subs is not None:
                    subs.discard(callback)
                    if not subs:
                        self._subs.pop(key, None)

        # Race: terminal may have arrived between replay and subscribe
        if self.is_terminal(source_type, source_id):
            with self._lock:
                term = self._terminal.get(key)
            try:
                callback(
                    {
                        "type": "__stream_terminal__",
                        "source_type": source_type,
                        "source_id": source_id,
                        "terminal": term,
                    }
                )
            except Exception:
                pass
            _unsub()
            return lambda: None

        return _unsub

    def _fanout(self, key: tuple[str, str], entry: dict[str, Any]) -> None:
        with self._lock:
            subs = list(self._subs.get(key, ()))
        for sub in subs:
            try:
                sub(entry)
            except Exception:
                logger.debug("subscriber error", exc_info=True)

        if entry.get("type") in TERMINAL_EVENTS:
            sentinel = {
                "type": "__stream_terminal__",
                "source_type": key[0],
                "source_id": key[1],
                "terminal": entry,
            }
            for sub in subs:
                try:
                    sub(sentinel)
                except Exception:
                    pass


# Module singleton used by process/execution managers and routers.
execution_stream = ExecutionStreamHub()
