"""C7 offline proof: single-instance formal Process Handle lifecycle.

Drives the shipped ``ProcessManager`` + ``FormalProcessDualWriter`` +
``FakeFormalProcessRepository`` entry points (not fakes of the manager itself):

- process start returns a durable handle (process_id + cursors)
- formal MySQL-shaped row is dual-written under owner/session/run binding
- get_owned / read_stream_owned / signal_process_owned (status/read/kill)
- LaunchSpec for handles uses die_with_parent=False and as_pid_1=True

Multi-host reclaim is intentionally out of scope (honest LOST on this host only).
"""

from __future__ import annotations

import os
import signal
import time
from pathlib import Path

import pytest

from sandbox.config import settings
from sandbox.isolation.base import LaunchSpec
from sandbox.isolation.direct import DirectIsolationBackend
from sandbox.models import ProcessStatus
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.process_handle_store import (
    FakeFormalProcessRepository,
    FormalProcessDualWriter,
)
from sandbox.services.process_manager import ProcessManager
from tests.conftest import formal_id

ORG = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER = "01K0G2PAV8FPMVC9QHJG7JPN51"
SESSION = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"


@pytest.fixture
def resolved_ws(tmp_path: Path) -> Path:
    """macOS: resolve so DirectIsolationBackend is_relative_to checks pass."""
    root = tmp_path.resolve()
    ws = root / "workspace"
    temp = root / "temp"
    ws.mkdir()
    temp.mkdir()
    return root


@pytest.fixture
def ctx(resolved_ws: Path) -> SandboxExecutionContext:
    return SandboxExecutionContext(
        session_id=SESSION,
        workspace_id="ws_c7",
        temp_id="tmp_c7",
        physical_workspace=resolved_ws / "workspace",
        physical_temp=resolved_ws / "temp",
        user_id=USER,
    )


@pytest.fixture
def mgr(monkeypatch: pytest.MonkeyPatch) -> ProcessManager:
    """ProcessManager with formal dual-write authority + direct isolation."""
    monkeypatch.setattr(settings, "max_process_count", 0)
    monkeypatch.setattr(settings, "max_memory_mb", 0)
    monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)
    monkeypatch.setattr(settings, "max_file_size_mb", 0)
    monkeypatch.setattr(settings, "max_open_files", 0)
    monkeypatch.setattr(settings, "default_deny_network", True)
    repo = FakeFormalProcessRepository()
    manager = ProcessManager(
        isolation_backend=DirectIsolationBackend(),
        formal_dual_writer=FormalProcessDualWriter(repo, authoritative=True),
    )
    manager._test_repo = repo  # type: ignore[attr-defined]
    return manager


def _owner_kwargs() -> dict[str, str]:
    return {
        "org_id": ORG,
        "user_id": USER,
        "sandbox_session_id": SESSION,
    }


def _start(
    mgr: ProcessManager,
    ctx: SandboxExecutionContext,
    command: str,
    *,
    timeout: int | None = None,
    background: bool = True,
) -> dict:
    return mgr.start(
        session_id=SESSION,
        command=command,
        context=ctx,
        org_id=ORG,
        sandbox_session_id=SESSION,
        run_id=RUN,
        execution_id=formal_id("EXC"),
        timeout=timeout,
        background=background,
    )


def _cleanup(mgr: ProcessManager, process_id: str | None) -> None:
    if not process_id:
        return
    entry = mgr.get(process_id)
    os_pid = entry.get("pid") if entry else None
    try:
        mgr.signal_process(process_id, "SIGKILL")
        mgr.wait(process_id, timeout=3)
    except Exception:
        pass
    if os_pid:
        try:
            os.kill(int(os_pid), signal.SIGKILL)
        except OSError:
            pass


