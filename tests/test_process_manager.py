"""Tests for B2 Process Manager — start/logs/stdin/stop/orphan/cancel."""

from __future__ import annotations

import os
import shutil
import signal
import tempfile
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.database import Database
from sandbox.models import ProcessStatus
from sandbox.services.process_manager import ProcessManager, _LogBuffer


@pytest.fixture
def ws():
    tmp = Path(tempfile.mkdtemp(prefix="proc_mgr_ws_"))
    yield str(tmp)
    shutil.rmtree(str(tmp), ignore_errors=True)


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "process.db"
    database = Database(f"sqlite:///{path}")
    database.initialize()
    return database


@pytest.fixture
def mgr(db, monkeypatch):
    """Isolated ProcessManager with relaxed resource limits."""
    monkeypatch.setattr(settings, "max_process_count", 0)
    monkeypatch.setattr(settings, "max_memory_mb", 0)
    monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)
    monkeypatch.setattr(settings, "default_deny_network", True)
    return ProcessManager(database=db)


@pytest.fixture
def client(monkeypatch, tmp_path):
    """HTTP TestClient with isolated process manager + session workspace."""
    monkeypatch.setattr(settings, "max_process_count", 0)
    monkeypatch.setattr(settings, "max_memory_mb", 0)
    monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)

    from sandbox.main import app
    from sandbox.services import process_manager as pm_mod
    from sandbox.services.session_manager import session_manager

    db_path = tmp_path / "http_process.db"
    database = Database(f"sqlite:///{db_path}")
    database.initialize()
    isolated = ProcessManager(database=database)
    monkeypatch.setattr(pm_mod, "process_manager", isolated)

    # Also patch router-level import
    import sandbox.routers.processes as proc_router
    import sandbox.routers.executions as exec_router

    monkeypatch.setattr(proc_router, "process_manager", isolated)
    monkeypatch.setattr(exec_router, "process_manager", isolated, raising=False)

    with TestClient(app) as c:
        # Create a live session
        resp = c.post("/sessions", json={"caller_id": "test-process"})
        assert resp.status_code in (200, 201), resp.text
        session = resp.json()
        yield c, session["session_id"], isolated


class TestLogBuffer:
    def test_interleaved_offset_slice(self):
        buf = _LogBuffer(max_chars=10_000)
        buf.append("stdout", "hello ")
        buf.append("stderr", "err1 ")
        buf.append("stdout", "world")
        out, err, next_off, trunc = buf.slice(0, 100)
        assert "hello" in out
        assert "world" in out
        assert "err1" in err
        assert next_off == buf.total
        assert trunc is False

        # Incremental: skip first 6 chars of combined ("hello ")
        out2, err2, next2, _ = buf.slice(6, 100)
        assert out2 == "world"
        assert err2 == "err1 "
        assert next2 == buf.total

    def test_truncation_drops_oldest(self):
        buf = _LogBuffer(max_chars=20)
        buf.append("stdout", "abcdefghijklmnopqrstuvwxyz")  # 26 chars
        assert buf.truncated is True
        assert len(buf.stdout) <= 20


