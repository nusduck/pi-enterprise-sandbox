"""Sandbox replica identity and the registry that makes placement possible.

Why this exists
---------------
The Sandbox is node-affine by physical necessity. A workspace is a directory on
one replica's local volume, and a managed child process is a ``Popen`` handle in
one replica's memory — neither can be reached from anywhere else. Horizontal
scale-out therefore means *sharding*, not load balancing: every workspace is
bound to exactly one replica for its whole life, and callers route to that
replica specifically.

This module owns the replica half of that contract:

* **register** — announce this replica and claim a fresh *generation* on every
  process start. The generation is what lets orphan recovery distinguish rows
  left behind by this node's previous incarnation (safe to reap) from rows some
  other node is serving right now (never touch).
* **heartbeat** — keep the row fresh so the placement query can see us.
* **select_placement_node** — pick the least-loaded live replica for a workspace
  that does not have one yet.
* **drain** — stop attracting new workspaces during shutdown while continuing to
  serve the ones we already own.

Liveness is deliberately advisory. A missed heartbeat withdraws a node from
*new* placements only; it never reassigns existing workspaces, because their
data still lives on that node's volume and nowhere else.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from sandbox.app.persistence.mappers import to_mysql_datetime
from sandbox.app.persistence.repositories.node_repository import (
    STATUS_ACTIVE,
    STATUS_DRAINING,
    NodeRecord,
    NodeRepository,
)

logger = logging.getLogger("sandbox.services.node_registry")


class NodeRegistryError(RuntimeError):
    """Registry could not establish or maintain this replica's identity."""


class NodeIdentity:
    """Immutable identity of the replica this process is running as."""

    __slots__ = ("node_id", "address", "generation")

    def __init__(self, *, node_id: str, address: str, generation: int) -> None:
        self.node_id = node_id
        self.address = address
        self.generation = generation

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodeId": self.node_id,
            "address": self.address,
            "generation": self.generation,
        }

    def __repr__(self) -> str:  # pragma: no cover — diagnostics only
        return (
            f"NodeIdentity(node_id={self.node_id!r}, address={self.address!r}, "
            f"generation={self.generation!r})"
        )