class TestFormalProcessHandleLifecycle:
    def test_start_status_read_kill_real_manager(
        self, mgr: ProcessManager, ctx: SandboxExecutionContext
    ) -> None:
        """End-to-end handle API against shipped ProcessManager entry points."""
        start = _start(
            mgr,
            ctx,
            "python3 -c \"import time; print('c7-ready', flush=True); time.sleep(60)\"",
        )
        process_id = start.get("process_id")
        try:
            assert start["status"] == ProcessStatus.RUNNING.value
            assert process_id
            assert start.get("stdout_cursor")
            assert start.get("stderr_cursor")
            # Formal dual-write row present under owner binding.
            repo: FakeFormalProcessRepository = mgr._test_repo  # type: ignore[attr-defined]
            assert process_id in repo.rows
            row = repo.rows[process_id]
            assert row["org_id"] == ORG
            assert row["user_id"] == USER
            assert row["sandbox_session_id"] == SESSION
            assert row["run_id"] == RUN
            assert str(row["status"]).lower() == ProcessStatus.RUNNING.value
            assert row.get("pid") is not None

            # status (owned)
            status = mgr.get_owned(process_id, **_owner_kwargs())
            assert status is not None
            assert status["process_id"] == process_id
            assert status["status"] == ProcessStatus.RUNNING.value
            assert status.get("pid") is not None
            assert status.get("stdout_cursor")

            # wait for stdout then read by cursor
            deadline = time.time() + 5.0
            data = ""
            while time.time() < deadline:
                chunk = mgr.read_stream_owned(
                    process_id,
                    stream="stdout",
                    cursor="0-0",
                    limit=256,
                    **_owner_kwargs(),
                )
                assert chunk is not None
                data = chunk.get("data") or ""
                if "c7-ready" in data:
                    break
                time.sleep(0.05)
            assert "c7-ready" in data
            assert chunk["stream"] == "stdout"
            assert chunk["completed"] is False
            assert chunk["status"] == ProcessStatus.RUNNING.value

            # kill (TERM via owned signal path used by formal process_kill)
            killed = mgr.signal_process_owned(
                process_id, "TERM", **_owner_kwargs()
            )
            assert killed.get("ok") is True
            assert killed.get("signaled") is True

            final = mgr.wait(process_id, timeout=10)
            assert final is not None
            assert final["status"] in {
                ProcessStatus.FAILED.value,
                ProcessStatus.CANCELLED.value,
                ProcessStatus.COMPLETED.value,
            }
            # OS process gone
            child_pid = final.get("pid") or status.get("pid")
            if child_pid:
                with pytest.raises(OSError):
                    os.kill(int(child_pid), 0)

            # formal row advanced past running
            assert str(repo.rows[process_id]["status"]).lower() != ProcessStatus.RUNNING.value

            # post-kill owned status reflects terminal
            after = mgr.get_owned(process_id, **_owner_kwargs())
            assert after is not None
            assert after["status"] != ProcessStatus.RUNNING.value
        finally:
            _cleanup(mgr, process_id)

    def test_start_completes_and_read_stdout(
        self, mgr: ProcessManager, ctx: SandboxExecutionContext
    ) -> None:
        start = _start(
            mgr,
            ctx,
            "python3 -c \"print('c7-done', flush=True)\"",
            background=False,
        )
        process_id = start["process_id"]
        try:
            assert start["status"] == ProcessStatus.RUNNING.value
            final = mgr.wait(process_id, timeout=10)
            assert final["status"] == ProcessStatus.COMPLETED.value
            assert final["exit_code"] == 0
            read = mgr.read_stream_owned(
                process_id,
                stream="stdout",
                cursor="0-0",
                limit=1024,
                **_owner_kwargs(),
            )
            assert read is not None
            assert "c7-done" in (read.get("data") or "")
            assert read.get("completed") is True
            repo: FakeFormalProcessRepository = mgr._test_repo  # type: ignore[attr-defined]
            assert str(repo.rows[process_id]["status"]).lower() == "completed"
        finally:
            _cleanup(mgr, process_id)

    def test_get_owned_cross_tenant_fail_closed(
        self, mgr: ProcessManager, ctx: SandboxExecutionContext
    ) -> None:
        start = _start(mgr, ctx, "python3 -c \"import time; time.sleep(30)\"")
        process_id = start["process_id"]
        try:
            assert start["status"] == ProcessStatus.RUNNING.value
            other = mgr.get_owned(
                process_id,
                org_id="01K0G2PAV8FPMVC9QHJG7JPN99",
                user_id=USER,
                sandbox_session_id=SESSION,
            )
            assert other is None
            wrong_user = mgr.get_owned(
                process_id,
                org_id=ORG,
                user_id="01K0G2PAV8FPMVC9QHJG7JPN98",
                sandbox_session_id=SESSION,
            )
            assert wrong_user is None
            wrong_session = mgr.get_owned(
                process_id,
                org_id=ORG,
                user_id=USER,
                sandbox_session_id="01K0G2PAV8FPMVC9QHJG7JPN97",
            )
            assert wrong_session is None
        finally:
            _cleanup(mgr, process_id)

    def test_signal_owned_without_live_memory_is_unavailable(
        self, mgr: ProcessManager, ctx: SandboxExecutionContext
    ) -> None:
        """After in-memory handle drop, kill refuses blind PID signal (this-host only)."""
        start = _start(mgr, ctx, "python3 -c \"import time; time.sleep(30)\"")
        process_id = start["process_id"]
        os_pid = None
        try:
            status = mgr.get_owned(process_id, **_owner_kwargs())
            assert status is not None
            os_pid = status.get("pid")
            # Drop live maps while formal row remains — simulates post-eviction control.
            with mgr._lock:
                mgr._entries.pop(process_id, None)
                proc = mgr._procs.pop(process_id, None)
                mgr._logs.pop(process_id, None)
                mgr._stream_logs.pop(process_id, None)
            if proc is not None:
                try:
                    proc.kill()
                except Exception:
                    pass
            result = mgr.signal_process_owned(
                process_id, "KILL", **_owner_kwargs()
            )
            assert result.get("ok") is False
            assert result.get("status") == "unavailable"
            assert result.get("signaled") is False
        finally:
            _cleanup(mgr, process_id)
            if os_pid:
                try:
                    os.kill(int(os_pid), signal.SIGKILL)
                except OSError:
                    pass


