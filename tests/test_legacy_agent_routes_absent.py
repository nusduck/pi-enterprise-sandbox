"""PR-13 severe follow-up: Sandbox must not mount legacy Run/Session authority.

Canonical Agent Run API is Agent service ``/internal/agent-runs`` (MySQL).
Sandbox root ``/agent-runs`` and ``/agent-sessions`` were dual-authority surfaces
(and ``/agent-sessions`` had no ownership checks). They must be absent at runtime
and unreferenced by production bootstrap.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from sandbox.main import app

client = TestClient(app)
ROOT = Path(__file__).resolve().parents[1]
MAIN_PY = ROOT / "sandbox" / "main.py"


def test_main_py_does_not_include_legacy_agent_routers():
    src = MAIN_PY.read_text(encoding="utf-8")
    assert "include_router(agent_runs" not in src
    assert "include_router(agent_sessions" not in src
    assert "from sandbox.services.agent_run_manager" not in src
    assert "agent_run_manager.reap_expired_runs" not in src
    # Import list must not pull deleted router modules
    assert "agent_runs," not in src
    assert "agent_sessions," not in src
    # Static proof router/manager modules are gone
    assert not (ROOT / "sandbox" / "routers" / "agent_runs.py").exists()
    assert not (ROOT / "sandbox" / "routers" / "agent_sessions.py").exists()
    assert not (ROOT / "sandbox" / "services" / "agent_run_manager.py").exists()
    assert not (ROOT / "sandbox" / "services" / "agent_session_manager.py").exists()


def test_runtime_app_routes_exclude_legacy_prefixes():
    paths = {getattr(r, "path", "") for r in app.routes}
    forbidden_prefixes = (
        "/agent-runs",
        "/agent-sessions",
        "/tool-executions",
    )
    offenders = [
        p
        for p in paths
        if any(p == pref or p.startswith(pref + "/") for pref in forbidden_prefixes)
    ]
    # conversations/{id}/agent-session was on agent_sessions router
    offenders += [p for p in paths if p.endswith("/agent-session")]
    assert offenders == [], f"legacy routes still mounted: {sorted(offenders)}"


def test_http_legacy_paths_return_404():
    samples = [
        ("GET", "/agent-runs"),
        ("POST", "/agent-runs"),
        ("GET", "/agent-runs/run_x"),
        ("GET", "/agent-runs/run_x/events"),
        ("POST", "/agent-runs/run_x/events"),
        ("POST", "/tool-executions"),
        ("GET", "/tool-executions/tc_x"),
        ("GET", "/agent-sessions/as_x"),
        ("POST", "/agent-sessions"),
        ("POST", "/agent-sessions/as_x/resume"),
        ("GET", "/agent-sessions/as_x/entries"),
        ("POST", "/agent-sessions/as_x/entries"),
        ("GET", "/conversations/conv_x/agent-session"),
    ]
    for method, path in samples:
        resp = client.request(method, path)
        assert resp.status_code == 404, f"{method} {path} → {resp.status_code}"


def test_legacy_execution_stream_module_is_removed():
    assert not (ROOT / "sandbox" / "services" / "execution_stream.py").exists()
    transient = (
        ROOT / "sandbox" / "services" / "transient_execution_stream.py"
    ).read_text(encoding="utf-8")
    assert "agent_run_manager" not in transient
    assert "_dual_write_agent" not in transient