class NodeRegistry:
    """Process-global registry client for this Sandbox replica.

    One instance per process (module singleton below). Registration is
    synchronous because it runs inside the internal-plane install path, which is
    already off the event loop; the heartbeat is an asyncio task owned by the
    application lifespan.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._repo: NodeRepository | None = None
        self._conn_factory: Callable[[], Any] | None = None
        self._identity: NodeIdentity | None = None
        self._draining = False
        self._heartbeat_task: asyncio.Task[None] | None = None

    # ── installation ────────────────────────────────────────────────

    def set_repository(
        self,
        repo: NodeRepository | None,
        *,
        conn_factory: Callable[[], Any] | None = None,
    ) -> None:
        """Install or clear the lifespan-owned registry repository."""
        with self._lock:
            self._repo = repo
            self._conn_factory = conn_factory
            if repo is None:
                self._identity = None
                self._draining = False

    @property
    def installed(self) -> bool:
        with self._lock:
            return self._repo is not None and self._conn_factory is not None

    @property
    def identity(self) -> NodeIdentity | None:
        with self._lock:
            return self._identity

    @property
    def node_id(self) -> str | None:
        identity = self.identity
        return identity.node_id if identity else None

    @property
    def generation(self) -> int | None:
        identity = self.identity
        return identity.generation if identity else None

    @property
    def draining(self) -> bool:
        with self._lock:
            return self._draining

    def _require(self) -> tuple[NodeRepository, Callable[[], Any]]:
        with self._lock:
            repo = self._repo
            factory = self._conn_factory
        if repo is None or factory is None:
            raise NodeRegistryError("node registry has no repository installed")
        return repo, factory

    # ── registration + liveness ─────────────────────────────────────

    def register(self, *, node_id: str, address: str) -> NodeIdentity:
        """Claim this replica's identity and a fresh generation.

        Must complete before orphan recovery runs: recovery compares stored
        ``node_generation`` values against the generation claimed here.
        """
        repo, factory = self._require()
        with factory() as conn:
            record = repo.register(conn, node_id=node_id, address=address)
            conn.commit()
        identity = NodeIdentity(
            node_id=record.node_id,
            address=record.address,
            generation=record.generation,
        )
        with self._lock:
            self._identity = identity
            self._draining = False
        logger.info(
            "sandbox node registered node_id=%s generation=%s",
            identity.node_id,
            identity.generation,
        )
        return identity

    def heartbeat_once(self) -> bool:
        """Write one heartbeat. False means our row disappeared."""
        identity = self.identity
        if identity is None:
            return False
        repo, factory = self._require()
        with factory() as conn:
            ok = repo.heartbeat(conn, node_id=identity.node_id)
            conn.commit()
        return ok

    def set_draining(self) -> bool:
        """Stop attracting new workspaces; keep serving the ones we own."""
        identity = self.identity
        if identity is None:
            return False
        repo, factory = self._require()
        with factory() as conn:
            ok = repo.set_status(
                conn, node_id=identity.node_id, status=STATUS_DRAINING
            )
            conn.commit()
        with self._lock:
            self._draining = True
        logger.info("sandbox node draining node_id=%s", identity.node_id)
        return ok

    # ── placement ───────────────────────────────────────────────────

    def select_placement_node(
        self,
        conn: Any,
        *,
        interval_seconds: float,
        liveness_multiplier: int,
    ) -> NodeRecord | None:
        """Least-loaded live replica for a workspace with no placement yet.

        Runs on the caller's connection so the choice can be made inside the
        same transaction that writes ``sandbox_sessions.node_id`` — two
        concurrent ensures for the same session must not disagree.

        Returns None when no replica is currently eligible; the caller decides
        whether that is a retryable 503 or a hard failure.
        """
        repo, _ = self._require()
        cutoff = datetime.now(timezone.utc) - timedelta(
            seconds=float(interval_seconds) * int(liveness_multiplier)
        )
        candidates = repo.list_placeable(
            conn, min_heartbeat_at=to_mysql_datetime(cutoff)
        )
        return candidates[0] if candidates else None

    def resolve_node(self, conn: Any, node_id: str) -> NodeRecord | None:
        """Look up a node row, e.g. to answer a PLACEMENT_MISMATCH with its address."""
        repo, _ = self._require()
        return repo.get(conn, node_id)

    # ── heartbeat task ──────────────────────────────────────────────

    async def start_heartbeat(self, *, interval_seconds: float) -> None:
        """Start the background heartbeat loop (idempotent)."""
        with self._lock:
            if self._heartbeat_task is not None and not self._heartbeat_task.done():
                return
        if self.identity is None:
            raise NodeRegistryError("cannot heartbeat before register()")
        task = asyncio.create_task(
            self._heartbeat_loop(float(interval_seconds)),
            name="sandbox-node-heartbeat",
        )
        with self._lock:
            self._heartbeat_task = task

    async def stop_heartbeat(self) -> None:
        """Cancel the heartbeat loop and wait for it to unwind."""
        with self._lock:
            task = self._heartbeat_task
            self._heartbeat_task = None
        if task is None:
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        except Exception as exc:  # pragma: no cover — loop already logs
            logger.warning("node heartbeat stop failed type=%s", type(exc).__name__)

    async def _heartbeat_loop(self, interval_seconds: float) -> None:
        """Refresh liveness forever; a transient DB error is never fatal.

        Losing heartbeats degrades this node to "not eligible for new
        placements". It must not take the process down, because the workspaces
        already placed here are only reachable through this process.
        """
        while True:
            try:
                await asyncio.sleep(interval_seconds)
            except asyncio.CancelledError:
                raise
            try:
                alive = await asyncio.to_thread(self.heartbeat_once)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning(
                    "node heartbeat failed type=%s — node will fall out of "
                    "placement until it recovers",
                    type(exc).__name__,
                )
                continue
            if not alive:
                # The row was deleted underneath us (manual cleanup, or a
                # scale-down that assumed we were gone). Re-announce so we stay
                # resolvable for the workspaces we still own.
                identity = self.identity
                if identity is None:  # pragma: no cover — cleared concurrently
                    return
                logger.warning(
                    "node row missing node_id=%s — re-registering",
                    identity.node_id,
                )
                try:
                    await asyncio.to_thread(
                        self.register,
                        node_id=identity.node_id,
                        address=identity.address,
                    )
                except Exception as exc:
                    logger.warning(
                        "node re-register failed type=%s", type(exc).__name__
                    )

    # ── tests ───────────────────────────────────────────────────────

    def reset_for_tests(self) -> None:
        with self._lock:
            self._repo = None
            self._conn_factory = None
            self._identity = None
            self._draining = False
            self._heartbeat_task = None


#: Process-global registry. Installed by the internal-plane wiring.
node_registry = NodeRegistry()


__all__ = [
    "NodeRegistry",
    "NodeRegistryError",
    "NodeIdentity",
    "node_registry",
    "STATUS_ACTIVE",
    "STATUS_DRAINING",
]
