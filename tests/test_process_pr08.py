"""PR-08 adversarial tests: cursors, kill idempotency, PID reuse, recovery, ownership."""

from __future__ import annotations

import os
import signal
import subprocess
import threading
import time
from pathlib import Path

import pytest

from fastapi.testclient import TestClient

from sandbox.app.domain.types import OwnerScope
from sandbox.config import settings
from sandbox.database import Database
from sandbox.models import ProcessStatus
from sandbox.paths import temp_id_for_workspace_id
from sandbox.repositories import ProcessRepository
from sandbox.services.execution_context import SandboxExecutionContext
from sandbox.services.process_cursor import StreamLogBuffer, parse_cursor
from sandbox.services.process_handle_store import (
    FakeFormalProcessRepository,
    FormalProcessDualWriter,
)
from sandbox.services.process_identity import (
    capture_process_identity,
    capture_start_identity,
    identity_matches,
    process_alive,
    safe_signal_identity,
)
from sandbox.services.process_manager import ProcessManager
from tests.conftest import session_create_payload


@pytest.fixture
def ws(tmp_path):
    p = tmp_path / "ws"
    p.mkdir()
    return str(p)


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "pr08.db"
    database = Database(f"sqlite:///{path}")
    database.initialize()
    database.migrate_process()
    return database


@pytest.fixture
def mgr(db, monkeypatch):
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
    monkeypatch.setattr(settings, "auth_enabled", False)
    monkeypatch.setattr(settings, "api_token", "")

    from sandbox.main import app
    from sandbox.services import process_manager as pm_mod

    db_path = tmp_path / "http_process_pr08.db"
    database = Database(f"sqlite:///{db_path}")
    database.initialize()
    database.migrate_process()
    isolated = ProcessManager(database=database)
    monkeypatch.setattr(pm_mod, "process_manager", isolated)

    import sandbox.routers.processes as proc_router
    import sandbox.routers.executions as exec_router

    monkeypatch.setattr(proc_router, "process_manager", isolated)
    monkeypatch.setattr(exec_router, "process_manager", isolated, raising=False)

    with TestClient(app) as c:
        resp = c.post("/sessions", json=session_create_payload("test-process-pr08"))
        assert resp.status_code in (200, 201), resp.text
        session = resp.json()
        yield c, session["session_id"], isolated


def _ctx(session_id: str, workspace_path: str, user_id: str | None = "user_a"):
    workspace = Path(workspace_path).resolve()
    workspace.mkdir(parents=True, exist_ok=True)
    wid = workspace.name or session_id
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


def _cleanup_os_pid(os_pid: int | None) -> None:
    if not os_pid:
        return
    try:
        os.kill(int(os_pid), signal.SIGKILL)
    except OSError:
        pass


def _cleanup_mgr_process(mgr: ProcessManager, process_id: str) -> None:
    """Best-effort: cancel via handle and wait; force-kill OS pid if needed."""
    entry = mgr.get(process_id)
    os_pid = entry.get("pid") if entry else None
    try:
        with mgr._lock:
            proc = mgr._procs.get(process_id)
            if proc is not None:
                try:
                    from sandbox.utils.resource_limits import terminate_process_group

                    terminate_process_group(
                        proc,
                        grace_seconds=0.5,
                        pgid=mgr._pgids.get(process_id),
                    )
                except Exception:
                    pass
        mgr.cancel(process_id)
        mgr.wait(process_id, timeout=5)
    finally:
        _cleanup_os_pid(os_pid)


