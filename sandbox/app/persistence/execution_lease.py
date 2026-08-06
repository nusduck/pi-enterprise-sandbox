"""Execution-owner lease on ``tool_executions``.

The lease answers one question a crashed replica cannot answer for itself: *is
anyone still running this?*

A Sandbox replica that shuts down cleanly reconciles its own in-flight claims as
UNKNOWN. One that is SIGKILLed, OOM-killed, or loses its node does not, and the
row would stay RUNNING forever with no one able to prove otherwise. Recording an
owner and an expiry gives a sweeper the evidence to close it out — see
``agent/src/application/execution-lease-sweeper.js`` for the reaping half.

This is deliberately **not** a distributed lock. Placement already guarantees
one replica per workspace; the lease only records who is running something and
until when. Nothing reads it to decide whether work may start.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from sandbox.app.persistence.mappers import to_mysql_datetime

TABLE = "tool_executions"


def lease_identity() -> tuple[str, int] | None:
    """``(node_id, lease_seconds)``, or None when no replica identity exists.

    A single-process development runtime has no registry: there is nothing to
    reap and nobody to reap it, so leasing is skipped entirely.
    """
    from sandbox.config import settings
    from sandbox.services.node_registry import node_registry

    identity = node_registry.identity
    if identity is None:
        return None
    return identity.node_id, int(settings.execution_lease_seconds)


def acquire(conn: Any, tool_execution_id: Any) -> None:
    """Record this replica as the owner, with an expiry.

    Called inside the claim transaction so ownership and the RUNNING row commit
    together — a lease without a claim, or a claim without a lease, would each
    leave the sweeper guessing.
    """
    lease = lease_identity()
    if lease is None or not tool_execution_id:
        return
    node_id, seconds = lease
    expires_at = to_mysql_datetime(
        datetime.now(timezone.utc) + timedelta(seconds=seconds)
    )
    conn.execute(
        f"""
        UPDATE {TABLE}
        SET owner_node_id = %s, lease_expires_at = %s
        WHERE tool_execution_id = %s
        """,
        (node_id, expires_at, str(tool_execution_id)),
    )


def release(conn: Any, tool_execution_id: Any) -> None:
    """Clear ownership once the execution reaches a terminal state.

    Scoped to this node on purpose: if a sweeper already took the row over (or
    it was re-claimed elsewhere), a late finaliser must not wipe the new owner's
    lease and make the row look unattended again.
    """
    lease = lease_identity()
    if lease is None or not tool_execution_id:
        return
    node_id, _ = lease
    conn.execute(
        f"""
        UPDATE {TABLE}
        SET owner_node_id = NULL, lease_expires_at = NULL
        WHERE tool_execution_id = %s
          AND owner_node_id = %s
        """,
        (str(tool_execution_id), node_id),
    )


__all__ = ["TABLE", "acquire", "lease_identity", "release"]
