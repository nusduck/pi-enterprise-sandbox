"""Formal process orphan recovery after a Sandbox replica restart.

STATUS G7 requires a live Bubblewrap hard-kill gate for full acceptance. These
tests exercise the shipped ``ProcessManager.recover_formal_orphans`` path with
FakeFormalProcessRepository + monkeypatched identity helpers so offline CI
proves TERM→KILL ordering and LOST upsert semantics without Docker.

They also pin the multi-replica invariant, which is the reason recovery is
node-scoped at all: a starting replica must never touch a row belonging to
another replica, or to its own current incarnation.
"""

from __future__ import annotations

from contextlib import contextmanager
from typing import Any

import pytest

from sandbox.app.persistence.repositories.node_repository import NodeRecord
from sandbox.models import ProcessStatus
from sandbox.services.node_registry import node_registry
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

THIS_NODE = "sandbox-0"
OTHER_NODE = "sandbox-1"


class _StubNodeRepository:
    """Hands out a fixed identity so recovery has a node scope to work with."""

    def __init__(self, node_id: str, generation: int) -> None:
        self._record = NodeRecord(
            node_id=node_id,
            address=f"{node_id}:8081",
            status="ACTIVE",
            generation=generation,
        )

    def register(self, conn: Any, *, node_id: str, address: str) -> NodeRecord:
        return self._record


@pytest.fixture
def this_node():
    """Register this process as ``sandbox-0`` generation 5 for the test."""

    class _Conn:
        def commit(self) -> None:
            pass

    @contextmanager
    def conn_factory():
        yield _Conn()

    node_registry.set_repository(
        _StubNodeRepository(THIS_NODE, 5), conn_factory=conn_factory
    )
    node_registry.register(node_id=THIS_NODE, address=f"{THIS_NODE}:8081")
    try:
        yield node_registry.identity
    finally:
        node_registry.reset_for_tests()


def _seed(
    repo: FakeFormalProcessRepository,
    *,
    with_identity: bool = True,
    node_id: str | None = THIS_NODE,
    node_generation: int | None = 4,
    process_id: str = PROCESS,
    status: str = ProcessStatus.RUNNING.value,
) -> None:
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
            "process_id": process_id,
            "org_id": ORG,
            "user_id": USER,
            "sandbox_session_id": SESSION,
            "run_id": RUN,
            "execution_id": EXEC,
            "command_json": command_json,
            "status": status,
            "pid": 4242,
            "started_at": "2026-07-19 01:00:00.000",
            "created_at": "2026-07-19 01:00:00.000",
            "node_id": node_id,
            "node_generation": node_generation,
        },
    )


def _manager(repo: FakeFormalProcessRepository) -> ProcessManager:
    return ProcessManager(
        formal_dual_writer=FormalProcessDualWriter(repo, authoritative=True),
    )


