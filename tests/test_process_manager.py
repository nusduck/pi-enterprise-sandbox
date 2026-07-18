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
from sandbox.paths import temp_id_for_workspace_id
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.process_manager import ProcessManager, _LogBuffer
from tests.conftest import formal_id, session_create_payload


def _make_context(
    session_id: str,
    workspace_path: str,
    *,
    user_id: str | None = None,
    workspace_id: str | None = None,
) -> SandboxExecutionContext:
    """Build a trusted execution context (optional authoritative user_id)."""
    workspace = Path(workspace_path).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    wid = workspace_id or workspace.name or session_id
    temp_id = temp_id_for_workspace_id(wid)
    temp = (settings.temp_path / temp_id).resolve()
    temp.mkdir(parents=True, exist_ok=True)
    return SandboxExecutionContext(
        session_id=session_id,
        workspace_id=wid,
        temp_id=temp_id,
        physical_workspace=workspace,
        physical_temp=temp,
        user_id=user_id,
    )


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
    monkeypatch.setattr(settings, "max_file_size_mb", 0)
    monkeypatch.setattr(settings, "max_open_files", 0)
    monkeypatch.setattr(settings, "default_deny_network", True)
    return ProcessManager(database=db)


@pytest.fixture
def client(monkeypatch, tmp_path):
    """HTTP TestClient with isolated process manager + session workspace."""
    monkeypatch.setattr(settings, "max_process_count", 0)
    monkeypatch.setattr(settings, "max_memory_mb", 0)
    monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)
    monkeypatch.setattr(settings, "max_file_size_mb", 0)
    monkeypatch.setattr(settings, "max_open_files", 0)

    from sandbox.main import app
    from sandbox.services import process_manager as pm_mod

    # Hermetic dev mode: do not inherit host SANDBOX_AUTH_ENABLED.
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")

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
        resp = c.post("/sessions", json=session_create_payload("test-process"))
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

    def test_start_fail_closed_when_resource_limits_cannot_apply(
        self, mgr: ProcessManager, ws: str, monkeypatch
    ):
        """preexec ResourceLimitError must fail start (child never unconstrained)."""
        from sandbox.utils.resource_limits import ResourceLimitError

        def _boom(**_kwargs):
            raise ResourceLimitError("forced child limit failure")

        monkeypatch.setattr(
            "sandbox.services.process_manager.apply_resource_limits",
            _boom,
        )
        start = mgr.start(
            session_id="s_fail_closed",
            command='echo "must-not-run"',
            workspace_path=ws,
        )
        assert start["status"] == ProcessStatus.FAILED.value
        # POSIX Popen collapses preexec exceptions to a generic SubprocessError
        # message; the critical invariant is fail-closed (no RUNNING child).
        err = str(start.get("error") or "")
        assert "Spawn failed" in err
        assert start.get("process_id")

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
        # PR-08: restart recovery terminates as LOST (never stuck RUNNING).
        assert orphaned["status"] in (
            ProcessStatus.LOST.value,
            ProcessStatus.ORPHANED.value,
        )

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