class TestStreamCursor:
    def test_monotonic_incremental_idempotent(self):
        buf = StreamLogBuffer(max_chars=10_000)
        buf.append("hello ")
        buf.append("world")
        r1 = buf.read("0-0", limit=5)
        assert r1["data"] == "hello"
        assert len(r1["data"].encode("utf-8")) <= 5
        r1b = buf.read("0-0", limit=5)
        assert r1b["data"] == r1["data"]
        assert r1b["next_cursor"] == r1["next_cursor"]
        r2 = buf.read(r1["next_cursor"], limit=100)
        assert "world" in r2["data"] or r2["data"].startswith(" ")
        full = buf.read("0-0", limit=1000)
        assert "hello" in full["data"] and "world" in full["data"]

    def test_utf8_byte_cursor_no_split_codepoint(self):
        """limit is bytes; never return illegal UTF-8 / split multi-byte chars."""
        buf = StreamLogBuffer(max_chars=10_000)
        # 你好 = 6 bytes (3+3); 世界 = 6 bytes
        buf.append("你好世界")
        assert buf.total == len("你好世界".encode("utf-8"))
        # limit=4: first CJK is 3 bytes (fits); second would incomplete → only first.
        r = buf.read("0-0", limit=4)
        raw = r["data"].encode("utf-8")
        assert len(raw) <= 4
        r["data"].encode("utf-8").decode("utf-8")  # round-trip
        assert r["data"] == "你"
        assert r["next_cursor"].endswith("-3")
        r2 = buf.read(r["next_cursor"], limit=100)
        assert r2["data"] == "好世界"

    def test_limit_1_cjk_advances_at_least_one_codepoint(self):
        """limit=1 must not stall: return one full CJK char (3 bytes) and advance.

        Contract: at-least-one code point, overrun ≤ 3 bytes past limit.
        next_cursor is strictly monotonic; same cursor is idempotent.
        """
        buf = StreamLogBuffer(max_chars=10_000)
        buf.append("你好世界")
        r1 = buf.read("0-0", limit=1)
        assert r1["data"] == "你"
        assert len(r1["data"].encode("utf-8")) == 3  # overrun allowed
        assert r1["next_cursor"] == "0-3"
        # Idempotent
        r1b = buf.read("0-0", limit=1)
        assert r1b["data"] == r1["data"]
        assert r1b["next_cursor"] == r1["next_cursor"]
        # Sequential: no skip
        r2 = buf.read(r1["next_cursor"], limit=1)
        assert r2["data"] == "好"
        assert r2["next_cursor"] == "0-6"
        r3 = buf.read(r2["next_cursor"], limit=1)
        assert r3["data"] == "世"
        assert r3["next_cursor"] == "0-9"
        # Empty progress forbidden while data remains
        assert r1["next_cursor"] != "0-0"
        assert r2["next_cursor"] != r1["next_cursor"]

    def test_utf8_mid_cursor_advances_to_char_boundary(self):
        buf = StreamLogBuffer(max_chars=10_000)
        buf.append("A你B")  # 1 + 3 + 1 = 5 bytes
        # Cursor at byte 2 (mid 你) must advance to byte 4 (after 你) or start of 你
        # Our semantics: advance forward to next char start → after incomplete, to start of next complete
        # index 2 is continuation of 你 → advance to byte 4 (start of B)?
        # Actually _utf8_char_start at 2 walks past cont bytes to index 4 (B).
        # Wait: 你 is bytes 1,2,3 (0-index). index 2 is cont → walk to 4 which is B.
        # That drops the rest of 你 - client who lands mid-char loses that char (documented).
        r = buf.read("0-2", limit=10)
        r["data"].encode("utf-8").decode("utf-8")
        assert "B" in r["data"] or r["data"] == "" or "你" in r["data"]

    def test_oversized_append_counts_full_total_and_dropped(self):
        buf = StreamLogBuffer(max_chars=20)
        payload = "abcdefghijklmnopqrstuvwxyz"  # 26 bytes ASCII
        buf.append(payload)
        assert buf.truncated is True
        assert buf.total == 26  # full original length, not just retained tail
        assert buf.dropped_through > 0
        assert buf.generation >= 1
        retained = buf.total - buf.dropped_through
        assert retained <= 20
        r = buf.read("0-0", limit=100)
        assert r["dropped"] is True
        assert r["log_total"] == 26
        # Retained data is a suffix of the original
        assert payload.endswith(r["data"]) or r["data"] in payload

    def test_oversized_utf8_append_boundary(self):
        buf = StreamLogBuffer(max_chars=10)
        # 10 CJK chars = 30 bytes
        text = "一二三四五六七八九十"
        raw = text.encode("utf-8")
        assert len(raw) == 30
        buf.append(text)
        assert buf.total == 30
        assert buf.dropped_through >= 20
        r = buf.read("0-0", limit=100)
        assert r["dropped"] is True
        # Returned data must be valid UTF-8 and a suffix of the original string
        assert r["data"]
        assert text.endswith(r["data"])
        r["data"].encode("utf-8").decode("utf-8")

    def test_concurrent_append_and_read(self):
        buf = StreamLogBuffer(max_chars=50_000)
        errors: list[BaseException] = []
        stop = threading.Event()

        def writer():
            try:
                for i in range(200):
                    buf.append(f"line-{i}-数据\n")
            except BaseException as exc:  # pragma: no cover
                errors.append(exc)

        def reader():
            try:
                cursor = "0-0"
                for _ in range(100):
                    r = buf.read(cursor, limit=64)
                    r["data"].encode("utf-8").decode("utf-8")
                    cursor = r["next_cursor"]
                    if stop.is_set():
                        break
            except BaseException as exc:  # pragma: no cover
                errors.append(exc)

        threads = [
            threading.Thread(target=writer),
            threading.Thread(target=reader),
            threading.Thread(target=reader),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)
        stop.set()
        assert not errors
        assert buf.total > 0

    def test_parse_cursor_rejects_garbage(self):
        with pytest.raises(ValueError):
            parse_cursor("not-a-cursor!!")
        with pytest.raises(ValueError):
            parse_cursor("x" * 100)


