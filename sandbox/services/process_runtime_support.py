"""Pure process-runtime validation, status, signal, and log-buffer helpers."""

from __future__ import annotations

import re
import signal
import threading
from datetime import datetime, timezone
from typing import Any

from sandbox.config import settings
from sandbox.models import (
    PROCESS_ACTIVE_STATUSES,
    PROCESS_TERMINAL_STATUSES,
)

DEFAULT_MAX_LOG_CHARS = 500_000
DEFAULT_WAIT_SECONDS = 3600.0
_MAX_OWNER_USER_ID_LEN = 128
_OWNER_USER_ID_RE = re.compile(r"^[A-Za-z0-9_.:@\-]{1,128}$")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def status_value(status: Any) -> str:
    if hasattr(status, "value"):
        return str(status.value)
    return str(status)


_TERMINAL_VALUES = frozenset(status_value(status) for status in PROCESS_TERMINAL_STATUSES)
_ACTIVE_VALUES = frozenset(status_value(status) for status in PROCESS_ACTIVE_STATUSES)


def is_terminal(status: Any) -> bool:
    return status in PROCESS_TERMINAL_STATUSES or status_value(status) in _TERMINAL_VALUES


def is_active(status: Any) -> bool:
    return status in PROCESS_ACTIVE_STATUSES or status_value(status) in _ACTIVE_VALUES


def positive_int(value: Any, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed > 0 else default


def resolve_process_timeout(timeout: int | None) -> tuple[int | None, str | None]:
    """Resolve client timeout to a finite positive wall-clock duration."""
    default = positive_int(
        getattr(settings, "process_timeout_seconds", None),
        14_400,
    )
    absolute_max = positive_int(
        getattr(settings, "max_process_timeout_seconds", None),
        86_400,
    )
    default = min(default, absolute_max)

    if timeout is None:
        return default, None
    try:
        requested = int(timeout)
    except (TypeError, ValueError):
        return None, "timeout must be a positive integer (seconds)"
    if requested <= 0:
        return None, (
            "timeout must be > 0; omit the field to use the server default "
            f"({default}s). Unlimited processes are not allowed."
        )
    if requested > absolute_max:
        return None, (
            f"timeout {requested}s exceeds absolute maximum ({absolute_max}s)"
        )
    return requested, None


def normalize_authoritative_user_id(raw: Any) -> str | None:
    """Return a bounded path-safe owner id from trusted session identity."""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or len(text) > _MAX_OWNER_USER_ID_LEN:
        return None
    return text if _OWNER_USER_ID_RE.fullmatch(text) else None


class LogBuffer:
    """Interleaved stdout/stderr buffer with offset-based slice reads."""

    def __init__(self, max_chars: int = DEFAULT_MAX_LOG_CHARS) -> None:
        self._lock = threading.Lock()
        self.max_chars = max_chars
        self.stdout = ""
        self.stderr = ""
        self._events: list[tuple[int, str, str]] = []
        self.total = 0
        self.truncated = False
        self._buffer_start = 0

    def append(self, stream: str, text: str) -> None:
        if not text:
            return
        with self._lock:
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
        if self.total - self._buffer_start <= self.max_chars:
            return
        self.truncated = True
        target_start = self.total - self.max_chars
        drop_index = 0
        for index, (start, stream, text) in enumerate(self._events):
            if start + len(text) <= target_start:
                drop_index = index + 1
                continue
            keep_from = target_start - start
            if 0 < keep_from < len(text):
                self._events[index] = (target_start, stream, text[keep_from:])
            drop_index = index
            break
        if drop_index:
            self._events = self._events[drop_index:]
        self._buffer_start = self._events[0][0] if self._events else self.total
        self.stdout = "".join(
            text for _, stream, text in self._events if stream == "stdout"
        )
        self.stderr = "".join(
            text for _, stream, text in self._events if stream == "stderr"
        )

    def slice(self, offset: int, limit: int) -> tuple[str, str, int, bool]:
        with self._lock:
            offset = max(0, offset)
            if limit <= 0:
                limit = self.max_chars
            truncated = self.truncated or offset < self._buffer_start
            effective_offset = max(offset, self._buffer_start)
            stdout_parts: list[str] = []
            stderr_parts: list[str] = []
            consumed = 0
            next_offset = effective_offset
            for start, stream, text in self._events:
                if start + len(text) <= effective_offset:
                    continue
                local_start = max(0, effective_offset - start)
                chunk = text[local_start : local_start + limit - consumed]
                if not chunk:
                    break
                (stdout_parts if stream == "stdout" else stderr_parts).append(chunk)
                consumed += len(chunk)
                next_offset = start + local_start + len(chunk)
                if consumed >= limit:
                    break
            else:
                next_offset = self.total
            return (
                "".join(stdout_parts),
                "".join(stderr_parts),
                next_offset,
                truncated,
            )

    def snapshot_logs(self) -> tuple[str, str, int, bool]:
        with self._lock:
            return self.stdout, self.stderr, self.total, self.truncated


_SIGNALS: dict[str, int] = {
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


def resolve_signal(value: str | int) -> int:
    if isinstance(value, int):
        return value
    raw = str(value or "SIGTERM").strip().upper()
    if raw in _SIGNALS:
        return _SIGNALS[raw]
    if raw.isdigit():
        return int(raw)
    signal_name = raw if raw.startswith("SIG") else f"SIG{raw}"
    if signal_name in _SIGNALS:
        return _SIGNALS[signal_name]
    raise ValueError(f"Unknown signal: {value}")
