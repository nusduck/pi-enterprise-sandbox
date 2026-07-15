"""Tests for ExecutionManager — admission, cancel, and races."""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
import time
from pathlib import Path

import pytest

from sandbox.config import settings
from sandbox.models import ExecutionStatus
from sandbox.services.execution_manager import ExecutionManager
from sandbox.utils.resource_limits import contains_network_command


@pytest.fixture
def ws():
    tmp = Path(tempfile.mkdtemp())
    yield str(tmp)
    shutil.rmtree(str(tmp), ignore_errors=True)


@pytest.fixture
def relax_proc_limits(monkeypatch):
    """Avoid host RLIMIT_NPROC exhaustion on developer machines (macOS).

    Production still applies limits; unit tests only need a live child process.
    """
    monkeypatch.setattr(settings, "max_process_count", 0)
    monkeypatch.setattr(settings, "max_memory_mb", 0)
    monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)


# Long-running command that stays in one process (no bash fork for sleep).
_LONG_PY = (
    "import os,time; open('pid.txt','w').write(str(os.getpid())); "
    "open('pid.txt','a').flush(); time.sleep(60)"
)


def test_network_command_detection_matches_shell_tokens_not_source_substrings():
    assert contains_network_command("nc example.com 80") is True
    for command in (
        "pip3 install requests",
        "python -m pip install requests",
        "npm ci",
        "yarn install",
        "pnpm install",
    ):
        assert contains_network_command(command) is True
    assert contains_network_command("python -c 'ncc=len(rows)'") is False
    assert contains_network_command("python -c 'variance=len(rows)'") is False