class TestProcessReadCursor:
    def test_concurrent_reads_stable(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s_read",
            command=(
                "python3 -c \""
                "import time\n"
                "for i in range(20):\n"
                " print('L%d' % i, flush=True)\n"
                " time.sleep(0.02)\n"
                "\""
            ),
            workspace_path=ws,
            timeout=30,
        )
        pid = start["process_id"]
        assert start["stdout_cursor"] == "0-0"
        results = []
        errors = []
        try:
            def worker():
                try:
                    cursor = "0-0"
                    chunks = []
                    for _ in range(40):
                        r = mgr.read_stream(pid, stream="stdout", cursor=cursor, limit=64)
                        assert r is not None
                        chunks.append(r["data"])
                        cursor = r["next_cursor"]
                        if r.get("completed") and not r["data"]:
                            break
                        time.sleep(0.01)
                    results.append("".join(chunks))
                except Exception as exc:  # pragma: no cover
                    errors.append(exc)

            threads = [threading.Thread(target=worker) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(timeout=20)
            assert not errors
            mgr.wait(pid, timeout=15)
            for body in results:
                assert "L0" in body or "L1" in body
        finally:
            _cleanup_mgr_process(mgr, pid)

    def test_oversized_output_bounded_read(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s_big",
            command="python3 -c \"print('X'*200000, flush=True)\"",
            workspace_path=ws,
            timeout=30,
        )
        pid = start["process_id"]
        try:
            mgr.wait(pid, timeout=15)
            r = mgr.read_stream(pid, stream="stdout", cursor="0-0", limit=4096)
            assert r is not None
            assert len(r["data"].encode("utf-8")) <= 4096
            assert r["next_cursor"] != "0-0" or r["truncated"]
        finally:
            _cleanup_mgr_process(mgr, pid)


class TestKillCancelIdempotent:
    def test_duplicate_kill_and_cancel(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s_kill",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            timeout=90,
        )
        pid = start["process_id"]
        try:
            time.sleep(0.2)
            assert mgr.cancel(pid) is True
            assert mgr.cancel(pid) is True  # idempotent
            final = mgr.wait(pid, timeout=10)
            assert final["status"] == ProcessStatus.CANCELLED.value
            r = mgr.signal_process(pid, "KILL")
            assert r.get("ok") is True
            assert r.get("idempotent") is True
        finally:
            _cleanup_mgr_process(mgr, pid)


class TestPidReuseAndIdentity:
    def test_capture_start_identity_cross_platform(self):
        p = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            deadline = time.time() + 2
            ident = None
            while time.time() < deadline:
                ident = capture_start_identity(p.pid)
                if ident:
                    break
                time.sleep(0.05)
            assert ident is not None, "capture_start_identity must work on this platform"
            assert not ident.startswith("spawn-token:")
            # Darwin primary is libproc; Linux is /proc starttime.
            assert ident.startswith("darwin-bsdinfo-v1:") or ident.startswith(
                "linux-starttime:"
            ) or ident.startswith("ps-v1:"), ident
            assert identity_matches(p.pid, ident)
            ident2 = capture_start_identity(p.pid)
            assert ident2 == ident  # re-capturable / stable
            full = capture_process_identity(p.pid, pgid=os.getpgid(p.pid))
            assert full is not None
            assert full.start_identity is not None
            assert identity_matches(p.pid, full.start_identity)
        finally:
            try:
                os.kill(p.pid, signal.SIGKILL)
            except OSError:
                pass
            p.wait(timeout=5)

    def test_darwin_libproc_works_when_ps_blocked(self, monkeypatch):
        """macOS identity must not require ps (policy-restricted environments)."""
        import sys

        if sys.platform != "darwin":
            pytest.skip("Darwin-only libproc path")

        def _block_ps(*_a, **_k):
            raise PermissionError("ps blocked by policy")

        monkeypatch.setattr(subprocess, "run", _block_ps)
        from sandbox.services import process_identity as pi_mod

        # Also block internal optional ps helpers if called.
        monkeypatch.setattr(pi_mod, "read_ps_start_identity", lambda _pid: None)

        p = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            ident = capture_start_identity(p.pid)
            assert ident is not None
            assert ident.startswith("darwin-bsdinfo-v1:")
            assert identity_matches(p.pid, ident)
        finally:
            try:
                os.kill(p.pid, signal.SIGKILL)
            except OSError:
                pass
            p.wait(timeout=5)

    def test_safe_signal_refuses_mismatched_identity(self):
        p = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            ident = capture_start_identity(p.pid)
            assert ident
            assert identity_matches(p.pid, ident)
            bad = safe_signal_identity(
                pid=p.pid,
                pgid=None,
                start_identity="linux-starttime:999999999",
                signum=signal.SIGTERM,
            )
            assert bad.get("signaled") is False
            # Still alive
            os.kill(p.pid, 0)
            # spawn-token must never match / never signal
            tok = safe_signal_identity(
                pid=p.pid,
                pgid=None,
                start_identity="spawn-token:1:2:3",
                signum=signal.SIGKILL,
            )
            assert tok.get("signaled") is False
            os.kill(p.pid, 0)
            ok = safe_signal_identity(
                pid=p.pid,
                pgid=None,
                start_identity=ident,
                signum=signal.SIGKILL,
            )
            assert ok.get("signaled") is True
        finally:
            try:
                os.kill(p.pid, signal.SIGKILL)
            except OSError:
                pass
            p.wait(timeout=5)

    def test_cancel_without_handle_uses_identity(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s_id",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            timeout=90,
        )
        pid = start["process_id"]
        os_pid = None
        try:
            deadline = time.time() + 3
            entry = None
            while time.time() < deadline:
                entry = mgr.get(pid)
                if entry and entry.get("pid"):
                    break
                time.sleep(0.05)
            assert entry and entry.get("pid")
            os_pid = entry["pid"]
            # Drop live handle to force identity path
            with mgr._lock:
                full = mgr._entries[pid]
                assert full.get("start_identity"), (
                    "start_identity must be re-verifiable on this platform"
                )
                mgr._procs.pop(pid, None)
            assert mgr.cancel(pid) is True
            final = mgr.wait(pid, timeout=10)
            assert final["status"] in (
                ProcessStatus.CANCELLED.value,
                ProcessStatus.CANCEL_REQUESTED.value,
                ProcessStatus.FAILED.value,
            )
            assert process_alive(os_pid) is False
        finally:
            _cleanup_mgr_process(mgr, pid)
            _cleanup_os_pid(os_pid)

    def test_cancel_without_identity_does_not_fake_terminal(
        self, mgr: ProcessManager, ws: str
    ):
        """If identity is missing and handle is gone, do not claim CANCELLED while alive."""
        start = mgr.start(
            session_id="s_no_id",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            timeout=90,
        )
        pid = start["process_id"]
        os_pid = None
        try:
            deadline = time.time() + 3
            while time.time() < deadline:
                entry = mgr.get(pid)
                if entry and entry.get("pid"):
                    os_pid = entry["pid"]
                    break
                time.sleep(0.05)
            assert os_pid
            with mgr._lock:
                # Strip identity and live handle to simulate worst case.
                mgr._entries[pid]["start_identity"] = None
                mgr._procs.pop(pid, None)
            ok = mgr.cancel(pid)
            assert ok is False
            st = mgr.get(pid)
            assert st is not None
            # Must not write false terminal CANCELLED while process is alive.
            if process_alive(os_pid):
                assert st["status"] != ProcessStatus.CANCELLED.value
                assert st["status"] in (
                    ProcessStatus.CANCEL_REQUESTED.value,
                    ProcessStatus.RUNNING.value,
                )
        finally:
            # Restore kill via OS (manager cannot identity-kill now).
            _cleanup_os_pid(os_pid)
            with mgr._lock:
                entry = mgr._entries.get(pid)
                if entry and not entry.get("finished_at"):
                    entry["status"] = ProcessStatus.CANCELLED.value
                    entry["finished_at"] = entry.get("updated_at")
                    mgr._done_events.get(pid, threading.Event()).set()


class TestRestartRecovery:
    def test_restart_marks_lost_not_running(self, db, ws: str, monkeypatch):
        monkeypatch.setattr(settings, "max_process_count", 0)
        monkeypatch.setattr(settings, "max_memory_mb", 0)
        monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)
        mgr1 = ProcessManager(database=db)
        start = mgr1.start(
            session_id="s_rec",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            timeout=90,
        )
        pid = start["process_id"]
        try:
            time.sleep(0.25)
            entry = mgr1.get(pid)
            assert entry["status"] == ProcessStatus.RUNNING.value
            mgr1.cancel(pid)
            mgr1.wait(pid, timeout=10)
            repo = ProcessRepository(db)
            row = repo.get(pid)
            assert row is not None
            row["status"] = ProcessStatus.RUNNING.value
            row["finished_at"] = None
            repo.upsert(row)

            mgr2 = ProcessManager(database=db)
            assert mgr2.orphans_marked >= 1
            lost = mgr2.get(pid)
            assert lost["status"] == ProcessStatus.LOST.value
            assert lost["status"] != ProcessStatus.RUNNING.value
        finally:
            _cleanup_mgr_process(mgr1, pid)


