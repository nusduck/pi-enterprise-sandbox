"""Sandbox node registry — table ``sandbox_nodes`` (placement migration).

Unlike every other Sandbox repository, this one is deliberately **not** owner
scoped: node rows describe infrastructure, not tenant data, and the placement
decision has to consider every replica regardless of who is asking.

The registry answers exactly two questions:

* which replica owns a given workspace (resolved through
  ``sandbox_sessions.node_id``, then translated to an address here), and
* which replicas are eligible to receive a *new* workspace right now.

Liveness is advisory. A stale heartbeat only stops new placements; sessions
already bound to that node keep being served by it, because its local volume is
the only place their workspace exists.
"""

from __future__ import annotations

from typing import Any

from sandbox.app.persistence.mappers import to_mysql_datetime
from sandbox.app.persistence.repositories._base import SupportsExecute, require_db
from sandbox.app.persistence.schema_gap import is_table_present

TABLE = "sandbox_nodes"
assert is_table_present(TABLE)

STATUS_ACTIVE = "ACTIVE"
STATUS_DRAINING = "DRAINING"
STATUS_GONE = "GONE"

#: Statuses that may receive newly created workspaces.
PLACEABLE_STATUSES: tuple[str, ...] = (STATUS_ACTIVE,)


class NodeRecord:
    """One Sandbox replica as recorded in the registry."""

    __slots__ = (
        "node_id",
        "address",
        "status",
        "generation",
        "started_at",
        "heartbeat_at",
    )

    def __init__(
        self,
        *,
        node_id: str,
        address: str,
        status: str,
        generation: int,
        started_at: Any = None,
        heartbeat_at: Any = None,
    ) -> None:
        self.node_id = node_id
        self.address = address
        self.status = status
        self.generation = generation
        self.started_at = started_at
        self.heartbeat_at = heartbeat_at

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodeId": self.node_id,
            "address": self.address,
            "status": self.status,
            "generation": self.generation,
        }

    def __repr__(self) -> str:  # pragma: no cover — diagnostics only
        return (
            f"NodeRecord(node_id={self.node_id!r}, status={self.status!r}, "
            f"generation={self.generation!r})"
        )


def map_node(row: dict[str, Any]) -> NodeRecord:
    return NodeRecord(
        node_id=str(row["node_id"]),
        address=str(row["address"]),
        status=str(row["status"]),
        generation=int(row["generation"]),
        started_at=row.get("started_at"),
        heartbeat_at=row.get("heartbeat_at"),
    )


class NodeRepository:
    """Registry reads/writes for Sandbox replicas."""

    def __init__(self, db: Any) -> None:
        self.db = require_db(db, "NodeRepository")

    # ── registration ────────────────────────────────────────────────

    def register(
        self,
        conn: SupportsExecute,
        *,
        node_id: str,
        address: str,
    ) -> NodeRecord:
        """Announce this replica and claim the next generation.

        The generation increments on every process start. Orphan recovery uses
        it to tell rows left by *this node's previous incarnation* (reapable)
        from rows this incarnation is currently serving (never touched).
        Re-registering a node id is normal: pods restart and keep their name.
        """
        now = to_mysql_datetime()
        conn.execute(
            f"""
            INSERT INTO {TABLE} (
                node_id, address, status, generation,
                started_at, heartbeat_at, created_at, updated_at
            ) VALUES (%s, %s, %s, 1, %s, %s, %s, %s)
            ON DUPLICATE KEY UPDATE
                address = VALUES(address),
                status = VALUES(status),
                generation = generation + 1,
                started_at = VALUES(started_at),
                heartbeat_at = VALUES(heartbeat_at),
                updated_at = VALUES(updated_at)
            """,
            (node_id, address, STATUS_ACTIVE, now, now, now, now),
        )
        record = self.get(conn, node_id)
        if record is None:  # pragma: no cover — insert just succeeded
            raise RuntimeError(f"node {node_id} missing immediately after register")
        return record

    def heartbeat(self, conn: SupportsExecute, *, node_id: str) -> bool:
        """Refresh liveness. Returns False when the row has been removed."""
        now = to_mysql_datetime()
        conn.execute(
            f"""
            UPDATE {TABLE}
            SET heartbeat_at = %s, updated_at = %s
            WHERE node_id = %s
            """,
            (now, now, node_id),
        )
        return int(getattr(conn, "rowcount", 0)) > 0

    def set_status(
        self,
        conn: SupportsExecute,
        *,
        node_id: str,
        status: str,
    ) -> bool:
        """Transition a node's status (ACTIVE → DRAINING → GONE)."""
        if status not in (STATUS_ACTIVE, STATUS_DRAINING, STATUS_GONE):
            raise ValueError(f"unsupported node status: {status!r}")
        now = to_mysql_datetime()
        conn.execute(
            f"""
            UPDATE {TABLE}
            SET status = %s, updated_at = %s
            WHERE node_id = %s
            """,
            (status, now, node_id),
        )
        return int(getattr(conn, "rowcount", 0)) > 0

    # ── reads ───────────────────────────────────────────────────────

    def get(self, conn: SupportsExecute, node_id: str) -> NodeRecord | None:
        conn.execute(
            f"SELECT * FROM {TABLE} WHERE node_id = %s",
            (node_id,),
        )
        row = conn.fetchone()
        return map_node(row) if row else None

    def list_all(self, conn: SupportsExecute) -> list[NodeRecord]:
        conn.execute(f"SELECT * FROM {TABLE} ORDER BY node_id ASC")
        return [map_node(r) for r in conn.fetchall()]

    def list_placeable(
        self,
        conn: SupportsExecute,
        *,
        min_heartbeat_at: str,
    ) -> list[NodeRecord]:
        """Live replicas eligible for a new workspace, least loaded first.

        Load is the count of non-CLOSED sessions already bound to the node. A
        LEFT JOIN keeps a brand-new replica (zero sessions) in the result, which
        is exactly the node we most want to pick.
        """
        conn.execute(
            f"""
            SELECT n.*, COUNT(s.sandbox_session_id) AS session_count
            FROM {TABLE} AS n
            LEFT JOIN sandbox_sessions AS s
                ON s.node_id = n.node_id AND s.status <> 'CLOSED'
            WHERE n.status = %s AND n.heartbeat_at >= %s
            GROUP BY n.node_id
            ORDER BY session_count ASC, n.node_id ASC
            """,
            (STATUS_ACTIVE, min_heartbeat_at),
        )
        return [map_node(r) for r in conn.fetchall()]


__all__ = [
    "NodeRepository",
    "NodeRecord",
    "map_node",
    "TABLE",
    "STATUS_ACTIVE",
    "STATUS_DRAINING",
    "STATUS_GONE",
    "PLACEABLE_STATUSES",
]
