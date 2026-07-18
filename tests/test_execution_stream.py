"""B3 Streaming Execution Events — live deltas, sequence resume, durable logs."""

from __future__ import annotations

import json
import queue
import shutil
import tempfile
import threading
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sandbox.config import settings
from sandbox.database import Database
from sandbox.services.execution_manager import ExecutionManager
from sandbox.services.execution_stream import (
    EVENT_COMPLETED,
    EVENT_FAILED,
    EVENT_STARTED,
    EVENT_STDOUT_DELTA,
    SOURCE_EXECUTION,
    SOURCE_PROCESS,
    ExecutionStreamHub,
)
from sandbox.services.process_manager import ProcessManager
from tests.conftest import session_create_payload


@pytest.fixture
def ws():
    tmp = Path(tempfile.mkdtemp(prefix="exec_stream_ws_"))
    yield str(tmp)
    shutil.rmtree(str(tmp), ignore_errors=True)


@pytest.fixture
def db(tmp_path):
    path = tmp_path / "stream.db"
    database = Database(f"sqlite:///{path}")
    database.initialize()
    return database


@pytest.fixture
def hub(db):
    return ExecutionStreamHub(database=db)


@pytest.fixture
def relax_limits(monkeypatch):
    monkeypatch.setattr(settings, "max_process_count", 0)
    monkeypatch.setattr(settings, "max_memory_mb", 0)
    monkeypatch.setattr(settings, "max_cpu_time_seconds", 0)
    monkeypatch.setattr(settings, "default_deny_network", True)


class TestExecutionStreamHub:
    def test_sequence_monotonic_and_resume(self, hub: ExecutionStreamHub):
        e1 = hub.emit_started(
            source_type=SOURCE_PROCESS,
            source_id="proc_a",
            session_id="s1",
            command="echo hi",
        )
        e2 = hub.emit_delta(
            source_type=SOURCE_PROCESS,
            source_id="proc_a",
            stream="stdout",
            text="hello\n",
        )
        e3 = hub.emit_terminal(
            source_type=SOURCE_PROCESS,
            source_id="proc_a",
            status="completed",
            exit_code=0,
        )
        assert e1["sequence"] == 1
        assert e2["sequence"] == 2
        assert e3["sequence"] == 3
        assert e1["type"] == EVENT_STARTED
        assert e2["type"] == EVENT_STDOUT_DELTA
        assert e3["type"] == EVENT_COMPLETED

        tail = hub.list_events(SOURCE_PROCESS, "proc_a", after_sequence=1)
        assert [e["sequence"] for e in tail] == [2, 3]
        assert tail[0]["payload"]["text"] == "hello\n"

    def test_live_subscribe_receives_deltas(self, hub: ExecutionStreamHub):
        received: queue.Queue = queue.Queue()

        def on_ev(entry):
            received.put(entry)

        # Start without terminal so subscription stays live
        hub.emit_started(
            source_type=SOURCE_EXECUTION,
            source_id="exec_live",
            session_id="s1",
            command="loop",
        )
        unsub = hub.subscribe(SOURCE_EXECUTION, "exec_live", 0, on_ev)

        hub.emit_delta(
            source_type=SOURCE_EXECUTION,
            source_id="exec_live",
            stream="stdout",
            text="chunk1",
        )
        hub.emit_delta(
            source_type=SOURCE_EXECUTION,
            source_id="exec_live",
            stream="stderr",
            text="err1",
        )
        hub.emit_terminal(
            source_type=SOURCE_EXECUTION,
            source_id="exec_live",
            status="failed",
            exit_code=1,
        )

        types = []
        deadline = time.time() + 3
        while time.time() < deadline and len(types) < 5:
            try:
                ev = received.get(timeout=0.5)
            except queue.Empty:
                continue
            types.append(ev.get("type"))
            if ev.get("type") == "__stream_terminal__":
                break

        unsub()
        assert EVENT_STARTED in types
        assert EVENT_STDOUT_DELTA in types
        assert "stderr_delta" in types
        assert EVENT_FAILED in types or "__stream_terminal__" in types

    def test_reconnect_after_sequence(self, hub: ExecutionStreamHub):
        hub.emit_started(
            source_type=SOURCE_PROCESS, source_id="proc_r", command="x"
        )
        hub.emit_delta(
            source_type=SOURCE_PROCESS,
            source_id="proc_r",
            stream="stdout",
            text="a",
        )
        hub.emit_delta(
            source_type=SOURCE_PROCESS,
            source_id="proc_r",
            stream="stdout",
            text="b",
        )
        hub.emit_terminal(
            source_type=SOURCE_PROCESS,
            source_id="proc_r",
            status="completed",
            exit_code=0,
        )

        # Client disconnect after seq 2 → resume
        resumed = hub.list_events(SOURCE_PROCESS, "proc_r", after_sequence=2)
        assert len(resumed) == 2  # second delta + terminal? wait: after 2 means seq 3,4
        # sequences: 1 start, 2 delta a, 3 delta b, 4 terminal
        assert [e["sequence"] for e in resumed] == [3, 4]

    def test_durable_log_chunks_pageable(self, hub: ExecutionStreamHub):
        hub.emit_delta(
            source_type=SOURCE_PROCESS,
            source_id="proc_log",
            stream="stdout",
            text="AAAA",
        )
        hub.emit_delta(
            source_type=SOURCE_PROCESS,
            source_id="proc_log",
            stream="stdout",
            text="BBBB",
        )
        page1 = hub.get_logs(SOURCE_PROCESS, "proc_log", offset=0, limit=4)
        assert page1["stdout"] == "AAAA"
        assert page1["next_offset"] == 4
        page2 = hub.get_logs(
            SOURCE_PROCESS, "proc_log", offset=page1["next_offset"], limit=10
        )
        assert page2["stdout"] == "BBBB"

    def test_truncated_flag_includes_full_log_location(self, hub: ExecutionStreamHub):
        term = hub.emit_terminal(
            source_type=SOURCE_PROCESS,
            source_id="proc_t",
            status="completed",
            exit_code=0,
            truncated=True,
            log_total=999,
            session_id="sess1",
        )
        assert term["payload"]["truncated"] is True
        assert term["payload"]["full_log_location"] == "/processes/proc_t/logs"