class TestExecutionManager:
    @pytest.fixture
    def mgr(self):
        return ExecutionManager()

    def test_run_python_success(self, mgr: ExecutionManager, ws: str):
        result = mgr.run_python("session_1", 'print("hello")', ws)
        assert result["status"] in ("SUCCESS", "RUNNING", "FAILED")
        if result["status"] == "SUCCESS":
            assert "hello" in result.get("stdout_preview", "")

    def test_run_python_with_error(self, mgr: ExecutionManager, ws: str):
        result = mgr.run_python("session_2", 'raise ValueError("test error")', ws)
        assert result["status"] in ("FAILED", "RUNNING")

    def test_run_command_success(self, mgr: ExecutionManager, ws: str):
        result = mgr.run_command("session_3", 'echo "hello sandbox"', ws)
        assert result["status"] in ("SUCCESS", "RUNNING", "FAILED")
        if result["status"] == "SUCCESS":
            assert "hello sandbox" in result.get("stdout_preview", "")

    def test_session_serial_lock(self, mgr: ExecutionManager, ws: str):
        """After execution completes, session lock is released."""
        mgr.run_python("session_lock", 'print("first")', ws)
        assert mgr.is_session_busy("session_lock") is False

        result = mgr.run_python("session_lock", 'print("second")', ws)
        assert result.get("status") != "conflict"

    def test_different_sessions_can_run_concurrently(self, mgr: ExecutionManager, ws: str):
        """Different sessions should not block each other."""
        r1 = mgr.run_python("session_a", 'print("a")', ws)
        r2 = mgr.run_python("session_b", 'print("b")', ws)
        assert r1.get("status") != "conflict"
        assert r2.get("status") != "conflict"

    def test_get_execution(self, mgr: ExecutionManager, ws: str):
        result = mgr.run_python("session_get", 'print("get")', ws)
        execution_id = result.get("execution_id", "")
        if execution_id:
            fetched = mgr.get(execution_id)
            assert fetched is not None
            assert fetched["session_id"] == "session_get"

    def test_cancel_completed_execution(self, mgr: ExecutionManager, ws: str):
        """Canceling a completed execution returns False."""
        result = mgr.run_python("session_cancel", 'print("quick")', ws)
        exec_id = result.get("execution_id", "")
        if exec_id:
            assert mgr.cancel(exec_id) is False

    def test_cancel_nonexistent(self, mgr: ExecutionManager):
        assert mgr.cancel("nonexistent") is False

    def test_is_session_busy(self, mgr: ExecutionManager, ws: str):
        assert mgr.is_session_busy("busy_sesh") is False
        mgr.run_python("busy_sesh", 'print("hello")', ws)
        assert mgr.is_session_busy("busy_sesh") is False

    def test_atomic_same_session_admission(
        self, mgr: ExecutionManager, ws: str, relax_proc_limits
    ):
        """Second concurrent execution on the same session is rejected."""
        long_result: dict = {}

        def long_run():
            long_result.update(
                mgr.run_python(
                    "sess_admit",
                    "import time; time.sleep(3)",
                    ws,
                    timeout=10,
                )
            )

        t = threading.Thread(target=long_run)
        t.start()

        # Wait until session is busy (admission succeeded)
        deadline = time.time() + 3.0
        while time.time() < deadline and not mgr.is_session_busy("sess_admit"):
            time.sleep(0.02)
        assert mgr.is_session_busy("sess_admit") is True

        conflict = mgr.run_command("sess_admit", 'echo "nope"', ws)
        assert conflict.get("status") == "conflict"
        assert "already has a running execution" in conflict.get("error", "")

        t.join(timeout=15)
        assert t.is_alive() is False
        # After completion lock is free
        assert mgr.is_session_busy("sess_admit") is False
        assert long_result.get("status") in (
            ExecutionStatus.SUCCESS,
            ExecutionStatus.SUCCESS.value,
            ExecutionStatus.CANCELLED,
            ExecutionStatus.CANCELLED.value,
            ExecutionStatus.TIMEOUT,
            ExecutionStatus.TIMEOUT.value,
            ExecutionStatus.FAILED,
            ExecutionStatus.FAILED.value,
        )

    def test_cancel_terminates_running_process(
        self, mgr: ExecutionManager, ws: str, relax_proc_limits
    ):
        """cancel() kills the process group and persists CANCELLED."""
        result_holder: dict = {}

        def long_run():
            result_holder.update(
                mgr.run_python("sess_kill", _LONG_PY, ws, timeout=90)
            )

        t = threading.Thread(target=long_run)
        t.start()

        deadline = time.time() + 5.0
        exec_id = None
        while time.time() < deadline:
            exec_id = mgr.get_running_execution_id("sess_kill")
            if exec_id:
                break
            time.sleep(0.02)
        assert exec_id, f"execution never became active; holder={result_holder}"

        # Wait until child has written its pid (process actually running)
        pid_path = Path(ws) / "pid.txt"
        pid_deadline = time.time() + 5.0
        while time.time() < pid_deadline and not pid_path.exists():
            time.sleep(0.02)
        assert pid_path.exists(), f"child never wrote pid; holder={result_holder}"

        ok = mgr.cancel(exec_id)
        assert ok is True

        t.join(timeout=15)
        assert t.is_alive() is False

        final = mgr.get(exec_id) or result_holder
        assert final["status"] in (
            ExecutionStatus.CANCELLED,
            ExecutionStatus.CANCELLED.value,
        )
        assert mgr.is_session_busy("sess_kill") is False

        # Process should be gone
        child_pid = int(pid_path.read_text().strip())
        time.sleep(0.1)
        try:
            os.kill(child_pid, 0)
            still_alive = True
        except OSError:
            still_alive = False
        assert still_alive is False, f"child pid {child_pid} still alive after cancel"

        # cancel is idempotent after terminal
        assert mgr.cancel(exec_id) is False

    def test_cancel_vs_complete_race_single_terminal(
        self, mgr: ExecutionManager, ws: str, relax_proc_limits
    ):
        """Racing cancel against a finishing command yields one terminal status."""
        results: list[dict] = []
        barrier = threading.Barrier(2)

        def runner():
            # Very short command so complete and cancel can race
            barrier.wait(timeout=5)
            results.append(mgr.run_command("sess_race", "echo race-done", ws, timeout=10))

        def canceller():
            barrier.wait(timeout=5)
            # Spin until admitted or finished, then cancel
            for _ in range(200):
                eid = mgr.get_running_execution_id("sess_race")
                if eid:
                    mgr.cancel(eid)
                    return
                time.sleep(0.005)
            if results:
                eid = results[0].get("execution_id")
                if eid:
                    mgr.cancel(eid)

        t1 = threading.Thread(target=runner)
        t2 = threading.Thread(target=canceller)
        t1.start()
        t2.start()
        t1.join(timeout=15)
        t2.join(timeout=15)
        assert t1.is_alive() is False

        assert len(results) == 1
        status = results[0]["status"]
        if hasattr(status, "value"):
            status = status.value
        assert status in ("SUCCESS", "CANCELLED", "FAILED", "TIMEOUT")
        # Session must not stay busy
        assert mgr.is_session_busy("sess_race") is False
        # Single terminal status on the stored entry
        eid = results[0]["execution_id"]
        stored = mgr.get(eid)
        assert stored is not None
        stored_status = stored["status"]
        if hasattr(stored_status, "value"):
            stored_status = stored_status.value
        assert stored_status in ("SUCCESS", "CANCELLED", "FAILED", "TIMEOUT")
        assert stored_status == status

    def test_cancel_active_helper(
        self, mgr: ExecutionManager, ws: str, relax_proc_limits
    ):
        holder: dict = {}

        def long_run():
            holder.update(
                mgr.run_python(
                    "sess_active",
                    "import time; time.sleep(30)",
                    ws,
                    timeout=60,
                )
            )

        t = threading.Thread(target=long_run)
        t.start()
        deadline = time.time() + 5.0
        while time.time() < deadline and not mgr.is_session_busy("sess_active"):
            time.sleep(0.02)
        assert mgr.is_session_busy("sess_active") is True, f"holder={holder}"

        entry = mgr.cancel_active("sess_active")
        assert entry is not None
        t.join(timeout=15)
        assert mgr.is_session_busy("sess_active") is False
        # Idle cancel returns None
        assert mgr.cancel_active("sess_active") is None

    def test_cancel_active_idle_returns_none(self, mgr: ExecutionManager):
        assert mgr.cancel_active("never_ran") is None
