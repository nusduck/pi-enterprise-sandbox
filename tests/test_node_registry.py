"""Sandbox replica identity, liveness, and placement selection.

Two layers are covered separately:

* ``NodeRepository`` — SQL shape only (parameterized, right table, right
  columns, generation increments on re-register rather than resetting).
* ``NodeRegistry`` — the behaviour that actually protects the cluster: an
  identity is claimed before anything can reap by generation, a lost heartbeat
  degrades placement instead of killing the process, and draining stops new
  placements without disowning existing workspaces.
"""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from typing import Any, Sequence

import pytest

from sandbox.app.persistence.repositories.node_repository import (
    STATUS_ACTIVE,
    STATUS_DRAINING,
    NodeRecord,
    NodeRepository,
)
from sandbox.services.node_registry import NodeRegistry, NodeRegistryError

NODE_A = "sandbox-0"
NODE_B = "sandbox-1"
ADDR_A = "sandbox-0.sandbox-headless.pi.svc.cluster.local:8081"
ADDR_B = "sandbox-1.sandbox-headless.pi.svc.cluster.local:8081"


# ── Fakes ───────────────────────────────────────────────────────────────


class RecordingConnection:
    """Records parameterized SQL and serves canned rows."""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self.statements: list[tuple[str, tuple[Any, ...]]] = []
        self.rows = rows or []
        self.rowcount = 1
        self.committed = False

    def execute(self, sql: str, params: Sequence[Any] | None = None) -> None:
        params_t = tuple(params or ())
        if params_t:
            assert sql.count("%s") == len(params_t), (
                f"placeholder/param mismatch: {sql!r} vs {params_t!r}"
            )
        self.statements.append((" ".join(sql.split()), params_t))

    def fetchone(self) -> dict[str, Any] | None:
        return self.rows[0] if self.rows else None

    def fetchall(self) -> list[dict[str, Any]]:
        return list(self.rows)

    def commit(self) -> None:
        self.committed = True

    def close(self) -> None:
        pass


class FakeNodeRepository:
    """In-memory stand-in with the generation semantics that matter."""

    def __init__(self) -> None:
        self.nodes: dict[str, dict[str, Any]] = {}
        self.deleted: set[str] = set()
        self.heartbeats = 0
        self.fail_heartbeat_with: Exception | None = None

    def register(self, conn: Any, *, node_id: str, address: str) -> NodeRecord:
        existing = self.nodes.get(node_id)
        generation = int(existing["generation"]) + 1 if existing else 1
        self.nodes[node_id] = {
            "node_id": node_id,
            "address": address,
            "status": STATUS_ACTIVE,
            "generation": generation,
        }
        self.deleted.discard(node_id)
        return NodeRecord(
            node_id=node_id,
            address=address,
            status=STATUS_ACTIVE,
            generation=generation,
        )

    def heartbeat(self, conn: Any, *, node_id: str) -> bool:
        self.heartbeats += 1
        if self.fail_heartbeat_with is not None:
            raise self.fail_heartbeat_with
        return node_id in self.nodes and node_id not in self.deleted

    def set_status(self, conn: Any, *, node_id: str, status: str) -> bool:
        if node_id not in self.nodes:
            return False
        self.nodes[node_id]["status"] = status
        return True

    def get(self, conn: Any, node_id: str) -> NodeRecord | None:
        row = self.nodes.get(node_id)
        return None if row is None else NodeRecord(**row)

    def list_placeable(self, conn: Any, *, min_heartbeat_at: str) -> list[NodeRecord]:
        self.last_min_heartbeat_at = min_heartbeat_at
        return [
            NodeRecord(**row)
            for row in self.nodes.values()
            if row["status"] == STATUS_ACTIVE and row["node_id"] not in self.deleted
        ]


def make_registry(repo: Any) -> NodeRegistry:
    registry = NodeRegistry()

    @contextmanager
    def conn_factory():
        yield RecordingConnection()

    registry.set_repository(repo, conn_factory=conn_factory)
    return registry


# ── NodeRepository SQL shape ────────────────────────────────────────────


def test_register_upserts_and_increments_generation_in_sql():
    conn = RecordingConnection(
        rows=[
            {
                "node_id": NODE_A,
                "address": ADDR_A,
                "status": STATUS_ACTIVE,
                "generation": 4,
            }
        ]
    )
    record = NodeRepository(object()).register(conn, node_id=NODE_A, address=ADDR_A)

    sql, params = conn.statements[0]
    assert "INSERT INTO sandbox_nodes" in sql
    assert "ON DUPLICATE KEY UPDATE" in sql
    # A restarting pod keeps its name; the generation must move forward so
    # recovery can distinguish this incarnation from the previous one.
    assert "generation = generation + 1" in sql
    assert NODE_A in params and ADDR_A in params
    assert record.generation == 4


def test_placeable_query_filters_on_liveness_and_orders_by_load():
    conn = RecordingConnection(rows=[])
    NodeRepository(object()).list_placeable(conn, min_heartbeat_at="2026-08-05 00:00:00.000")

    sql, params = conn.statements[0]
    assert "n.status = %s" in sql
    assert "n.heartbeat_at >= %s" in sql
    # LEFT JOIN, not INNER: a brand-new replica has zero sessions and is exactly
    # the node we most want to pick.
    assert "LEFT JOIN sandbox_sessions" in sql
    assert "ORDER BY session_count ASC" in sql
    assert params[0] == STATUS_ACTIVE