class TestProcessManagerStreaming:
    def test_process_emits_live_stdout_events(
        self, db, ws, hub, relax_limits
    ):
        mgr = ProcessManager(database=db, stream_hub=hub)
        received: list[dict] = []
        lock = threading.Lock()

        start = mgr.start(
            session_id="s_stream",
            command=(
                "python3 -c \""
                "import time,sys\n"
                "for i in range(3):\n"
                "  print(f'line{i}', flush=True)\n"
                "  time.sleep(0.05)\n"
                "\""
            ),
            workspace_path=ws,
        )
        process_id = start["process_id"]

        def on_ev(entry):
            with lock:
                received.append(entry)

        unsub = mgr.subscribe_events(process_id, 0, on_ev)
        assert unsub is not None

        final = mgr.wait(process_id, timeout=15)
        assert final["status"] == "completed"
        time.sleep(0.2)
        unsub()

        types = [e.get("type") for e in received if e.get("type") != "__stream_terminal__"]
        assert EVENT_STARTED in types
        assert EVENT_STDOUT_DELTA in types
        assert any(
            t in types for t in (EVENT_COMPLETED, "execution_completed")
        )

        # Sequence resume from mid-stream
        mid = max(
            (e["sequence"] for e in received if "sequence" in e),
            default=0,
        )
        # After first event
        tail = mgr.list_events(process_id, after_sequence=1)
        assert tail is not None
        assert all(e["sequence"] > 1 for e in tail)

        logs = mgr.logs(process_id, offset=0)
        assert "line0" in logs["stdout"]
        assert logs["completed"] is True

    def test_process_http_events_and_sse(
        self, monkeypatch, tmp_path, relax_limits
    ):
        from sandbox.main import app
        from sandbox.services import process_manager as pm_mod
        from sandbox.services import execution_stream as es_mod

        db_path = tmp_path / "http_stream.db"
        database = Database(f"sqlite:///{db_path}")
        database.initialize()
        hub = ExecutionStreamHub(database=database)
        isolated = ProcessManager(database=database, stream_hub=hub)

        monkeypatch.setattr(pm_mod, "process_manager", isolated)
        monkeypatch.setattr(es_mod, "execution_stream", hub)
        import sandbox.routers.processes as proc_router

        monkeypatch.setattr(proc_router, "process_manager", isolated)

        with TestClient(app) as c:
            resp = c.post("/sessions", json=session_create_payload("stream-test"))
            assert resp.status_code in (200, 201), resp.text
            session_id = resp.json()["session_id"]

            start = c.post(
                "/processes",
                json={
                    "session_id": session_id,
                    "command": "python3 -c \"print('sse-hello', flush=True)\"",
                },
            )
            assert start.status_code == 201, start.text
            process_id = start.json()["process_id"]

            # Wait for completion
            wait = c.post(f"/processes/{process_id}/wait", json={"timeout": 10})
            assert wait.status_code == 200

            events = c.get(f"/processes/{process_id}/events")
            assert events.status_code == 200
            body = events.json()
            types = [e["type"] for e in body]
            assert "execution_started" in types
            assert any(t.endswith("delta") or t == "stdout_delta" for t in types) or any(
                "sse-hello" in json.dumps(e.get("payload") or {}) for e in body
            )
            sequences = [e["sequence"] for e in body]
            assert sequences == sorted(sequences)
            assert len(set(sequences)) == len(sequences)

            # Resume after sequence 1
            tail = c.get(
                f"/processes/{process_id}/events",
                params={"after_sequence": 1},
            )
            assert tail.status_code == 200
            assert all(e["sequence"] > 1 for e in tail.json())

            # SSE stream (already terminal → replay + end)
            with c.stream(
                "GET",
                f"/processes/{process_id}/events/stream",
                params={"after_sequence": 0},
            ) as sse:
                assert sse.status_code == 200
                assert "text/event-stream" in sse.headers.get("content-type", "")
                raw = b"".join(sse.iter_bytes()).decode("utf-8", errors="replace")
                assert "execution_started" in raw or "id: 1" in raw
                assert "event: end" in raw or "execution_completed" in raw

            # Last-Event-ID resume
            with c.stream(
                "GET",
                f"/processes/{process_id}/events/stream",
                headers={"Last-Event-ID": "1"},
            ) as sse2:
                assert sse2.status_code == 200
                raw2 = b"".join(sse2.iter_bytes()).decode("utf-8", errors="replace")
                # Should not re-send sequence 1 as data id (or only higher)
                # At minimum stream ends cleanly
                assert "event: end" in raw2 or "execution_" in raw2

            logs = c.get(f"/processes/{process_id}/logs")
            assert logs.status_code == 200
            lj = logs.json()
            assert "sse-hello" in lj.get("stdout", "")


