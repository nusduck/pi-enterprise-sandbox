"""Shared SSE event contract fixtures (Node / Python / frontend)."""

from __future__ import annotations

import json
from pathlib import Path

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "sse_events.json"


def test_sse_fixture_lists_required_frontend_types():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    required = set(data["required_event_types"])
    for t in (
        "token",
        "tool_start",
        "tool_end",
        "file_ready",
        "error",
        "done",
        "session",
        "approval_required",
        "trace",
        "session_closed",
    ):
        assert t in required, f"missing required event type: {t}"


def test_sse_sample_stream_uses_only_declared_types():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    allowed = set(data["required_event_types"])
    for ev in data["sample_stream"]:
        assert ev["type"] in allowed
        assert "type" in ev


def test_sse_event_shapes_cover_required_types():
    data = json.loads(FIXTURE.read_text(encoding="utf-8"))
    shapes = data["event_shapes"]
    for t in data["required_event_types"]:
        assert t in shapes
        assert shapes[t]["type"] == t