class TestDurableHandleLaunchPolicy:
    def test_start_sets_die_with_parent_false_and_as_pid_1(
        self, monkeypatch: pytest.MonkeyPatch, ctx: SandboxExecutionContext
    ) -> None:
        """Process Handles must outlive API parent and act as PID-ns init."""

        class CapturingIsolation:
            name = "capturing"

            def __init__(self) -> None:
                self.spec: LaunchSpec | None = None

            def prepare(self, spec: LaunchSpec):
                self.spec = spec
                raise ValueError("stop after policy capture")

            def preflight(self) -> None:
                return None

        isolation = CapturingIsolation()
        manager = ProcessManager(
            isolation_backend=isolation,  # type: ignore[arg-type]
            formal_dual_writer=FormalProcessDualWriter(
                FakeFormalProcessRepository(), authoritative=True
            ),
        )
        monkeypatch.setattr(settings, "default_deny_network", True)
        result = manager.start(
            session_id=SESSION,
            command="sleep 120",
            context=ctx,
            org_id=ORG,
            sandbox_session_id=SESSION,
            run_id=RUN,
            execution_id=formal_id("EXC"),
            background=True,
        )
        assert result["status"] == ProcessStatus.FAILED.value
        assert isolation.spec is not None
        assert isolation.spec.die_with_parent is False
        assert isolation.spec.as_pid_1 is True

    def test_formal_command_json_records_durable_metadata(
        self, mgr: ProcessManager, ctx: SandboxExecutionContext
    ) -> None:
        start = _start(
            mgr,
            ctx,
            "python3 -c \"import time; time.sleep(20)\"",
            timeout=30,
            background=True,
        )
        process_id = start["process_id"]
        try:
            assert start["status"] == ProcessStatus.RUNNING.value
            repo: FakeFormalProcessRepository = mgr._test_repo  # type: ignore[attr-defined]
            cj = repo.rows[process_id]["command_json"]
            assert cj.get("background") is True
            assert cj.get("timeout_seconds") == 30
            assert cj.get("command")
            # Identity may be weak on macOS but field is populated when available.
            # Require pid at minimum for single-instance reclaim path.
            assert repo.rows[process_id].get("pid") is not None
        finally:
            _cleanup(mgr, process_id)