class TestProcessManager:
    def test_start_and_complete(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s1",
            command='echo "hello-process"',
            workspace_path=ws,
        )
        assert start["status"] == ProcessStatus.RUNNING.value
        pid = start["process_id"]
        assert pid.startswith("proc_")

        final = mgr.wait(pid, timeout=10)
        assert final is not None
        assert final["status"] == ProcessStatus.COMPLETED.value
        assert final["exit_code"] == 0

        logs = mgr.logs(pid, offset=0)
        assert logs is not None
        assert "hello-process" in logs["stdout"]
        assert logs["completed"] is True

    def test_start_long_running_and_cancel(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s2",
            command="python3 -c \"import time; print('ready', flush=True); time.sleep(60)\"",
            workspace_path=ws,
        )
        process_id = start["process_id"]

        # Wait until we see ready in logs
        deadline = time.time() + 5
        saw_ready = False
        while time.time() < deadline:
            logs = mgr.logs(process_id, offset=0)
            if logs and "ready" in logs["stdout"]:
                saw_ready = True
                break
            time.sleep(0.05)
        assert saw_ready, "process never printed ready"

        status = mgr.get(process_id)
        assert status["status"] == ProcessStatus.RUNNING.value
        child_pid = status["pid"]
        assert child_pid

        ok = mgr.cancel(process_id)
        assert ok is True

        final = mgr.wait(process_id, timeout=10)
        assert final["status"] in (
            ProcessStatus.CANCELLED.value,
            ProcessStatus.CANCEL_REQUESTED.value,
        )
        # settle
        time.sleep(0.2)
        final = mgr.get(process_id)
        assert final["status"] == ProcessStatus.CANCELLED.value

        # OS process must be gone
        try:
            os.kill(child_pid, 0)
            alive = True
        except OSError:
            alive = False
        assert alive is False, f"pid {child_pid} still alive after cancel"

    def test_process_logs_offset(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s3",
            command="python3 -c \"print('AAAA', flush=True); print('BBBB', flush=True)\"",
            workspace_path=ws,
        )
        pid = start["process_id"]
        mgr.wait(pid, timeout=10)

        first = mgr.logs(pid, offset=0, limit=5)
        assert first["stdout"] or first["stderr"] or first["next_offset"] >= 0
        second = mgr.logs(pid, offset=first["next_offset"])
        assert second["completed"] is True

    def test_write_stdin(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s4",
            command="python3 -c \"import sys; line=sys.stdin.readline(); print('got:'+line.strip(), flush=True)\"",
            workspace_path=ws,
            timeout=15,
        )
        process_id = start["process_id"]
        time.sleep(0.3)
        result = mgr.write_stdin(process_id, "ping\n", eof=True)
        assert result.get("ok") is True

        final = mgr.wait(process_id, timeout=10)
        assert final["status"] == ProcessStatus.COMPLETED.value
        logs = mgr.logs(process_id, offset=0)
        assert "got:ping" in logs["stdout"]

    def test_signal_sigterm(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s5",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
        )
        process_id = start["process_id"]
        time.sleep(0.3)
        r = mgr.signal_process(process_id, "SIGTERM")
        assert r.get("ok") is True
        final = mgr.wait(process_id, timeout=10)
        assert final["status"] in (
            ProcessStatus.COMPLETED.value,
            ProcessStatus.FAILED.value,
            ProcessStatus.CANCELLED.value,
        )

    def test_timeout_state(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s6",
            command="python3 -c \"import time; time.sleep(30)\"",
            workspace_path=ws,
            timeout=1,
        )
        process_id = start["process_id"]
        final = mgr.wait(process_id, timeout=10)
        assert final["status"] == ProcessStatus.TIMEOUT.value

    def test_orphan_detection_on_restart(self, db, ws: str, monkeypatch):
        monkeypatch.setattr(settings, "max_process_count", 0)
        monkeypatch.setattr(settings, "max_memory_mb", 0)
        monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)

        mgr1 = ProcessManager(database=db)
        start = mgr1.start(
            session_id="s7",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
        )
        process_id = start["process_id"]
        time.sleep(0.3)
        # Force-persist as still running without killing (simulate crash)
        entry = mgr1.get(process_id)
        assert entry["status"] == ProcessStatus.RUNNING.value

        # Simulate runner restart: new manager sees active row without live handle
        # First, stop the real process to avoid leaking
        mgr1.cancel(process_id)
        mgr1.wait(process_id, timeout=5)

        # Manually re-write status to running in DB (as if crash mid-run)
        from sandbox.repositories import ProcessRepository

        repo = ProcessRepository(db)
        row = repo.get(process_id)
        assert row is not None
        row["status"] = ProcessStatus.RUNNING.value
        row["finished_at"] = None
        repo.upsert(row)

        mgr2 = ProcessManager(database=db)
        assert mgr2.orphans_marked >= 1
        orphaned = mgr2.get(process_id)
        assert orphaned["status"] == ProcessStatus.ORPHANED.value

    def test_cancel_for_session_cascade(self, mgr: ProcessManager, ws: str):
        p1 = mgr.start(
            session_id="sess_cascade",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
        )
        p2 = mgr.start(
            session_id="sess_cascade",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
        )
        time.sleep(0.3)
        cancelled = mgr.cancel_for_session("sess_cascade")
        assert p1["process_id"] in cancelled
        assert p2["process_id"] in cancelled
        for pid in (p1["process_id"], p2["process_id"]):
            final = mgr.wait(pid, timeout=10)
            assert final["status"] == ProcessStatus.CANCELLED.value

    def test_cancel_for_run(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s8",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            run_id="run_abc",
        )
        time.sleep(0.2)
        cancelled = mgr.cancel_for_run("run_abc")
        assert start["process_id"] in cancelled
        final = mgr.wait(start["process_id"], timeout=10)
        assert final["status"] == ProcessStatus.CANCELLED.value

    def test_network_blocked(self, mgr: ProcessManager, ws: str):
        result = mgr.start(
            session_id="s9",
            command="curl https://example.com",
            workspace_path=ws,
        )
        assert result.get("status") == "blocked"

    def test_persistence(self, mgr: ProcessManager, ws: str, db):
        start = mgr.start(
            session_id="s10",
            command='echo "persist-me"',
            workspace_path=ws,
        )
        mgr.wait(start["process_id"], timeout=10)
        from sandbox.repositories import ProcessRepository

        row = ProcessRepository(db).get(start["process_id"])
        assert row is not None
        assert row["status"] == ProcessStatus.COMPLETED.value
        assert "persist-me" in (row.get("stdout_log") or "")


