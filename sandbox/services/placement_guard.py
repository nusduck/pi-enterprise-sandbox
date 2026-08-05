"""Refuse work for a workspace this replica does not own.

Every workspace-bound internal route runs this guard before touching a file, an
execution, or a process. Without it a request that lands on the wrong replica
fails in the worst possible way: silently and plausibly. The wrong pod would
find no workspace directory and create an empty one, report a managed process as
"no output", or accept a kill that signals nothing — all with a 200 status.

So a misrouted request gets a **409 PLACEMENT_MISMATCH** naming the owner
instead. That turns an invisible data-loss bug into a routing instruction the
caller can act on: re-resolve placement, retry once against the owner.

The guard is deliberately not a fallback or a proxy. This replica cannot serve
another replica's workspace under any circumstances — the data is on a volume it
has never mounted.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

from fastapi import HTTPException

logger = logging.getLogger("sandbox.services.placement_guard")

PLACEMENT_MISMATCH_CODE = "PLACEMENT_MISMATCH"
PLACEMENT_UNRESOLVED_CODE = "PLACEMENT_UNRESOLVED"


class PlacementMismatch(Exception):
    """This replica is not the placement owner of the requested workspace."""

    def __init__(
        self,
        *,
        sandbox_session_id: str,
        owner_node_id: str | None,
        owner_address: str | None,
    ) -> None:
        self.sandbox_session_id = sandbox_session_id
        self.owner_node_id = owner_node_id
        self.owner_address = owner_address
        super().__init__(
            f"workspace for session {sandbox_session_id} is owned by "
            f"{owner_node_id or 'an unknown node'}"
        )

    def to_detail(self) -> dict[str, Any]:
        return {
            "code": PLACEMENT_MISMATCH_CODE,
            "message": "Workspace is owned by another Sandbox replica",
            "ownerNodeId": self.owner_node_id,
            "ownerAddress": self.owner_address,
        }


def _local_node_id() -> str | None:
    from sandbox.services.node_registry import node_registry

    identity = node_registry.identity
    return identity.node_id if identity is not None else None


def check_placement(app: Any, claims: Mapping[str, Any]) -> None:
    """Raise :class:`PlacementMismatch` unless this replica owns the workspace.

    A replica with no claimed identity is a single-process development runtime:
    there is nothing to route between, so the guard stands down. In production
    the identity always exists — ``validate_production_settings`` refuses to
    start without one.
    """
    local_node_id = _local_node_id()
    if local_node_id is None:
        return

    sandbox_session_id = str(claims.get("sandbox_session_id") or "")
    if not sandbox_session_id:
        # The claim schema makes this unreachable; fail closed rather than
        # silently skip the guard if that ever changes.
        raise PlacementMismatch(
            sandbox_session_id="",
            owner_node_id=None,
            owner_address=None,
        )

    from sandbox.services.formal_session_runtime import get_formal_session_runtime

    runtime = get_formal_session_runtime(app)
    if runtime is None:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")

    placement = runtime.resolve_placement(
        sandbox_session_id,
        org_id=str(claims.get("org_id") or ""),
        user_id=str(claims.get("user_id") or ""),
    )
    if placement is None:
        # Unknown session, or one belonging to another tenant. Ownership routing
        # must not become a way to probe for sessions, so this is reported the
        # same way an unowned placement is.
        raise PlacementMismatch(
            sandbox_session_id=sandbox_session_id,
            owner_node_id=None,
            owner_address=None,
        )

    owner_node_id, owner_address = placement
    if owner_node_id == local_node_id:
        return

    logger.info(
        "placement mismatch: session=%s owner=%s local=%s",
        sandbox_session_id,
        owner_node_id,
        local_node_id,
    )
    raise PlacementMismatch(
        sandbox_session_id=sandbox_session_id,
        owner_node_id=owner_node_id,
        owner_address=owner_address,
    )


def require_local_placement(app: Any, claims: Mapping[str, Any]) -> None:
    """:func:`check_placement`, surfaced as the HTTP 409 callers expect."""
    try:
        check_placement(app, claims)
    except PlacementMismatch as exc:
        raise HTTPException(status_code=409, detail=exc.to_detail()) from exc


def require_local_artifact_storage(artifact: Any) -> None:
    """Refuse to serve an artifact whose blob lives on another replica.

    Artifacts are routed by ``storage_node_id`` rather than by workspace
    placement: a snapshot is immutable and outlives its session, so the
    workspace that produced it may be long gone.

    A blob with no storage node predates placement. It is served optimistically
    — refusing would make old deliverables permanently unreachable, and the
    snapshot read fails loudly (404) if it is genuinely not here.
    """
    from sandbox.services.node_registry import node_registry

    identity = node_registry.identity
    if identity is None:
        return

    storage_node_id = getattr(artifact, "storage_node_id", None)
    if storage_node_id is None or storage_node_id == identity.node_id:
        return

    logger.info(
        "artifact storage mismatch: artifact=%s owner=%s local=%s",
        getattr(artifact, "artifact_id", "?"),
        storage_node_id,
        identity.node_id,
    )
    raise HTTPException(
        status_code=409,
        detail={
            "code": PLACEMENT_MISMATCH_CODE,
            "message": "Artifact bytes are stored on another Sandbox replica",
            "ownerNodeId": storage_node_id,
            "ownerAddress": None,
        },
    )


__all__ = [
    "PLACEMENT_MISMATCH_CODE",
    "PLACEMENT_UNRESOLVED_CODE",
    "PlacementMismatch",
    "check_placement",
    "require_local_artifact_storage",
    "require_local_placement",
]
