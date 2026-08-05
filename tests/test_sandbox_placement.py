"""Workspace placement: assignment at ensure, and the guard on every other route.

A workspace is a directory on exactly one replica's volume. These tests pin the
two halves of that contract:

* ``sessions/ensure`` is the only route any replica may serve, so it is where a
  workspace gets bound to a replica — once, by compare-and-set.
* every other workspace-bound route refuses work it does not own, with a 409
  naming the owner, because the alternative is silent success on empty data.
"""

from __future__ import annotations

import dataclasses
from contextlib import contextmanager
from typing import Any

import pytest
from fastapi import HTTPException

from sandbox.app.domain.types import OwnerScope, SandboxSessionRecord
from sandbox.app.persistence.repositories.node_repository import NodeRecord
from sandbox.services.formal_session_runtime import (
    FormalSessionRuntime,
    SessionProvisioningError,
)
from sandbox.services.node_registry import node_registry
from sandbox.services.placement_guard import (
    PLACEMENT_MISMATCH_CODE,
    PlacementMismatch,
    check_placement,
    require_local_artifact_storage,
    require_local_placement,
)

ORG = "01K0G2PAV8FPMVC9QHJG7JPN50"
USER = "01K0G2PAV8FPMVC9QHJG7JPN51"
CONV = "01K0G2PAV8FPMVC9QHJG7JPN52"
AGENT_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN53"
SANDBOX_SESSION = "01K0G2PAV8FPMVC9QHJG7JPN54"
WORKSPACE = "01K0G2PAV8FPMVC9QHJG7JPN55"

NODE_A = "sandbox-0"
NODE_B = "sandbox-1"
ADDR_A = "sandbox-0.sandbox-headless.pi.svc.cluster.local:8081"
ADDR_B = "sandbox-1.sandbox-headless.pi.svc.cluster.local:8081"


# ── Fakes ───────────────────────────────────────────────────────────────


class FakeNodeRepository:
    def __init__(self, *, local: str, placeable: list[tuple[str, str]]) -> None:
        self.local = local
        self.records = {
            node_id: NodeRecord(
                node_id=node_id, address=address, status="ACTIVE", generation=1
            )
            for node_id, address in placeable
        }
        self.placeable = [self.records[node_id] for node_id, _ in placeable]

    def register(self, conn: Any, *, node_id: str, address: str) -> NodeRecord:
        return self.records.setdefault(
            node_id,
            NodeRecord(node_id=node_id, address=address, status="ACTIVE", generation=1),
        )

    def get(self, conn: Any, node_id: str) -> NodeRecord | None:
        return self.records.get(node_id)

    def list_placeable(self, conn: Any, *, min_heartbeat_at: str) -> list[NodeRecord]:
        return list(self.placeable)


class Conn:
    def __init__(self) -> None:
        self.commits = 0
        self.statements: list[str] = []

    def execute(self, sql: str, params: Any = None) -> None:
        self.statements.append(" ".join(sql.split()))

    def fetchone(self) -> dict[str, Any] | None:
        return {"conversation_id": CONV, "last_run_id": None}

    def fetchall(self) -> list[dict[str, Any]]:
        return []

    def commit(self) -> None:
        self.commits += 1

    def close(self) -> None:
        pass


class Db:
    def __init__(self, conn: Conn) -> None:
        self._conn = conn

    @contextmanager
    def connection(self):
        yield self._conn


class Repo:
    """Session repository with just enough behaviour to place a session."""

    def __init__(self, record: SandboxSessionRecord | None = None) -> None:
        self.record = record
        self.assignments: list[str] = []

    def _match(self, scope: OwnerScope | dict[str, str]) -> SandboxSessionRecord | None:
        return self.record

    def get_by_id(self, conn, sandbox_session_id, scope):
        if self.record is None or self.record.sandbox_session_id != sandbox_session_id:
            return None
        return self.record

    def get_by_agent_session_id(self, conn, agent_session_id, scope):
        return self.record

    def get_by_workspace_id(self, conn, workspace_id, scope):
        return self.record

    def create(self, conn, input):
        self.record = SandboxSessionRecord(
            sandbox_session_id=input["sandbox_session_id"],
            org_id=input["org_id"],
            user_id=input["user_id"],
            agent_session_id=input["agent_session_id"],
            workspace_id=input["workspace_id"],
            status=input["status"],
            created_at="2026-08-05 00:00:00.000",
            updated_at="2026-08-05 00:00:00.000",
            node_id=input.get("node_id"),
        )
        return self.record

    def require_by_id(self, conn, sandbox_session_id, scope):
        assert self.record is not None
        return self.record

    def assign_node(self, conn, sandbox_session_id, scope, *, node_id):
        self.assignments.append(node_id)
        assert self.record is not None
        # Mirror the compare-and-set: only an unplaced row is claimed.
        if self.record.node_id is None:
            self.record = dataclasses.replace(self.record, node_id=node_id)
        return self.record