class TestProcessHTTP:
    def test_http_start_logs_cancel(self, client):
        c, session_id, _mgr = client
        resp = c.post(
            "/processes",
            json={
                "session_id": session_id,
                "command": "python3 -c \"import time; print('srv', flush=True); time.sleep(60)\"",
            },
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        process_id = body["process_id"]
        assert body["status"] == "running"

        # Poll logs until ready
        deadline = time.time() + 5
        while time.time() < deadline:
            logs = c.get(f"/processes/{process_id}/logs").json()
            if "srv" in logs.get("stdout", ""):
                break
            time.sleep(0.05)

        status = c.get(f"/processes/{process_id}").json()
        assert status["status"] == "running"

        cancel = c.post(f"/processes/{process_id}/cancel")
        assert cancel.status_code == 200
        assert cancel.json()["status"] in ("cancelled", "cancel_requested")

    def test_http_stdin(self, client):
        c, session_id, _mgr = client
        resp = c.post(
            "/processes",
            json={
                "session_id": session_id,
                "command": (
                    "python3 -c \"import sys; print('got:'+sys.stdin.readline().strip(), flush=True)\""
                ),
                "timeout": 15,
            },
        )
        assert resp.status_code == 201, resp.text
        process_id = resp.json()["process_id"]
        time.sleep(0.3)
        wr = c.post(
            f"/processes/{process_id}/stdin",
            json={"data": "hi\n", "eof": True},
        )
        assert wr.status_code == 200, wr.text
        waited = c.post(f"/processes/{process_id}/wait", json={"timeout": 10})
        assert waited.status_code == 200
        assert waited.json()["status"] == "completed"
        logs = c.get(f"/processes/{process_id}/logs").json()
        assert "got:hi" in logs["stdout"]

    def test_cancel_active_stops_processes(self, client):
        c, session_id, mgr = client
        # HTTP start so workspace is session-bound
        resp = c.post(
            "/processes",
            json={
                "session_id": session_id,
                "command": "python3 -c \"import time; time.sleep(60)\"",
            },
        )
        assert resp.status_code == 201
        process_id = resp.json()["process_id"]
        time.sleep(0.3)

        cancel_resp = c.post(f"/sessions/{session_id}/executions/cancel-active")
        assert cancel_resp.status_code == 200
        body = cancel_resp.json()
        assert process_id in body.get("processes_cancelled", []) or body.get("cancelled")

        final = mgr.wait(process_id, timeout=10)
        assert final["status"] == ProcessStatus.CANCELLED.value
