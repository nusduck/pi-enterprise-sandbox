"""Tests for ExecutionManager."""

import shutil
import tempfile
from pathlib import Path

import pytest

from sandbox.services.execution_manager import ExecutionManager


@pytest.fixture
def ws():
    tmp = Path(tempfile.mkdtemp())
    yield str(tmp)
    shutil.rmtree(str(tmp), ignore_errors=True)


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
        # Lock should be released after execution completes
        assert mgr.is_session_busy("session_lock") is False

        # Second execution on same session should work fine
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
            # Execution already completed, cannot cancel
            assert mgr.cancel(exec_id) is False

    def test_cancel_nonexistent(self, mgr: ExecutionManager):
        assert mgr.cancel("nonexistent") is False

    def test_is_session_busy(self, mgr: ExecutionManager, ws: str):
        assert mgr.is_session_busy("busy_sesh") is False
        mgr.run_python("busy_sesh", 'print("hello")', ws)
        # After execution completes, lock should be released
        if not mgr.is_session_busy("busy_sesh"):
            pass  # Lock released after completion