def _claims() -> dict[str, Any]:
    return {
        "org_id": ORG,
        "user_id": USER,
        "conversation_id": CONV,
        "agent_session_id": AGENT_SESSION,
        "sandbox_session_id": SANDBOX_SESSION,
    }


@contextmanager
def registered(local: str, placeable: list[tuple[str, str]]):
    """Install a node registry whose identity is ``local``."""

    class _RegConn:
        def commit(self) -> None:
            pass

    @contextmanager
    def conn_factory():
        yield _RegConn()

    repo = FakeNodeRepository(local=local, placeable=placeable)
    node_registry.set_repository(repo, conn_factory=conn_factory)
    node_registry.register(node_id=local, address=dict(placeable).get(local, ""))
    try:
        yield repo
    finally:
        node_registry.reset_for_tests()


def _runtime(conn: Conn, repo: Repo) -> FormalSessionRuntime:
    return FormalSessionRuntime(db=Db(conn), repository=repo)  # type: ignore[arg-type]


# ── Placement assignment ────────────────────────────────────────────────


def test_ensure_places_a_new_session_and_creates_the_workspace(monkeypatch) -> None:
    initialized: list[str] = []
    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.workspace_manager.init_workspace",
        initialized.append,
    )
    conn, repo = Conn(), Repo()
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        record = _runtime(conn, repo).ensure(
            claims=_claims(), workspace_id=WORKSPACE
        )

    assert record.node_id == NODE_A
    assert repo.assignments == [NODE_A]
    assert initialized == [WORKSPACE], "the owner creates the directory"


def test_ensure_on_a_non_owner_returns_the_owner_without_creating_anything(
    monkeypatch,
) -> None:
    """A duplicate empty directory on the wrong volume is worse than a redirect."""
    initialized: list[str] = []
    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.workspace_manager.init_workspace",
        initialized.append,
    )
    conn, repo = Conn(), Repo()
    # This replica is sandbox-0, but only sandbox-1 is placeable.
    with registered(NODE_A, [(NODE_B, ADDR_B)]):
        runtime = _runtime(conn, repo)
        record = runtime.ensure(claims=_claims(), workspace_id=WORKSPACE)
        placement = runtime.describe_placement(record)

    assert record.node_id == NODE_B
    assert initialized == []
    assert placement == {
        "nodeId": NODE_B,
        "nodeAddress": ADDR_B,
        "placedElsewhere": True,
    }


def test_ensure_keeps_an_existing_placement(monkeypatch) -> None:
    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.workspace_manager.init_workspace",
        lambda _w: None,
    )
    placed = SandboxSessionRecord(
        sandbox_session_id=SANDBOX_SESSION,
        org_id=ORG,
        user_id=USER,
        agent_session_id=AGENT_SESSION,
        workspace_id=WORKSPACE,
        status="ACTIVE",
        created_at="2026-08-05 00:00:00.000",
        updated_at="2026-08-05 00:00:00.000",
        node_id=NODE_B,
    )
    conn, repo = Conn(), Repo(placed)
    with registered(NODE_A, [(NODE_A, ADDR_A), (NODE_B, ADDR_B)]):
        record = _runtime(conn, repo).ensure(
            claims=_claims(), workspace_id=WORKSPACE
        )

    assert record.node_id == NODE_B
    assert repo.assignments == [], (
        "a placed workspace is never re-placed: its data only exists on the "
        "replica that already owns it"
    )