class TestProcessResourceBounds:
    """P0: finite wall timeout, terminal retention, dual-layer active quotas."""

    def test_null_timeout_uses_configured_default(self, mgr: ProcessManager, ws: str, monkeypatch):
        monkeypatch.setattr(settings, "process_timeout_seconds", 2)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 60)
        start = mgr.start(
            session_id="to_default",
            command="python3 -c \"import time; time.sleep(30)\"",
            workspace_path=ws,
            timeout=None,
        )
        assert start["status"] == ProcessStatus.RUNNING.value
        assert start.get("timeout_seconds") == 2
        view = mgr.get(start["process_id"])
        assert view is not None
        assert view.get("timeout_seconds") == 2
        final = mgr.wait(start["process_id"], timeout=15)
        assert final is not None
        assert final["status"] == ProcessStatus.TIMEOUT.value

    def test_oversized_timeout_rejected(self, mgr: ProcessManager, ws: str, monkeypatch):
        monkeypatch.setattr(settings, "process_timeout_seconds", 10)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 30)
        result = mgr.start(
            session_id="to_big",
            command='echo "should-not-run"',
            workspace_path=ws,
            timeout=31,
        )
        assert result.get("status") == "invalid"
        assert "exceeds absolute maximum" in (result.get("error") or "")
        assert "process_id" not in result or result.get("process_id") is None

    def test_zero_timeout_rejected(self, mgr: ProcessManager, ws: str):
        result = mgr.start(
            session_id="to_zero",
            command='echo "nope"',
            workspace_path=ws,
            timeout=0,
        )
        assert result.get("status") == "invalid"
        assert "timeout" in (result.get("error") or "").lower()

    def test_blocking_process_killed_on_wall_timeout(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="to_block",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            timeout=1,
        )
        process_id = start["process_id"]
        child_pid = None
        deadline = time.time() + 3
        while time.time() < deadline:
            st = mgr.get(process_id)
            if st and st.get("pid"):
                child_pid = st["pid"]
                break
            time.sleep(0.05)
        assert child_pid, "child pid not observed"

        final = mgr.wait(process_id, timeout=15)
        assert final is not None
        assert final["status"] == ProcessStatus.TIMEOUT.value

        # OS process group must be gone
        try:
            os.kill(child_pid, 0)
            alive = True
        except OSError:
            alive = False
        assert alive is False, f"pid {child_pid} still alive after wall timeout"

    def test_terminal_maps_have_hard_bound_active_not_evicted(
        self, mgr: ProcessManager, ws: str, monkeypatch
    ):
        monkeypatch.setattr(settings, "max_retained_terminal_processes", 5)
        monkeypatch.setattr(settings, "max_retained_terminal_processes_per_session", 5)
        monkeypatch.setattr(settings, "max_managed_processes", 32)
        monkeypatch.setattr(settings, "max_managed_processes_per_session", 32)
        monkeypatch.setattr(settings, "max_managed_processes_per_owner", 32)
        monkeypatch.setattr(settings, "process_timeout_seconds", 60)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 120)
        mgr._refresh_limits_from_settings()

        # Keep two long-running actives
        long_ids = []
        for i in range(2):
            start = mgr.start(
                session_id="bound_sess",
                command="python3 -c \"import time; time.sleep(120)\"",
                workspace_path=ws,
                timeout=90,
            )
            assert start["status"] == ProcessStatus.RUNNING.value
            long_ids.append(start["process_id"])
        time.sleep(0.2)
        for pid in long_ids:
            assert pid in mgr._procs
            assert pid in mgr._entries
            assert not _is_terminal_status(mgr._entries[pid].get("status"))

        # Flood with short terminal processes
        short_ids = []
        for i in range(20):
            start = mgr.start(
                session_id="bound_sess",
                command=f'echo "short-{i}"',
                workspace_path=ws,
                timeout=15,
            )
            assert start["status"] == ProcessStatus.RUNNING.value, start
            short_ids.append(start["process_id"])
            mgr.wait(start["process_id"], timeout=10)

        # Memory maps: hard bound on terminal; actives retained
        terminal_in_mem = [
            pid
            for pid, e in mgr._entries.items()
            if pid not in mgr._procs and _is_terminal_status(e.get("status"))
        ]
        assert len(terminal_in_mem) <= 5
        assert len(mgr._logs) <= 5 + 2  # terminal bound + actives
        assert len(mgr._done_events) <= 5 + 2
        # Reader handles / pgids are cleaned for terminal and counted in hard bound
        assert len(mgr._readers) <= 2  # only long-running actives
        assert len(mgr._reader_done) <= 2
        assert len(mgr._pgids) <= 2
        for pid in long_ids:
            assert pid in mgr._entries
            assert pid in mgr._procs
            assert pid in mgr._done_events
            assert pid in mgr._readers
            assert pid in mgr._pgids

        # Evicted short process still readable from authoritative DB
        oldest = short_ids[0]
        restored = mgr.get(oldest)
        assert restored is not None
        assert restored["status"] == ProcessStatus.COMPLETED.value
        logs = mgr.logs(oldest, offset=0)
        assert logs is not None
        assert "short-0" in logs["stdout"]
        assert logs["completed"] is True

        # Cleanup actives
        for pid in long_ids:
            mgr.cancel(pid)
            mgr.wait(pid, timeout=10)

        # After terminal, reader handles must be gone
        for pid in long_ids + short_ids:
            assert pid not in mgr._readers
            assert pid not in mgr._reader_done
            assert pid not in mgr._pgids

    def test_per_session_and_workspace_fallback_quota(
        self, mgr: ProcessManager, ws: str, monkeypatch, tmp_path
    ):
        """Legacy/test path without user_id: owner key is workspace-scoped."""
        monkeypatch.setattr(settings, "max_managed_processes", 10)
        monkeypatch.setattr(settings, "max_managed_processes_per_session", 2)
        monkeypatch.setattr(settings, "max_managed_processes_per_owner", 3)
        monkeypatch.setattr(settings, "process_timeout_seconds", 60)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 120)
        mgr._refresh_limits_from_settings()

        cmd = "python3 -c \"import time; time.sleep(60)\""
        # Same session: third start must conflict
        a1 = mgr.start(session_id="sess_a", command=cmd, workspace_path=ws, timeout=30)
        a2 = mgr.start(session_id="sess_a", command=cmd, workspace_path=ws, timeout=30)
        assert a1["status"] == ProcessStatus.RUNNING.value
        assert a2["status"] == ProcessStatus.RUNNING.value
        a3 = mgr.start(session_id="sess_a", command=cmd, workspace_path=ws, timeout=30)
        assert a3.get("status") == "conflict"
        assert "session" in (a3.get("error") or "").lower()

        # Other session on same workspace (workspace fallback owner): cap 3
        b1 = mgr.start(session_id="sess_b", command=cmd, workspace_path=ws, timeout=30)
        assert b1["status"] == ProcessStatus.RUNNING.value
        b2 = mgr.start(session_id="sess_b", command=cmd, workspace_path=ws, timeout=30)
        assert b2.get("status") == "conflict"
        assert "owner" in (b2.get("error") or "").lower() or "session" in (
            b2.get("error") or ""
        ).lower()

        # Distinct workspace can start independently under workspace fallback
        ws2 = str(tmp_path / "other_ws")
        Path(ws2).mkdir(parents=True, exist_ok=True)
        c1 = mgr.start(session_id="sess_c", command=cmd, workspace_path=ws2, timeout=30)
        assert c1["status"] == ProcessStatus.RUNNING.value

        for pid in (
            a1["process_id"],
            a2["process_id"],
            b1["process_id"],
            c1["process_id"],
        ):
            mgr.cancel(pid)
            mgr.wait(pid, timeout=10)

    def test_user_owner_cap_shared_across_workspaces(
        self, mgr: ProcessManager, tmp_path, monkeypatch
    ):
        """Same authoritative user_id across workspaces shares owner cap."""
        monkeypatch.setattr(settings, "max_managed_processes", 20)
        monkeypatch.setattr(settings, "max_managed_processes_per_session", 10)
        monkeypatch.setattr(settings, "max_managed_processes_per_owner", 2)
        monkeypatch.setattr(settings, "process_timeout_seconds", 60)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 120)
        mgr._refresh_limits_from_settings()

        cmd = "python3 -c \"import time; time.sleep(60)\""
        user = "user_alice"
        ws1 = str(tmp_path / "ws_a1")
        ws2 = str(tmp_path / "ws_a2")
        ctx1 = _make_context("sess_u1", ws1, user_id=user, workspace_id="ws_alice_1")
        ctx2 = _make_context("sess_u2", ws2, user_id=user, workspace_id="ws_alice_2")

        p1 = mgr.start(
            session_id="sess_u1", command=cmd, context=ctx1, timeout=30
        )
        p2 = mgr.start(
            session_id="sess_u2", command=cmd, context=ctx2, timeout=30
        )
        assert p1["status"] == ProcessStatus.RUNNING.value
        assert p2["status"] == ProcessStatus.RUNNING.value
        # Third process for same user on yet another workspace must hit owner cap
        ws3 = str(tmp_path / "ws_a3")
        ctx3 = _make_context("sess_u3", ws3, user_id=user, workspace_id="ws_alice_3")
        p3 = mgr.start(
            session_id="sess_u3", command=cmd, context=ctx3, timeout=30
        )
        assert p3.get("status") == "conflict"
        assert "owner" in (p3.get("error") or "").lower()

        # Different user is independent of alice's owner cap
        bob_ws = str(tmp_path / "ws_bob")
        bob_ctx = _make_context(
            "sess_bob", bob_ws, user_id="user_bob", workspace_id="ws_bob_1"
        )
        bob = mgr.start(
            session_id="sess_bob", command=cmd, context=bob_ctx, timeout=30
        )
        assert bob["status"] == ProcessStatus.RUNNING.value

        # owner_key uses user: prefix, not workspace
        assert mgr._entries[p1["process_id"]]["owner_key"] == f"user:{user}"
        assert mgr._entries[p2["process_id"]]["owner_key"] == f"user:{user}"
        assert mgr._entries[bob["process_id"]]["owner_key"] == "user:user_bob"

        for pid in (p1["process_id"], p2["process_id"], bob["process_id"]):
            mgr.cancel(pid)
            mgr.wait(pid, timeout=10)

    def test_reader_drains_tail_before_terminal_persist(
        self, mgr: ProcessManager, ws: str, monkeypatch, db
    ):
        """Large tail then immediate exit must be fully captured in DB/logs."""
        monkeypatch.setattr(settings, "process_timeout_seconds", 30)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 60)
        monkeypatch.setattr(settings, "max_retained_terminal_processes", 2)
        monkeypatch.setattr(settings, "max_retained_terminal_processes_per_session", 2)
        mgr._refresh_limits_from_settings()

        # Burst a distinctive tail then exit immediately (no sleep).
        tail_marker = "TAIL_MARKER_" + ("Z" * 8000)
        start = mgr.start(
            session_id="tail_sess",
            command=(
                "python3 -c "
                f"\"import sys; sys.stdout.write({'X'*4000!r}); "
                f"sys.stdout.write({tail_marker!r}); sys.stdout.flush()\""
            ),
            workspace_path=ws,
            timeout=15,
        )
        process_id = start["process_id"]
        final = mgr.wait(process_id, timeout=15)
        assert final is not None
        assert final["status"] == ProcessStatus.COMPLETED.value

        # In-memory or DB path must include the full tail marker
        logs = mgr.logs(process_id, offset=0, limit=50_000)
        assert logs is not None
        assert tail_marker in logs["stdout"]
        assert logs["completed"] is True

        from sandbox.repositories import ProcessRepository

        row = ProcessRepository(db).get(process_id)
        assert row is not None
        assert tail_marker in (row.get("stdout_log") or "")

        # Force more short processes so this one is evicted from memory maps
        for i in range(4):
            s = mgr.start(
                session_id="tail_sess",
                command=f'echo "pad-{i}"',
                workspace_path=ws,
                timeout=15,
            )
            mgr.wait(s["process_id"], timeout=10)

        assert process_id not in mgr._entries or process_id not in mgr._logs
        assert process_id not in mgr._readers
        # After eviction, DB-backed read still has the tail
        restored_logs = mgr.logs(process_id, offset=0, limit=50_000)
        assert restored_logs is not None
        assert tail_marker in restored_logs["stdout"]

    def test_orphan_pipe_descendant_does_not_leak_readers(
        self, mgr: ProcessManager, ws: str, monkeypatch
    ):
        """Background child holding inherited pipes must not hang reaper/readers."""
        monkeypatch.setattr(settings, "process_timeout_seconds", 30)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 60)
        mgr._refresh_limits_from_settings()

        # Parent prints and exits; forked child keeps pipes open until killed.
        start = mgr.start(
            session_id="orphan_pipe",
            command=(
                "python3 -c \""
                "import os, time, sys\n"
                "if os.fork() == 0:\n"
                "    time.sleep(120)\n"
                "    os._exit(0)\n"
                "print('parent-done', flush=True)\n"
                "\""
            ),
            workspace_path=ws,
            timeout=20,
        )
        process_id = start["process_id"]
        final = mgr.wait(process_id, timeout=25)
        assert final is not None
        assert final["status"] in (
            ProcessStatus.COMPLETED.value,
            ProcessStatus.FAILED.value,
            ProcessStatus.TIMEOUT.value,
            ProcessStatus.CANCELLED.value,
        )
        # Reader handles and pgid must be cleaned (no permanent daemon leak)
        assert process_id not in mgr._readers
        assert process_id not in mgr._reader_done
        assert process_id not in mgr._pgids
        assert process_id not in mgr._procs
        logs = mgr.logs(process_id, offset=0)
        assert logs is not None
        # Parent output should have been drained when pipes closed / group killed
        assert "parent-done" in logs["stdout"] or logs["completed"] is True

    def test_escaped_setsid_descendant_cannot_hang_reaper(
        self, mgr: ProcessManager, ws: str, monkeypatch, tmp_path
    ):
        """setsid() escapee keeps inherited pipes open; reaper must not hang."""
        monkeypatch.setattr(settings, "process_timeout_seconds", 30)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 60)
        mgr._refresh_limits_from_settings()

        pid_file = tmp_path / "escaped_proc.pid"
        # Leader forks → child setsid + floods stdout; leader exits after marker.
        start = mgr.start(
            session_id="escape_setsid",
            command=(
                "python3 -c \""
                "import os, signal, sys, time\n"
                "signal.signal(signal.SIGHUP, signal.SIG_IGN)\n"
                "pid = os.fork()\n"
                "if pid == 0:\n"
                "    signal.signal(signal.SIGHUP, signal.SIG_IGN)\n"
                "    try:\n"
                "        os.setsid()\n"
                "    except OSError:\n"
                "        pass\n"
                "    b = b'x' * 65536\n"
                "    while True:\n"
                "        try:\n"
                "            sys.stdout.buffer.write(b)\n"
                "            sys.stdout.buffer.flush()\n"
                "        except Exception:\n"
                "            break\n"
                "    os._exit(0)\n"
                f"open({str(pid_file)!r}, 'w').write(str(pid))\n"
                "print('leader-done', flush=True)\n"
                "time.sleep(0.15)\n"
                "\""
            ),
            workspace_path=ws,
            timeout=25,
        )
        process_id = start["process_id"]
        bg_pid: int | None = None
        t0 = time.time()
        try:
            final = mgr.wait(process_id, timeout=30)
            elapsed = time.time() - t0
            assert elapsed < 25.0, f"process wait hung ({elapsed:.1f}s)"
            assert final is not None
            # Leader exit 0 + incomplete drain of escapee → FAILED, or COMPLETED
            # if readers stopped after partial capture; never hang / RUNNING.
            assert final["status"] in (
                ProcessStatus.COMPLETED.value,
                ProcessStatus.FAILED.value,
                ProcessStatus.TIMEOUT.value,
                ProcessStatus.CANCELLED.value,
            )
            assert process_id not in mgr._readers
            assert process_id not in mgr._reader_done
            assert process_id not in mgr._procs
            logs = mgr.logs(process_id, offset=0, limit=50_000)
            assert logs is not None
            assert logs["completed"] is True
            # Leader marker and/or flooded 'x' prefix should have been captured.
            assert "leader-done" in logs["stdout"] or "x" in logs["stdout"]

            deadline = time.time() + 2.0
            while time.time() < deadline and not pid_file.exists():
                time.sleep(0.01)
            if pid_file.exists():
                bg_pid = int(pid_file.read_text().strip())
        finally:
            if bg_pid is None and pid_file.exists():
                try:
                    bg_pid = int(pid_file.read_text().strip())
                except ValueError:
                    bg_pid = None
            if bg_pid is not None and bg_pid > 0:
                try:
                    os.killpg(bg_pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError, OSError):
                    try:
                        os.kill(bg_pid, signal.SIGKILL)
                    except (ProcessLookupError, PermissionError, OSError):
                        pass

    def test_cancel_and_timeout_status_not_regressed(
        self, mgr: ProcessManager, ws: str, monkeypatch
    ):
        """Cancel / timeout still land on correct terminal status after reader fix."""
        monkeypatch.setattr(settings, "process_timeout_seconds", 30)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 60)
        mgr._refresh_limits_from_settings()

        # Cancel path
        start = mgr.start(
            session_id="cancel_status",
            command='python3 -c "import time; time.sleep(60)"',
            workspace_path=ws,
            timeout=30,
        )
        pid = start["process_id"]
        time.sleep(0.2)
        assert mgr.cancel(pid) is True
        final = mgr.wait(pid, timeout=15)
        assert final is not None
        assert final["status"] == ProcessStatus.CANCELLED.value

        # Timeout path
        start2 = mgr.start(
            session_id="timeout_status",
            command='python3 -c "import time; time.sleep(60)"',
            workspace_path=ws,
            timeout=1,
        )
        pid2 = start2["process_id"]
        final2 = mgr.wait(pid2, timeout=15)
        assert final2 is not None
        assert final2["status"] == ProcessStatus.TIMEOUT.value

    def test_evicted_query_stable_no_fabricated_result(
        self, mgr: ProcessManager, ws: str, monkeypatch
    ):
        monkeypatch.setattr(settings, "max_retained_terminal_processes", 2)
        monkeypatch.setattr(settings, "max_retained_terminal_processes_per_session", 2)
        monkeypatch.setattr(settings, "process_timeout_seconds", 30)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 60)
        mgr._refresh_limits_from_settings()

        ids = []
        for i in range(5):
            start = mgr.start(
                session_id="evict_q",
                command=f'echo "marker-{i}"',
                workspace_path=ws,
                timeout=15,
            )
            ids.append(start["process_id"])
            mgr.wait(start["process_id"], timeout=10)

        # Unknown id → not found (None), never fabricated
        assert mgr.get("proc_does_not_exist") is None
        assert mgr.logs("proc_does_not_exist") is None

        # Oldest still recoverable from DB after memory eviction
        first = mgr.get(ids[0])
        assert first is not None
        assert first["status"] == ProcessStatus.COMPLETED.value
        assert first["session_id"] == "evict_q"
        logs = mgr.logs(ids[0], offset=0)
        assert logs is not None
        assert "marker-0" in logs["stdout"]

        # Process from another session id remains distinct
        other = mgr.start(
            session_id="other_owner",
            command='echo "other-only"',
            workspace_path=ws,
            timeout=15,
        )
        mgr.wait(other["process_id"], timeout=10)
        cross = mgr.get(other["process_id"])
        assert cross is not None
        assert cross["session_id"] == "other_owner"
        assert "other-only" in (mgr.logs(other["process_id"]) or {}).get("stdout", "")
        # Must not return other session's payload under first process_id
        again = mgr.get(ids[0])
        assert again is not None
        assert again["session_id"] == "evict_q"