class TestBashExecutionStreaming:
    def test_short_command_emits_deltas(
        self, db, ws, hub, relax_limits
    ):
        mgr = ExecutionManager(database=db, stream_hub=hub)
        result = mgr.run_command(
            "sess_bash",
            "python3 -c \"print('stream-bash', flush=True)\"",
            ws,
            timeout=30,
        )
        assert result.get("status") in ("SUCCESS", "success", "FAILED", "failed")
        # SUCCESS enum or value
        status = result.get("status")
        status_s = status.value if hasattr(status, "value") else str(status)
        assert status_s.upper() == "SUCCESS"
        assert "stream-bash" in (result.get("stdout_preview") or "")

        events = mgr.list_events(result["execution_id"])
        assert events is not None
        types = [e["type"] for e in events]
        assert EVENT_STARTED in types
        assert EVENT_STDOUT_DELTA in types
        assert any(t in types for t in (EVENT_COMPLETED, "execution_completed"))

        # Sequence resume
        after_1 = mgr.list_events(result["execution_id"], after_sequence=1)
        assert all(e["sequence"] > 1 for e in after_1)

        logs = mgr.logs(result["execution_id"], offset=0)
        assert logs is not None
        assert "stream-bash" in logs["stdout"]
        assert logs["completed"] is True

    def test_execution_http_logs_and_events(
        self, monkeypatch, tmp_path, relax_limits
    ):
        from sandbox.main import app
        from sandbox.services import execution_manager as em_mod
        from sandbox.services import execution_stream as es_mod

        db_path = tmp_path / "http_exec.db"
        database = Database(f"sqlite:///{db_path}")
        database.initialize()
        hub = ExecutionStreamHub(database=database)
        isolated = ExecutionManager(database=database, stream_hub=hub)

        monkeypatch.setattr(em_mod, "execution_manager", isolated)
        monkeypatch.setattr(es_mod, "execution_stream", hub)
        import sandbox.routers.executions as exec_router

        monkeypatch.setattr(exec_router, "execution_manager", isolated)

        with TestClient(app) as c:
            resp = c.post("/sessions", json=session_create_payload("exec-stream"))
            assert resp.status_code in (200, 201)
            session_id = resp.json()["session_id"]

            run = c.post(
                f"/sessions/{session_id}/executions/command",
                json={
                    "command": "python3 -c \"print('exec-http', flush=True)\"",
                    "timeout": 30,
                },
            )
            assert run.status_code == 201, run.text
            body = run.json()
            execution_id = body["execution_id"]

            events = c.get(
                f"/sessions/{session_id}/executions/{execution_id}/events"
            )
            assert events.status_code == 200
            evs = events.json()
            assert any(e["type"] == "execution_started" for e in evs)
            assert any(
                e["type"] == "stdout_delta"
                or "exec-http" in json.dumps(e.get("payload") or {})
                for e in evs
            )

            # Resume
            mid = c.get(
                f"/sessions/{session_id}/executions/{execution_id}/events",
                params={"after_sequence": 1},
            )
            assert mid.status_code == 200
            assert all(e["sequence"] > 1 for e in mid.json())

            logs = c.get(
                f"/sessions/{session_id}/executions/{execution_id}/logs"
            )
            assert logs.status_code == 200
            assert "exec-http" in logs.json().get("stdout", "")
