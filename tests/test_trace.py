"""Trace ID propagation tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from sandbox.main import app

client = TestClient(app)


def test_trace_id_header_is_echoed_and_attached_to_execution_and_audit():
    trace_id = "trace_test_001"
    session = client.post("/sessions", json={"caller_id": "trace-test"}).json()
    sid = session["session_id"]

    resp = client.post(
        f"/sessions/{sid}/executions/command",
        json={"command": "echo traced"},
        headers={"X-Trace-Id": trace_id},
    )

    assert resp.status_code == 201
    assert resp.headers["X-Trace-Id"] == trace_id
    execution = resp.json()
    assert execution["trace_id"] == trace_id

    traces = client.get(f"/traces/{trace_id}").json()
    assert traces["trace_id"] == trace_id
    assert any(e["execution_id"] == execution["execution_id"] for e in traces["executions"])
    assert any(a["event_type"] == "execution" for a in traces["audit_logs"])


def test_trace_id_is_generated_when_missing():
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.headers.get("X-Trace-Id")
