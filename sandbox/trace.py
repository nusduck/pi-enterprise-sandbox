"""Per-request W3C trace context helpers."""

from __future__ import annotations

import os
import re
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Callable, NamedTuple

_current_trace_id: ContextVar[str | None] = ContextVar("trace_id", default=None)
_current_span_id: ContextVar[str | None] = ContextVar("span_id", default=None)
_parent_span_id: ContextVar[str | None] = ContextVar("parent_span_id", default=None)
_trace_flags: ContextVar[str] = ContextVar("trace_flags", default="01")

_TRACE_ID_RE = re.compile(r"^[0-9a-fA-F]{32}$")
_SPAN_ID_RE = re.compile(r"^[0-9a-fA-F]{16}$")
_VERSION_RE = re.compile(r"^[0-9a-fA-F]{2}$")
_FLAGS_RE = re.compile(r"^[0-9a-fA-F]{2}$")


@dataclass(frozen=True, slots=True)
class ParsedTraceparent:
    trace_id: str
    parent_span_id: str
    trace_flags: str


@dataclass(frozen=True, slots=True)
class TraceContext:
    trace_id: str
    span_id: str
    parent_span_id: str | None
    trace_flags: str


class TraceContextTokens(NamedTuple):
    trace_id: object
    span_id: object
    parent_span_id: object
    trace_flags: object


def normalize_trace_id(value: object) -> str | None:
    """Return one canonical non-zero W3C trace id, otherwise ``None``."""
    if type(value) is not str:
        return None
    trace_id = value.strip().lower()
    if not _TRACE_ID_RE.fullmatch(trace_id) or trace_id == "0" * 32:
        return None
    return trace_id


def parse_traceparent(value: object) -> ParsedTraceparent | None:
    """Strictly parse the four-field W3C traceparent form used by this service."""
    if type(value) is not str:
        return None
    parts = value.strip().split("-")
    if len(parts) != 4:
        return None
    version, raw_trace_id, raw_parent_span_id, raw_flags = parts
    if not _VERSION_RE.fullmatch(version) or version.lower() == "ff":
        return None
    trace_id = normalize_trace_id(raw_trace_id)
    parent_span_id = raw_parent_span_id.lower()
    if (
        trace_id is None
        or not _SPAN_ID_RE.fullmatch(parent_span_id)
        or parent_span_id == "0" * 16
        or not _FLAGS_RE.fullmatch(raw_flags)
    ):
        return None
    return ParsedTraceparent(
        trace_id=trace_id,
        parent_span_id=parent_span_id,
        trace_flags=raw_flags.lower(),
    )


def _new_nonzero_hex(
    size: int, random_bytes: Callable[[int], bytes]
) -> str:
    for _ in range(2):
        raw = random_bytes(size)
        if type(raw) is not bytes or len(raw) != size:
            raise ValueError("trace random source returned invalid bytes")
        value = raw.hex()
        if value != "0" * (size * 2):
            return value
    raise ValueError("trace random source returned an all-zero identifier")


def resolve_trace_context(
    traceparent: object,
    x_trace_id: object,
    *,
    random_bytes: Callable[[int], bytes] = os.urandom,
) -> TraceContext:
    """Resolve an incoming parent and mint this Sandbox request's child span."""
    parsed = parse_traceparent(traceparent)
    if parsed is not None:
        trace_id = parsed.trace_id
        parent_span_id = parsed.parent_span_id
        trace_flags = parsed.trace_flags
    else:
        trace_id = normalize_trace_id(x_trace_id)
        parent_span_id = None
        trace_flags = "01"
        if trace_id is None:
            trace_id = _new_nonzero_hex(16, random_bytes)

    return TraceContext(
        trace_id=trace_id,
        span_id=_new_nonzero_hex(8, random_bytes),
        parent_span_id=parent_span_id,
        trace_flags=trace_flags,
    )


def format_traceparent(context: TraceContext) -> str:
    """Serialize this service's current span as a version-00 traceparent."""
    return (
        f"00-{context.trace_id}-{context.span_id}-{context.trace_flags}"
    )


def set_trace_context(context: TraceContext) -> TraceContextTokens:
    return TraceContextTokens(
        _current_trace_id.set(context.trace_id),
        _current_span_id.set(context.span_id),
        _parent_span_id.set(context.parent_span_id),
        _trace_flags.set(context.trace_flags),
    )


def reset_trace_context(tokens: TraceContextTokens) -> None:
    _trace_flags.reset(tokens.trace_flags)
    _parent_span_id.reset(tokens.parent_span_id)
    _current_span_id.reset(tokens.span_id)
    _current_trace_id.reset(tokens.trace_id)


def set_trace_id(trace_id: str | None):
    return _current_trace_id.set(trace_id)


def reset_trace_id(token) -> None:
    _current_trace_id.reset(token)


def get_trace_id() -> str | None:
    return _current_trace_id.get()


def get_span_id() -> str | None:
    return _current_span_id.get()


def get_parent_span_id() -> str | None:
    return _parent_span_id.get()


def get_trace_flags() -> str:
    return _trace_flags.get()