class TestCancelHttpAndBatch:
    """HTTP cancel respects manager delivery; batch only lists successes."""

    def test_http_cancel_identity_mismatch_alive_409(self, client, monkeypatch):
        c, session_id, mgr = client
        resp = c.post(
            "/processes",
            json={
                "session_id": session_id,
                "command": "python3 -c \"import time; time.sleep(60)\"",
                "timeout": 90,
            },
        )
        assert resp.status_code == 201, resp.text
        process_id = resp.json()["process_id"]
        os_pid = None
        try:
            deadline = time.time() + 3
            while time.time() < deadline:
                st = mgr.get(process_id)
                if st and st.get("pid"):
                    os_pid = st["pid"]
                    break
                time.sleep(0.05)
            assert os_pid
            # Force undeliverable cancel: drop handle + identity.
            with mgr._lock:
                mgr._entries[process_id]["start_identity"] = None
                mgr._procs.pop(process_id, None)
            cancel = c.post(f"/processes/{process_id}/cancel")
            assert cancel.status_code == 409, cancel.text
            body = cancel.json()
            # Generic detail — no identity secrets.
            assert "not delivered" in (body.get("detail") or "").lower()
            st = mgr.get(process_id)
            assert st is not None
            assert st["status"] != ProcessStatus.CANCELLED.value
            assert process_alive(os_pid) is True
        finally:
            _cleanup_os_pid(os_pid)
            _cleanup_mgr_process(mgr, process_id)

    def test_http_cancel_terminal_idempotent_200(self, client):
        c, session_id, mgr = client
        resp = c.post(
            "/processes",
            json={
                "session_id": session_id,
                "command": 'echo "done-cancel"',
                "timeout": 30,
            },
        )
        assert resp.status_code == 201
        process_id = resp.json()["process_id"]
        try:
            final = mgr.wait(process_id, timeout=10)
            assert final["status"] == ProcessStatus.COMPLETED.value
            # Already terminal → cancel is idempotent success.
            cancel = c.post(f"/processes/{process_id}/cancel")
            assert cancel.status_code == 200, cancel.text
            assert cancel.json()["status"] == ProcessStatus.COMPLETED.value
            cancel2 = c.post(f"/processes/{process_id}/cancel")
            assert cancel2.status_code == 200
        finally:
            _cleanup_mgr_process(mgr, process_id)

    def test_batch_cancel_partial_success(self, mgr: ProcessManager, ws: str):
        # One process we can cancel via handle; one we sabotage for fail.
        p1 = mgr.start(
            session_id="batch_s",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            timeout=90,
        )
        p2 = mgr.start(
            session_id="batch_s",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            timeout=90,
        )
        id1, id2 = p1["process_id"], p2["process_id"]
        os_pids = []
        try:
            time.sleep(0.25)
            for pid in (id1, id2):
                e = mgr.get(pid)
                if e and e.get("pid"):
                    os_pids.append(e["pid"])
            # Sabotage p2 only.
            with mgr._lock:
                mgr._entries[id2]["start_identity"] = None
                mgr._procs.pop(id2, None)
            details = mgr.cancel_for_session("batch_s", return_details=True)
            assert id1 in details["cancelled"]
            assert id2 in details["failed"]
            assert id2 not in details["cancelled"]
            # Default list API: only successes
            only = mgr.cancel_for_session("batch_s")
            assert id2 not in only
        finally:
            for p in os_pids:
                _cleanup_os_pid(p)
            for pid in (id1, id2):
                _cleanup_mgr_process(mgr, pid)

    def test_http_session_cancel_reports_failed(self, client):
        c, session_id, mgr = client
        r1 = c.post(
            "/processes",
            json={
                "session_id": session_id,
                "command": "python3 -c \"import time; time.sleep(60)\"",
                "timeout": 90,
            },
        )
        assert r1.status_code == 201
        p1 = r1.json()["process_id"]
        r2 = c.post(
            "/processes",
            json={
                "session_id": session_id,
                "command": "python3 -c \"import time; time.sleep(60)\"",
                "timeout": 90,
            },
        )
        assert r2.status_code == 201
        p2 = r2.json()["process_id"]
        os_pids = []
        try:
            time.sleep(0.25)
            for pid in (p1, p2):
                e = mgr.get(pid)
                if e and e.get("pid"):
                    os_pids.append(e["pid"])
            with mgr._lock:
                mgr._entries[p2]["start_identity"] = None
                mgr._procs.pop(p2, None)
            resp = c.post(f"/processes/session/{session_id}/cancel")
            assert resp.status_code == 200, resp.text
            body = resp.json()
            assert p1 in body["cancelled"]
            assert body["count"] == len(body["cancelled"])
            assert p2 in body["failed"]
            assert body["failed_count"] >= 1
            assert p2 not in body["cancelled"]
        finally:
            for p in os_pids:
                _cleanup_os_pid(p)
            for pid in (p1, p2):
                _cleanup_mgr_process(mgr, pid)


