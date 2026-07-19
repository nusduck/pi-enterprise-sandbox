from sandbox.trace import (
    TraceContext,
    format_traceparent,
    get_parent_span_id,
    get_span_id,
    get_trace_id,
    parse_traceparent,
    reset_trace_context,
    resolve_trace_context,
    set_trace_context,
)


TRACE = "0123456789abcdef0123456789abcdef"
PARENT = "0123456789abcdef"


def test_parse_traceparent_is_strict_and_canonicalizes_hex() -> None:
    parsed = parse_traceparent(f"00-{TRACE.upper()}-{PARENT.upper()}-01")
    assert parsed is not None
    assert parsed.trace_id == TRACE
    assert parsed.parent_span_id == PARENT
    assert parsed.trace_flags == "01"

    assert parse_traceparent("00-" + "0" * 32 + f"-{PARENT}-01") is None
    assert parse_traceparent(f"00-{TRACE}-" + "0" * 16 + "-01") is None
    assert parse_traceparent(f"ff-{TRACE}-{PARENT}-01") is None
    assert parse_traceparent(f"00-{TRACE}-{PARENT}-0100") is None
    assert parse_traceparent(f"00-{TRACE}-{PARENT}-01-extra") is None


def test_resolve_trace_context_preserves_parent_and_mints_child() -> None:
    context = resolve_trace_context(
        f"00-{TRACE}-{PARENT}-03",
        "ignored",
        random_bytes=lambda size: bytes(range(1, size + 1)),
    )
    assert context == TraceContext(
        trace_id=TRACE,
        span_id="0102030405060708",
        parent_span_id=PARENT,
        trace_flags="03",
    )
    assert format_traceparent(context) == f"00-{TRACE}-0102030405060708-03"


def test_resolve_trace_context_falls_back_to_valid_x_trace_id() -> None:
    context = resolve_trace_context(
        "not-a-traceparent",
        TRACE.upper(),
        random_bytes=lambda size: bytes([size]) * size,
    )
    assert context.trace_id == TRACE
    assert context.parent_span_id is None
    assert context.span_id == "0808080808080808"


def test_contextvars_expose_current_and_parent_span() -> None:
    context = TraceContext(TRACE, "a" * 16, "b" * 16, "01")
    tokens = set_trace_context(context)
    try:
        assert get_trace_id() == TRACE
        assert get_span_id() == "a" * 16
        assert get_parent_span_id() == "b" * 16
    finally:
        reset_trace_context(tokens)
    assert get_trace_id() is None
    assert get_span_id() is None
    assert get_parent_span_id() is None
