"""PR-14 offline: security isolation, process restart LOST, shutdown reconcile.

No Docker / live Redis / MySQL. Does not use removed Sandbox /agent-runs or
/agent-sessions routes (PR-13).
"""

from __future__ import annotations

import asyncio
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.database import Database
from sandbox.main import app
from sandbox.models import ProcessStatus
from sandbox.repositories import ProcessRepository
from sandbox.security.path_validation import resolve_safe_path
from sandbox.services.files_read_runtime import FilesReadRuntime
from sandbox.services.internal_execution_supervisor import (
    SUPERVISOR_STATE_CLOSED,
    SUPERVISOR_STATE_CLOSING,
    InternalExecutionSupervisor,
    SupervisorAdmissionError,
)
from sandbox.services.process_manager import ProcessManager

client = TestClient(app)


@pytest.fixture(autouse=True)
def _hermetic_auth(monkeypatch):
    monkeypatch.setattr(settings, "auth_enabled", False)


def _cleanup_mgr_process(mgr: ProcessManager, process_id: str) -> None:
    try:
        mgr.cancel(process_id)
    except Exception:
        pass
    try:
        mgr.wait(process_id, timeout=5)
    except Exception:
        pass


class TestSecurityPathAndLegacyAbsence:
    def test_path_escape_null_byte_absolute_rejected(self, tmp_path: Path):
        ws = str(tmp_path)
        with pytest.raises(PermissionError):
            resolve_safe_path(ws, "../etc/passwd")
        with pytest.raises(PermissionError):
            resolve_safe_path(ws, "/etc/passwd")
        with pytest.raises((PermissionError, ValueError, OSError)):
            resolve_safe_path(ws, "ok\x00/../secret")

    def test_legacy_agent_runs_and_sessions_absent(self):
        """PR-13: dual-authority Sandbox routes must stay gone."""
        paths = {getattr(r, "path", "") for r in app.routes}
        for pref in ("/agent-runs", "/agent-sessions", "/tool-executions"):
            offenders = [
                p for p in paths if p == pref or p.startswith(pref + "/")
            ]
            assert offenders == [], offenders
        for method, path in (
            ("GET", "/agent-runs"),
            ("POST", "/agent-runs"),
            ("GET", "/agent-sessions/x"),
            ("POST", "/tool-executions"),
        ):
            resp = client.request(method, path)
            assert resp.status_code == 404, f"{method} {path}"

    def test_cross_session_relative_escape_rejected(self, tmp_path: Path):
        a = tmp_path / "ws-a"
        b = tmp_path / "ws-b"
        a.mkdir()
        b.mkdir()
        (b / "secret.txt").write_text("nope")
        with pytest.raises(PermissionError):
            resolve_safe_path(str(a), f"../{b.name}/secret.txt")


class TestProcessRestartRecovery:
    def test_restart_marks_lost_not_running(self, tmp_path, monkeypatch):
        """Second ProcessManager instance reaps active rows as LOST (MySQL/SQLite authority)."""
        db_path = tmp_path / "pr14_proc.db"
        database = Database(f"sqlite:///{db_path}")
        database.initialize()
        database.migrate_process()
        monkeypatch.setattr(settings, "max_process_count", 0)
        monkeypatch.setattr(settings, "max_memory_mb", 0)
        monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)

        ws = str(tmp_path / "ws")
        Path(ws).mkdir()
        mgr1 = ProcessManager(database=database)
        start = mgr1.start(
            session_id="s_pr14_rec",
            command='python3 -c "import time; time.sleep(60)"',
            workspace_path=ws,
            timeout=90,
        )
        assert "process_id" in start, start
        pid = start["process_id"]
        try:
            time.sleep(0.25)
            entry = mgr1.get(pid)
            assert entry is not None
            assert entry["status"] == ProcessStatus.RUNNING.value
            mgr1.cancel(pid)
            mgr1.wait(pid, timeout=10)
            # Simulate crashed runner: row still RUNNING on disk
            repo = ProcessRepository(database)
            row = repo.get(pid)
            assert row is not None
            row["status"] = ProcessStatus.RUNNING.value
            row["finished_at"] = None
            repo.upsert(row)

            mgr2 = ProcessManager(database=database)
            assert mgr2.orphans_marked >= 1
            lost = mgr2.get(pid)
            assert lost is not None
            assert lost["status"] == ProcessStatus.LOST.value
            assert lost["status"] != ProcessStatus.RUNNING.value
        finally:
            _cleanup_mgr_process(mgr1, pid)


class TestShutdownReconcile:
    def test_reconcile_inflight_marks_unknown_once(self):
        marked: list[dict] = []

        class Claim:
            def mark_unknown_for_crash_recovery(self, payload):
                marked.append(dict(payload))
                return {"ok": True}

        class Reader:
            pass

        rt = FilesReadRuntime(
            claim_validator=Claim(),  # type: ignore[arg-type]
            reader=Reader(),  # type: ignore[arg-type]
            id_factory=lambda: "01K0G2PAV8FPMVC9QHJG7JPN60",
        )
        exec_id = "01K0G2PAV8FPMVC9QHJG7JPN61"
        with rt._inflight_lock:  # noqa: SLF001
            rt._inflight[exec_id] = {
                "org_id": "01K0G2PAV8FPMVC9QHJG7JPN4Z",
                "user_id": "01K0G2PAV8FPMVC9QHJG7JPN50",
                "execution_id": exec_id,
                "execution_fence_token": 7,
            }

        n = rt.reconcile_inflight_as_unknown()
        assert n == 1
        assert len(marked) == 1
        assert marked[0]["error_code"] == "SHUTDOWN_DRAIN_TIMEOUT"
        assert marked[0]["result_json"]["unknown"] is True
        assert rt.inflight_claim_count() == 0
        # Second reconcile is no-op (no double side-effect)
        assert rt.reconcile_inflight_as_unknown() == 0
        assert len(marked) == 1

    @pytest.mark.asyncio
    async def test_supervisor_close_and_drain_fail_closed_admission(self):
        sup = InternalExecutionSupervisor(max_active=2)
        release = asyncio.Event()

        async def job():
            await release.wait()
            return "ok"

        t = sup.spawn(job())
        drain_task = asyncio.create_task(sup.close_and_drain(2.0))
        await asyncio.sleep(0.05)
        with pytest.raises(SupervisorAdmissionError):
            sup.spawn(job())
        release.set()
        drained = await drain_task
        assert drained is True
        assert await t == "ok"
        assert sup.state in (SUPERVISOR_STATE_CLOSED, SUPERVISOR_STATE_CLOSING)