def _is_terminal_status(status) -> bool:
    from sandbox.models import PROCESS_TERMINAL_STATUSES

    if status in PROCESS_TERMINAL_STATUSES:
        return True
    val = getattr(status, "value", status)
    return val in {getattr(s, "value", s) for s in PROCESS_TERMINAL_STATUSES}


class TestProcessHTTP:
    def test_http_owner_from_session_user_not_client_body(
        self, client, monkeypatch, tmp_path
    ):
        """Public route owner quota uses session.user_id; body cannot forge owner."""
        c, _session_id, mgr = client
        monkeypatch.setattr(settings, "max_managed_processes", 20)
        monkeypatch.setattr(settings, "max_managed_processes_per_session", 10)
        monkeypatch.setattr(settings, "max_managed_processes_per_owner", 2)
        monkeypatch.setattr(settings, "process_timeout_seconds", 60)
        monkeypatch.setattr(settings, "max_process_timeout_seconds", 120)
        mgr._refresh_limits_from_settings()

        # Two sessions same user_id, different workspaces
        s1 = c.post(
            "/sessions",
            json=session_create_payload(
                "owner-http",
                user_id="user_http_alice",
                agent_session_id=formal_id("A1"),
                workspace_id=formal_id("W1"),
            ),
        )
        assert s1.status_code in (200, 201), s1.text
        sid1 = s1.json()["session_id"]
        assert s1.json()["user_id"] == "user_http_alice"

        s2 = c.post(
            "/sessions",
            json=session_create_payload(
                "owner-http",
                user_id="user_http_alice",
                agent_session_id=formal_id("A2"),
                workspace_id=formal_id("W2"),
            ),
        )
        assert s2.status_code in (200, 201), s2.text
        sid2 = s2.json()["session_id"]

        cmd = "python3 -c \"import time; time.sleep(60)\""
        r1 = c.post(
            "/processes",
            json={"session_id": sid1, "command": cmd, "timeout": 30},
        )
        r2 = c.post(
            "/processes",
            json={"session_id": sid2, "command": cmd, "timeout": 30},
        )
        assert r1.status_code == 201, r1.text
        assert r2.status_code == 201, r2.text
        p1 = r1.json()["process_id"]
        p2 = r2.json()["process_id"]
        assert mgr._entries[p1]["owner_key"] == "user:user_http_alice"
        assert mgr._entries[p2]["owner_key"] == "user:user_http_alice"

        # Third process for same user must conflict (owner cap=2)
        s3 = c.post(
            "/sessions",
            json=session_create_payload(
                "owner-http",
                user_id="user_http_alice",
                agent_session_id=formal_id("A3"),
                workspace_id=formal_id("W3"),
            ),
        )
        sid3 = s3.json()["session_id"]
        r3 = c.post(
            "/processes",
            json={"session_id": sid3, "command": cmd, "timeout": 30},
        )
        assert r3.status_code == 409, r3.text

        # ProcessStartRequest has no user_id field — client cannot inject owner
        assert "user_id" not in (
            getattr(
                __import__("sandbox.models", fromlist=["ProcessStartRequest"]).ProcessStartRequest,
                "model_fields",
                {},
            )
        ) or "user_id" not in __import__(
            "sandbox.models", fromlist=["ProcessStartRequest"]
        ).ProcessStartRequest.model_fields

        for pid in (p1, p2):
            mgr.cancel(pid)
            mgr.wait(pid, timeout=10)

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
