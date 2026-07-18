"""Monotonic process stream cursors (plan §13.7 / PR-08).

Cursor format: ``{generation}-{byte_offset}``

Semantics (UTF-8 **byte** cursors):
- *generation* increments when retained prefix is dropped (rotation).
- *byte_offset* is a monotonic index into the stream's absolute byte history
  (``total`` / ``dropped_through`` / read ``limit`` are all byte counts).
- Reads never return a string that is illegal UTF-8: if a limit or start
  would split a multi-byte code point, the boundary advances/retreats to the
  nearest complete character (documented below).
- Oversized single appends still advance ``total`` by the **full** original
  byte length; only the tail is retained; ``dropped_through`` reflects the
  lost prefix so cursors can detect drop.
- ``append`` / ``read`` are internally locked for concurrent safety.
"""

from __future__ import annotations

import re
import threading
from dataclasses import dataclass
from typing import Any

_CURSOR_RE = re.compile(r"^(\d+)-(\d+)$")
INITIAL_CURSOR = "0-0"


@dataclass(frozen=True, slots=True)
class StreamCursor:
    generation: int
    offset: int

    def encode(self) -> str:
        return f"{int(self.generation)}-{int(self.offset)}"


def parse_cursor(raw: str | None) -> StreamCursor:
    """Parse a cursor; invalid / empty → generation 0 offset 0 (start).

    Oversized or non-matching strings raise ValueError (API maps to 400).
    """
    if raw is None or raw == "":
        return StreamCursor(0, 0)
    text = str(raw).strip()
    if len(text) > 64:
        raise ValueError("cursor too long")
    m = _CURSOR_RE.fullmatch(text)
    if not m:
        raise ValueError("cursor must be generation-offset (e.g. 0-0)")
    gen = int(m.group(1))
    off = int(m.group(2))
    if gen < 0 or off < 0:
        raise ValueError("cursor values must be non-negative")
    return StreamCursor(gen, off)


def encode_cursor(generation: int, offset: int) -> str:
    return StreamCursor(int(generation), int(offset)).encode()


def _utf8_char_start(data: bytes, index: int) -> int:
    """Advance *index* forward to a UTF-8 character start (or len).

    If *index* is mid-sequence, skip continuation bytes until a lead byte
    or end. Indices past len clamp to len.
    """
    n = len(data)
    if index <= 0:
        return 0
    if index >= n:
        return n
    i = index
    # Continuation bytes have top bits 10xxxxxx.
    while i < n and (data[i] & 0xC0) == 0x80:
        i += 1
    return i


def _utf8_safe_end(data: bytes, end: int) -> int:
    """Retreat *end* so ``data[:end]`` is valid UTF-8 (complete code points).

    Does not drop whole characters unless the cut lands inside one.
    """
    n = len(data)
    if end <= 0:
        return 0
    if end >= n:
        return n
    # If end is mid-sequence, walk back to the lead byte of that sequence.
    i = end
    while i > 0 and (data[i] & 0xC0) == 0x80:
        i -= 1
    if i < end:
        # i is a lead (or ASCII). Exclude the incomplete sequence.
        return i
    return end


def _utf8_codepoint_len(data: bytes, start: int) -> int:
    """Byte length of the UTF-8 code point starting at *start* (1–4), or 0."""
    n = len(data)
    if start < 0 or start >= n:
        return 0
    b0 = data[start]
    if b0 < 0x80:
        return 1
    if (b0 & 0xE0) == 0xC0:
        need = 2
    elif (b0 & 0xF0) == 0xE0:
        need = 3
    elif (b0 & 0xF8) == 0xF0:
        need = 4
    else:
        # Invalid lead / unexpected continuation — skip one byte to make progress.
        return 1
    if start + need > n:
        return 0  # incomplete at end of buffer
    # Validate continuation bytes.
    for j in range(1, need):
        if (data[start + j] & 0xC0) != 0x80:
            return 1
    return need


def _utf8_tail_within(data: bytes, max_bytes: int) -> tuple[bytes, int]:
    """Keep a valid UTF-8 tail of at most *max_bytes* bytes.

    Returns ``(tail_bytes, drop_prefix_bytes)`` where
    ``drop_prefix_bytes + len(tail_bytes) == len(data)`` when the tail starts
    on a character boundary after the drop point (may drop slightly more than
    ``len(data) - max_bytes`` to avoid splitting a code point).
    """
    if max_bytes <= 0:
        return b"", len(data)
    if len(data) <= max_bytes:
        return data, 0
    start = len(data) - max_bytes
    start = _utf8_char_start(data, start)
    tail = data[start:]
    # If still over budget (shouldn't after char-start), trim further.
    if len(tail) > max_bytes:
        end = _utf8_safe_end(tail, max_bytes)
        # Prefer keeping a complete suffix: recompute from the end.
        start2 = len(data) - end
        start2 = _utf8_char_start(data, start2)
        tail = data[start2:]
        start = start2
    return tail, start


