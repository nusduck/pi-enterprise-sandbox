"""Unit coverage for formal process orphan recovery after service restart.

STATUS G7 requires a live Bubblewrap hard-kill gate for full acceptance.
These tests exercise the shipped ``ProcessManager.recover_formal_orphans``
path with FakeFormalProcessRepository + monkeypatched identity helpers so
offline CI proves TERM→KILL ordering and LOST upsert semantics without Docker.
"""

from __future__ import annotations

from typing import Any

import pytest

from sandbox.models import ProcessStatus
from sandbox.services.process_handle_store import (
    FakeFormalProcessRepository,
    FormalProcessDualWriter,
)
from sandbox.services.process_manager import ProcessManager


ORG = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER = "01K0G2PAV8FPMVC9QHJG7JPN51"
SESSION = "01K0G2PAV8FPMVC9QHJG7JPN52"
RUN = "01K0G2PAV8FPMVC9QHJG7JPN53"
PROCESS = "01K0G2PAV8FPMVC9QHJG7JPN60"
EXEC = "01K0G2PAV8FPMVC9QHJG7JPN61"
IDENTITY = "linux-starttime:987654321"


def _seed_running(repo: FakeFormalProcessRepository, *, with_identity: bool = True) -> None:
    command_json: dict[str, Any] = {
        "command": "sleep 120 # hardkill-orphan-process",
        "cwd": "/home/sandbox/workspace",
        "pgid": 4242,
        "timeout_seconds": 180,
        "background": True,
    }
    if with_identity:
        command_json["start_identity"] = IDENTITY
        command_json["namespace_pid"] = 4343
        command_json["namespace_pgid"] = 4343
        command_json["namespace_start_identity"] = "linux-starttime:namespace"
    repo.create(
        None,
        {
            "process_id": PROCESS,
            "org_id": ORG,
            "user_id": USER,
            "sandbox_session_id": SESSION,
            "run_id": RUN,
            "execution_id": EXEC,
            "command_json": command_json,
            "status": ProcessStatus.RUNNING.value,
            "pid": 4242,
            "started_at": "2026-07-19 01:00:00.000",
            "created_at": "2026-07-19 01:00:00.000",
        },
    )


def test_recover_formal_orphans_terms_then_kills_and_marks_lost(monkeypatch: pytest.MonkeyPatch) -> None:
    signals: list[int] = []

    def fake_signal(*, pid: int, pgid: int | None, start_identity: str, signum: int) -> dict[str, Any]:
        assert pid in {4242, 4343}
        assert pgid in {None, 4242}
        assert start_identity in {IDENTITY, "linux-starttime:namespace"}
        signals.append(int(signum))
        return {"signaled": True, "reason": "ok"}

    # After SIGTERM, identity still matches so recovery escalates to SIGKILL.
    monkeypatch.setattr(
        "sandbox.services.process_manager.safe_signal_identity",
        fake_signal,
    )
    monkeypatch.setattr(
        "sandbox.services.process_manager.identity_matches",
        lambda pid, start_identity: True,
    )

    repo = FakeFormalProcessRepository()
    _seed_running(repo)
    manager = ProcessManager(
        formal_dual_writer=FormalProcessDualWriter(repo, authoritative=True),
    )

    recovered = manager.recover_formal_orphans()
    assert recovered == 1
    assert signals == [15, 9, 15, 9]  # namespace init, then outer wrapper

    row = repo.rows[PROCESS]
    assert str(row["status"]).lower() == "lost"
    assert row["exit_code"] == -15


def test_recover_formal_orphans_without_identity_does_not_signal(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signals: list[int] = []

    def boom(**_kwargs: Any) -> dict[str, Any]:
        signals.append(1)
        return {"signaled": True}

    monkeypatch.setattr("sandbox.services.process_manager.safe_signal_identity", boom)
    monkeypatch.setattr(
        "sandbox.services.process_manager.process_alive",
        lambda pid: True,
    )

    repo = FakeFormalProcessRepository()
    _seed_running(repo, with_identity=False)
    manager = ProcessManager(
        formal_dual_writer=FormalProcessDualWriter(repo, authoritative=True),
    )

    recovered = manager.recover_formal_orphans()
    assert recovered == 1
    assert signals == []
    row = repo.rows[PROCESS]
    assert str(row["status"]).lower() == "lost"
    assert row["exit_code"] == -1


def test_recover_formal_orphans_skips_terminal_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "sandbox.services.process_manager.safe_signal_identity",
        lambda **_k: (_ for _ in ()).throw(AssertionError("must not signal")),
    )
    repo = FakeFormalProcessRepository()
    repo.create(
        None,
        {
            "process_id": PROCESS,
            "org_id": ORG,
            "user_id": USER,
            "sandbox_session_id": SESSION,
            "run_id": RUN,
            "execution_id": EXEC,
            "command_json": {"command": "done", "start_identity": IDENTITY},
            "status": ProcessStatus.COMPLETED.value,
            "pid": 1,
            "created_at": "2026-07-19 01:00:00.000",
        },
    )
    manager = ProcessManager(
        formal_dual_writer=FormalProcessDualWriter(repo, authoritative=True),
    )
    assert manager.recover_formal_orphans() == 0