def test_ensure_fails_retryably_when_no_replica_can_take_work(monkeypatch) -> None:
    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.workspace_manager.init_workspace",
        lambda _w: None,
    )
    conn, repo = Conn(), Repo()
    with registered(NODE_A, []):  # everything draining or heartbeat-expired
        with pytest.raises(SessionProvisioningError) as excinfo:
            _runtime(conn, repo).ensure(claims=_claims(), workspace_id=WORKSPACE)

    assert excinfo.value.code == "NO_PLACEABLE_NODE"
    assert excinfo.value.status == 503


def test_single_process_runtime_does_not_place(monkeypatch) -> None:
    """Without a registry there is one replica, so placement is meaningless."""
    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.workspace_manager.init_workspace",
        lambda _w: None,
    )
    node_registry.reset_for_tests()
    conn, repo = Conn(), Repo()

    record = _runtime(conn, repo).ensure(claims=_claims(), workspace_id=WORKSPACE)

    assert record.node_id is None
    assert repo.assignments == []


# ── Placement guard ─────────────────────────────────────────────────────


class _App:
    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    @property
    def state(self):  # pragma: no cover — accessed via get_formal_session_runtime
        return self


def _guard_app(monkeypatch, placement: tuple[str | None, str | None] | None):
    class Runtime:
        def resolve_placement(self, sandbox_session_id, *, org_id, user_id):
            return placement

    monkeypatch.setattr(
        "sandbox.services.formal_session_runtime.get_formal_session_runtime",
        lambda _app: Runtime(),
    )
    return object()


def test_guard_allows_the_owner(monkeypatch) -> None:
    app = _guard_app(monkeypatch, (NODE_A, ADDR_A))
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        check_placement(app, _claims())  # no raise


def test_guard_rejects_a_workspace_owned_elsewhere(monkeypatch) -> None:
    app = _guard_app(monkeypatch, (NODE_B, ADDR_B))
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        with pytest.raises(PlacementMismatch) as excinfo:
            check_placement(app, _claims())

    detail = excinfo.value.to_detail()
    assert detail["code"] == PLACEMENT_MISMATCH_CODE
    assert detail["ownerNodeId"] == NODE_B
    assert detail["ownerAddress"] == ADDR_B


def test_guard_surfaces_409_with_routing_information(monkeypatch) -> None:
    app = _guard_app(monkeypatch, (NODE_B, ADDR_B))
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        with pytest.raises(HTTPException) as excinfo:
            require_local_placement(app, _claims())

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail["ownerNodeId"] == NODE_B


def test_guard_treats_an_unknown_session_like_a_mismatch(monkeypatch) -> None:
    """Routing must not become a way to probe for other tenants' sessions."""
    app = _guard_app(monkeypatch, None)
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        with pytest.raises(PlacementMismatch) as excinfo:
            check_placement(app, _claims())

    assert excinfo.value.owner_node_id is None


def test_guard_stands_down_without_a_node_identity(monkeypatch) -> None:
    app = _guard_app(monkeypatch, (NODE_B, ADDR_B))
    node_registry.reset_for_tests()

    check_placement(app, _claims())  # single-process runtime: no raise


def test_guard_fails_closed_on_a_claim_with_no_session(monkeypatch) -> None:
    app = _guard_app(monkeypatch, (NODE_A, ADDR_A))
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        with pytest.raises(PlacementMismatch):
            check_placement(app, {"org_id": ORG, "user_id": USER})


# ── Artifact storage routing ────────────────────────────────────────────


class _Artifact:
    def __init__(self, storage_node_id: str | None) -> None:
        self.artifact_id = "01K0G2PAV8FPMVC9QHJG7JPN70"
        self.storage_node_id = storage_node_id


def test_artifact_download_allowed_on_the_storing_replica() -> None:
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        require_local_artifact_storage(_Artifact(NODE_A))  # no raise


def test_artifact_download_rejected_when_bytes_live_elsewhere() -> None:
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        with pytest.raises(HTTPException) as excinfo:
            require_local_artifact_storage(_Artifact(NODE_B))

    assert excinfo.value.status_code == 409
    assert excinfo.value.detail["ownerNodeId"] == NODE_B


def test_unstamped_artifact_is_served_optimistically() -> None:
    """Refusing would make pre-placement deliverables permanently unreachable."""
    with registered(NODE_A, [(NODE_A, ADDR_A)]):
        require_local_artifact_storage(_Artifact(None))  # no raise