class StreamLogBuffer:
    """Per-stream ring buffer with generation-aware UTF-8 **byte** cursors.

    Internal ``threading.RLock`` protects concurrent ``append`` / ``read``.
    """

    def __init__(self, max_chars: int = 500_000) -> None:
        # max_chars name retained for callers; unit is **bytes**.
        self.max_bytes = max(1, int(max_chars))
        # Alias for older tests/callers.
        self.max_chars = self.max_bytes
        self.generation = 0
        self.total = 0  # absolute bytes ever appended (monotonic, full length)
        self.dropped_through = 0  # absolute byte offset of first retained byte
        self._chunks: list[tuple[int, bytes]] = []  # (abs_start, data)
        self.truncated = False
        self._lock = threading.RLock()

    def append(self, text: str | bytes) -> None:
        if text is None:
            return
        if isinstance(text, str):
            raw = text.encode("utf-8")
        else:
            raw = bytes(text)
        if not raw:
            return

        with self._lock:
            original_len = len(raw)
            start = self.total
            # Always count the full original payload into absolute total first.
            self.total += original_len

            if original_len > self.max_bytes:
                self.truncated = True
                tail, drop_in_chunk = _utf8_tail_within(raw, self.max_bytes)
                # Absolute start of retained tail inside this append.
                abs_tail_start = start + drop_in_chunk
                # Drop everything before abs_tail_start (including prior chunks).
                self._chunks = [(abs_tail_start, tail)] if tail else []
                if abs_tail_start > self.dropped_through:
                    self.dropped_through = abs_tail_start
                    self.generation += 1
                # Ensure retained window ≤ max_bytes (single tail already is).
                self._trim_locked()
                return

            self._chunks.append((start, raw))
            self._trim_locked()

    def _trim_locked(self) -> None:
        retained = self.total - self.dropped_through
        if retained <= self.max_bytes:
            return
        self.truncated = True
        target = self.total - self.max_bytes
        # Align target to a UTF-8 boundary inside the chunk that contains it.
        new_chunks: list[tuple[int, bytes]] = []
        gen_bump = False
        for abs_start, data in self._chunks:
            end = abs_start + len(data)
            if end <= target:
                gen_bump = True
                continue
            if abs_start < target:
                local = target - abs_start
                local = _utf8_char_start(data, local)
                # If char-start advanced past end, drop whole chunk.
                if local >= len(data):
                    gen_bump = True
                    continue
                new_start = abs_start + local
                new_chunks.append((new_start, data[local:]))
                target = new_start  # actual dropped_through may be > naive target
                gen_bump = True
            else:
                new_chunks.append((abs_start, data))
        self._chunks = new_chunks
        if new_chunks:
            self.dropped_through = max(self.dropped_through, new_chunks[0][0])
        else:
            self.dropped_through = max(self.dropped_through, target)
        # If still over budget after UTF-8 alignment, drop more from the left.
        while self._chunks and (self.total - self.dropped_through) > self.max_bytes:
            abs_start, data = self._chunks[0]
            need = (self.total - self.dropped_through) - self.max_bytes
            if need >= len(data):
                self._chunks.pop(0)
                self.dropped_through = abs_start + len(data)
                gen_bump = True
                continue
            local = _utf8_char_start(data, need)
            if local >= len(data):
                self._chunks.pop(0)
                self.dropped_through = abs_start + len(data)
                gen_bump = True
                continue
            self._chunks[0] = (abs_start + local, data[local:])
            self.dropped_through = abs_start + local
            gen_bump = True
            break
        if gen_bump:
            self.generation += 1

    def snapshot_text(self) -> str:
        with self._lock:
            return b"".join(d for _s, d in self._chunks).decode("utf-8", errors="replace")

    def read(
        self,
        cursor: StreamCursor | str | None,
        *,
        limit: int,
    ) -> dict[str, Any]:
        """Return incremental slice for *cursor*.

        Boundary / advance semantics (must not infinite-loop clients):
        - Offsets are UTF-8 **bytes**; ``data`` is always valid Unicode.
        - Mid-code-point cursor advances forward to the next char start.
        - **At-least-one code point:** if the next complete character needs
          more than ``limit`` bytes (e.g. limit=1 and next is a 3-byte CJK
          char), return that one character anyway (overrun ≤ 3 bytes).
          This guarantees ``next_cursor > cursor`` whenever unread data
          remains, so consumers cannot spin on empty progress.
        - Same cursor + limit is idempotent while generation is unchanged
          and the window has not rotated past the offset.
        - ``next_cursor`` is always a complete-character absolute offset
          (or ``total`` at EOF) and is monotonic for sequential reads.

        Response keys: data, cursor, next_cursor, truncated, generation,
        log_total, dropped.
        """
        if isinstance(cursor, StreamCursor):
            cur = cursor
        else:
            cur = parse_cursor(cursor if cursor is not None else INITIAL_CURSOR)

        lim = max(1, int(limit))

        with self._lock:
            dropped = (
                cur.offset < self.dropped_through
                or cur.generation < self.generation
            )
            if cur.generation > self.generation:
                return {
                    "data": "",
                    "cursor": cur.encode(),
                    "next_cursor": encode_cursor(self.generation, self.total),
                    "truncated": True,
                    "generation": self.generation,
                    "log_total": self.total,
                    "dropped": True,
                }

            if cur.generation < self.generation or cur.offset < self.dropped_through:
                start = self.dropped_through
                truncated = True
            else:
                start = max(cur.offset, self.dropped_through)
                truncated = self.truncated and cur.offset < self.dropped_through

            # Materialize retained window for boundary math (bounded by max_bytes).
            if not self._chunks:
                return {
                    "data": "",
                    "cursor": cur.encode(),
                    "next_cursor": encode_cursor(self.generation, self.total),
                    "truncated": truncated or self.truncated,
                    "generation": self.generation,
                    "log_total": self.total,
                    "dropped": dropped,
                }

            window_start = self._chunks[0][0]
            window = b"".join(d for _s, d in self._chunks)
            # Relative offsets into window.
            rel_start = max(0, start - window_start)
            if rel_start >= len(window):
                return {
                    "data": "",
                    "cursor": cur.encode(),
                    "next_cursor": encode_cursor(self.generation, self.total),
                    "truncated": truncated or self.truncated,
                    "generation": self.generation,
                    "log_total": self.total,
                    "dropped": dropped,
                }
            # Advance mid-code-point start.
            rel_start = _utf8_char_start(window, rel_start)
            if rel_start >= len(window):
                return {
                    "data": "",
                    "cursor": cur.encode(),
                    "next_cursor": encode_cursor(self.generation, self.total),
                    "truncated": truncated or self.truncated,
                    "generation": self.generation,
                    "log_total": self.total,
                    "dropped": dropped,
                }

            rel_end_cap = min(len(window), rel_start + lim)
            rel_end = _utf8_safe_end(window, rel_end_cap)
            if rel_end < rel_start:
                rel_end = rel_start

            # At-least-one code point: avoid empty progress when limit is smaller
            # than the next character (limit=1 + CJK would otherwise stall).
            if rel_end == rel_start:
                cp_len = _utf8_codepoint_len(window, rel_start)
                if cp_len > 0 and rel_start + cp_len <= len(window):
                    # Overrun at most 3 bytes past requested limit (UTF-8 max 4).
                    rel_end = rel_start + cp_len
                elif rel_start < len(window):
                    # Incomplete trailing fragment: do not invent data; stay put
                    # only if truly no complete code point remains in window.
                    rel_end = rel_start

            chunk = window[rel_start:rel_end]
            abs_next = window_start + rel_end
            if abs_next > self.total:
                abs_next = self.total
            # Clamp to stream tip when at end of retained window content.
            window_end_abs = window_start + len(window)
            if abs_next >= window_end_abs and window_end_abs >= self.total:
                abs_next = self.total

            # Boundary helpers guarantee a complete UTF-8 sequence.
            data = chunk.decode("utf-8")

            return {
                "data": data,
                "cursor": cur.encode(),
                "next_cursor": encode_cursor(self.generation, abs_next),
                "truncated": truncated or self.truncated,
                "generation": self.generation,
                "log_total": self.total,
                "dropped": dropped,
            }

    def initial_cursor(self) -> str:
        with self._lock:
            return encode_cursor(self.generation, 0)