def _capture_signals(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    signals: list[int] = []

    def fake_signal(
        *, pid: int, pgid: int | None, start_identity: str, signum: int
    ) -> dict[str, Any]:
        signals.append(int(signum))
        return {"signaled": True, "reason": "ok"}

    monkeypatch.setattr(
        "sandbox.services.process_orphan_recovery.safe_signal_identity", fake_signal
    )
    monkeypatch.setattr(
        "sandbox.services.process_orphan_recovery.identity_matches",
        lambda pid, start_identity: True,
    )
    return signals


def _forbid_signals(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "sandbox.services.process_orphan_recovery.safe_signal_identity",
        lambda **_k: (_ for _ in ()).throw(AssertionError("must not signal")),
    )


def test_terms_then_kills_and_marks_lost(monkeypatch, this_node) -> None:
    signals = _capture_signals(monkeypatch)
    repo = FakeFormalProcessRepository()
    _seed(repo)

    recovered = _manager(repo).recover_formal_orphans()

    assert recovered == 1
    assert signals == [15, 9, 15, 9]  # namespace init, then outer wrapper
    row = repo.rows[PROCESS]
    assert str(row["status"]).lower() == "lost"
    assert row["exit_code"] == -15


def test_without_start_identity_does_not_signal(monkeypatch, this_node) -> None:
    signals: list[int] = []
    monkeypatch.setattr(
        "sandbox.services.process_orphan_recovery.safe_signal_identity",
        lambda **_k: (signals.append(1), {"signaled": True})[1],
    )
    monkeypatch.setattr(
        "sandbox.services.process_orphan_recovery.process_alive", lambda pid: True
    )
    repo = FakeFormalProcessRepository()
    _seed(repo, with_identity=False)

    recovered = _manager(repo).recover_formal_orphans()

    assert recovered == 1
    assert signals == []
    row = repo.rows[PROCESS]
    assert str(row["status"]).lower() == "lost"
    assert row["exit_code"] == -1


def test_skips_terminal_rows(monkeypatch, this_node) -> None:
    _forbid_signals(monkeypatch)
    repo = FakeFormalProcessRepository()
    _seed(repo, status=ProcessStatus.COMPLETED.value)

    assert _manager(repo).recover_formal_orphans() == 0


# ── Multi-replica invariants ────────────────────────────────────────────


def test_never_touches_another_replicas_running_process(monkeypatch, this_node) -> None:
    """The regression this whole design exists to prevent.

    With a global scan, every starting replica marked every other replica's live
    processes as LOST, so rolling N pods killed running work N times over.
    """
    _forbid_signals(monkeypatch)
    repo = FakeFormalProcessRepository()
    _seed(repo, node_id=OTHER_NODE, node_generation=9)

    recovered = _manager(repo).recover_formal_orphans()

    assert recovered == 0
    assert str(repo.rows[PROCESS]["status"]).lower() == "running", (
        "another replica's row must be left exactly as it was"
    )


def test_never_reaps_its_own_current_generation(monkeypatch, this_node) -> None:
    """Rows from the incarnation that is running right now are live work."""
    _forbid_signals(monkeypatch)
    repo = FakeFormalProcessRepository()
    _seed(repo, node_id=THIS_NODE, node_generation=5)  # == current generation

    assert _manager(repo).recover_formal_orphans() == 0
    assert str(repo.rows[PROCESS]["status"]).lower() == "running"


def test_recovers_only_its_own_stale_rows_in_a_mixed_table(monkeypatch, this_node) -> None:
    signals = _capture_signals(monkeypatch)
    repo = FakeFormalProcessRepository()
    mine_stale = PROCESS
    mine_current = "01K0G2PAV8FPMVC9QHJG7JPN62"
    theirs = "01K0G2PAV8FPMVC9QHJG7JPN63"
    _seed(repo, process_id=mine_stale, node_id=THIS_NODE, node_generation=4)
    _seed(repo, process_id=mine_current, node_id=THIS_NODE, node_generation=5)
    _seed(repo, process_id=theirs, node_id=OTHER_NODE, node_generation=2)

    recovered = _manager(repo).recover_formal_orphans()

    assert recovered == 1
    assert signals == [15, 9, 15, 9]
    assert str(repo.rows[mine_stale]["status"]).lower() == "lost"
    assert str(repo.rows[mine_current]["status"]).lower() == "running"
    assert str(repo.rows[theirs]["status"]).lower() == "running"


def test_unattributed_row_is_closed_out_but_never_signaled(monkeypatch, this_node) -> None:
    """A PID with no verified owner may name an unrelated process by now."""
    _forbid_signals(monkeypatch)
    repo = FakeFormalProcessRepository()
    _seed(repo, node_id=None, node_generation=None)

    recovered = _manager(repo).recover_formal_orphans()

    assert recovered == 1
    row = repo.rows[PROCESS]
    assert str(row["status"]).lower() == "lost"
    assert row["exit_code"] == -1  # -1, not -SIGTERM: nothing was signalled


def test_recovery_preserves_original_node_attribution(monkeypatch, this_node) -> None:
    """Restamping history would confuse the *next* restart about who ran it."""
    _capture_signals(monkeypatch)
    repo = FakeFormalProcessRepository()
    _seed(repo, node_id=THIS_NODE, node_generation=4)

    _manager(repo).recover_formal_orphans()

    row = repo.rows[PROCESS]
    assert row["node_id"] == THIS_NODE
    assert row["node_generation"] == 4


def test_without_a_node_identity_recovery_is_a_no_op(monkeypatch) -> None:
    """No identity means no safe scope — do nothing rather than sweep globally."""
    _forbid_signals(monkeypatch)
    node_registry.reset_for_tests()
    repo = FakeFormalProcessRepository()
    _seed(repo)

    assert _manager(repo).recover_formal_orphans() == 0
    assert str(repo.rows[PROCESS]["status"]).lower() == "running"