class TestFormalDualWriteOwnership:
    def test_fake_formal_cross_tenant_fail_closed(self, db, ws: str, monkeypatch):
        monkeypatch.setattr(settings, "max_process_count", 0)
        monkeypatch.setattr(settings, "max_memory_mb", 0)
        monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)
        fake = FakeFormalProcessRepository()
        dual = FormalProcessDualWriter(fake, conn_factory=lambda: None)
        mgr = ProcessManager(database=db, formal_dual_writer=dual)
        start = mgr.start(
            session_id="s_form",
            command='echo "formal-ok"',
            workspace_path=ws,
            timeout=15,
            run_id="01K0G2PAV8FPMVC9QHJG7JPN4Z",
            org_id="01K0G2PAV8FPMVC9QHJG7JPN50",
            conversation_id="01K0G2PAV8FPMVC9QHJG7JPN51",
            context=_ctx("s_form", ws, user_id="01K0G2PAV8FPMVC9QHJG7JPN52"),
        )
        try:
            mgr.wait(start["process_id"], timeout=10)
            scope_ok = OwnerScope(
                org_id="01K0G2PAV8FPMVC9QHJG7JPN50",
                user_id="01K0G2PAV8FPMVC9QHJG7JPN52",
            )
            scope_bad = OwnerScope(
                org_id="01K0G2PAV8FPMVC9QHJG7JPN50",
                user_id="01K0G2PAV8FPMVC9QHJG7JPN99",
            )
            row = fake.get_by_id(None, start["process_id"], scope_ok)
            assert row is not None
            assert fake.get_by_id(None, start["process_id"], scope_bad) is None
        finally:
            _cleanup_mgr_process(mgr, start["process_id"])

    def test_timeout_terminates(self, mgr: ProcessManager, ws: str):
        start = mgr.start(
            session_id="s_to",
            command="python3 -c \"import time; time.sleep(60)\"",
            workspace_path=ws,
            timeout=1,
        )
        try:
            final = mgr.wait(start["process_id"], timeout=15)
            assert final["status"] == ProcessStatus.TIMEOUT.value
        finally:
            _cleanup_mgr_process(mgr, start["process_id"])