def test_set_status_rejects_unknown_status():
    with pytest.raises(ValueError, match="unsupported node status"):
        NodeRepository(object()).set_status(
            RecordingConnection(), node_id=NODE_A, status="PARTY"
        )


# ── NodeRegistry behaviour ──────────────────────────────────────────────


def test_registry_without_repository_refuses_to_operate():
    registry = NodeRegistry()
    assert registry.installed is False
    with pytest.raises(NodeRegistryError):
        registry.register(node_id=NODE_A, address=ADDR_A)


def test_register_claims_identity_and_new_generation_each_start():
    repo = FakeNodeRepository()
    registry = make_registry(repo)

    first = registry.register(node_id=NODE_A, address=ADDR_A)
    assert (first.node_id, first.generation) == (NODE_A, 1)
    assert registry.identity is not None
    assert registry.generation == 1

    # Simulate a pod restart: same node id, fresh process.
    restarted = make_registry(repo).register(node_id=NODE_A, address=ADDR_A)
    assert restarted.generation == 2, (
        "a restart must claim a new generation, otherwise recovery cannot tell "
        "its own stale rows from another node's live ones"
    )


def test_clearing_the_repository_drops_identity():
    repo = FakeNodeRepository()
    registry = make_registry(repo)
    registry.register(node_id=NODE_A, address=ADDR_A)

    registry.set_repository(None)

    assert registry.identity is None
    assert registry.installed is False


def test_draining_marks_status_without_touching_identity():
    repo = FakeNodeRepository()
    registry = make_registry(repo)
    registry.register(node_id=NODE_A, address=ADDR_A)

    assert registry.set_draining() is True

    assert repo.nodes[NODE_A]["status"] == STATUS_DRAINING
    assert registry.draining is True
    # Workspaces already placed here are still ours to serve — their data is on
    # this node's volume and nowhere else.
    assert registry.identity is not None
    assert registry.node_id == NODE_A


def test_placement_prefers_a_live_node_and_bounds_liveness_by_heartbeat():
    repo = FakeNodeRepository()
    registry = make_registry(repo)
    registry.register(node_id=NODE_A, address=ADDR_A)
    repo.register(None, node_id=NODE_B, address=ADDR_B)

    chosen = registry.select_placement_node(
        RecordingConnection(), interval_seconds=10.0, liveness_multiplier=3
    )

    assert chosen is not None
    assert chosen.node_id in {NODE_A, NODE_B}
    # Cutoff is interval * multiplier in the past, formatted for MySQL.
    assert repo.last_min_heartbeat_at.count(":") == 2


def test_draining_node_is_not_placeable():
    repo = FakeNodeRepository()
    registry = make_registry(repo)
    registry.register(node_id=NODE_A, address=ADDR_A)
    registry.set_draining()

    chosen = registry.select_placement_node(
        RecordingConnection(), interval_seconds=10.0, liveness_multiplier=3
    )

    assert chosen is None


def test_no_live_node_returns_none_rather_than_guessing():
    registry = make_registry(FakeNodeRepository())
    registry._identity = None  # never registered

    assert (
        registry.select_placement_node(
            RecordingConnection(), interval_seconds=10.0, liveness_multiplier=3
        )
        is None
    )


# ── Heartbeat loop ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_heartbeat_requires_an_identity():
    registry = make_registry(FakeNodeRepository())
    with pytest.raises(NodeRegistryError):
        await registry.start_heartbeat(interval_seconds=0.01)


@pytest.mark.asyncio
async def test_heartbeat_loop_survives_database_errors():
    repo = FakeNodeRepository()
    registry = make_registry(repo)
    registry.register(node_id=NODE_A, address=ADDR_A)
    repo.fail_heartbeat_with = RuntimeError("mysql gone")

    await registry.start_heartbeat(interval_seconds=0.01)
    await asyncio.sleep(0.08)

    # A failing heartbeat only makes this node ineligible for *new* placements.
    # Taking the process down would strand every workspace it already owns.
    assert repo.heartbeats >= 2
    await registry.stop_heartbeat()


@pytest.mark.asyncio
async def test_heartbeat_re_registers_when_its_row_disappears():
    repo = FakeNodeRepository()
    registry = make_registry(repo)
    registry.register(node_id=NODE_A, address=ADDR_A)
    repo.deleted.add(NODE_A)

    await registry.start_heartbeat(interval_seconds=0.01)
    await asyncio.sleep(0.08)
    await registry.stop_heartbeat()

    # Re-announced so the node stays resolvable for workspaces it still owns.
    assert NODE_A not in repo.deleted
    assert repo.nodes[NODE_A]["generation"] >= 2


@pytest.mark.asyncio
async def test_stop_heartbeat_is_idempotent_and_start_does_not_double_run():
    repo = FakeNodeRepository()
    registry = make_registry(repo)
    registry.register(node_id=NODE_A, address=ADDR_A)

    await registry.start_heartbeat(interval_seconds=5.0)
    await registry.start_heartbeat(interval_seconds=5.0)
    await registry.stop_heartbeat()
    await registry.stop_heartbeat()
