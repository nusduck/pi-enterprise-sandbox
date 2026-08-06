"""Replica identity configuration for the sharded Sandbox.

The Sandbox is node-affine by physical necessity: a workspace is a directory on
one replica's local volume, and a managed child process is a handle in one
replica's memory. Horizontal scale-out is therefore *sharding*, and every
replica needs a stable identity plus an address other services can dial
directly.

This module owns the parsing and validation of that identity so
:mod:`sandbox.config` stays a settings surface rather than a rulebook. It has no
imports from the rest of the package and performs no I/O.
"""

from __future__ import annotations

import re
from typing import Any

#: Node ids are Kubernetes pod names and the leading label of that pod's
#: headless DNS record, so they must be DNS labels. The width matches the
#: placement columns added by migration 20260805000001.
MAX_NODE_ID_LENGTH = 64
_NODE_ID_RE = re.compile(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?")

DEFAULT_NODE_ID = "sandbox-0"
DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 10.0
DEFAULT_LIVENESS_MULTIPLIER = 3

MIN_HEARTBEAT_INTERVAL_SECONDS = 1.0
MAX_HEARTBEAT_INTERVAL_SECONDS = 300.0
MIN_LIVENESS_MULTIPLIER = 2
MAX_LIVENESS_MULTIPLIER = 100

ENV_NODE_ID = "SANDBOX_NODE_ID"
ENV_NODE_ADDRESS = "SANDBOX_NODE_ADDRESS"
ENV_HEARTBEAT = "SANDBOX_NODE_HEARTBEAT_INTERVAL_SECONDS"
ENV_LIVENESS_MULTIPLIER = "SANDBOX_NODE_LIVENESS_MULTIPLIER"
ENV_UVICORN_WORKERS = "SANDBOX_UVICORN_WORKERS"
ENV_EXECUTION_LEASE = "SANDBOX_EXECUTION_LEASE_SECONDS"

#: How long a claimed tool execution stays owned by a replica. Generous on
#: purpose: every claim is one bounded tool call, and reaping a still-running
#: execution is worse than reaping a dead one late.
DEFAULT_EXECUTION_LEASE_SECONDS = 900
MIN_EXECUTION_LEASE_SECONDS = 60
MAX_EXECUTION_LEASE_SECONDS = 86_400

#: Scaling out means more replicas, never more workers. The execution admission
#: lock and the managed-process table live in a single process, so a second
#: worker would serve the same workspace without seeing either.
REQUIRED_UVICORN_WORKERS = 1


def parse_node_id(value: Any) -> str:
    """Validate a node id, falling back to the single-shard default."""
    if value is None or value == "":
        return DEFAULT_NODE_ID
    if type(value) is not str:
        raise ValueError(f"{ENV_NODE_ID} must be a string")
    text = value.strip()
    if not text:
        raise ValueError(f"{ENV_NODE_ID} must not be blank")
    if len(text) > MAX_NODE_ID_LENGTH:
        raise ValueError(f"{ENV_NODE_ID} must be at most {MAX_NODE_ID_LENGTH} characters")
    if not _NODE_ID_RE.fullmatch(text):
        raise ValueError(
            f"{ENV_NODE_ID} must be a lowercase DNS label "
            "(a-z, 0-9, '-'; not starting or ending with '-')"
        )
    return text


def parse_node_address(value: Any) -> str:
    """Validate the per-replica dial authority (empty is allowed off-production)."""
    if value is None or value == "":
        return ""
    if type(value) is not str:
        raise ValueError(f"{ENV_NODE_ADDRESS} must be a string")
    text = value.strip()
    if not text:
        return ""
    # Authority only. The Agent joins the internal path itself, and an embedded
    # path here would silently break the HMAC `htu` binding.
    if "://" in text or "/" in text:
        raise ValueError(
            f"{ENV_NODE_ADDRESS} must be a bare host or host:port authority "
            "(no scheme, no path)"
        )
    return text


def parse_heartbeat_interval(value: Any) -> float:
    if value is None or value == "":
        return DEFAULT_HEARTBEAT_INTERVAL_SECONDS
    if type(value) is bool:
        raise ValueError(f"{ENV_HEARTBEAT} must be a positive number, not bool")
    try:
        seconds = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{ENV_HEARTBEAT} must be a positive number") from exc
    if not MIN_HEARTBEAT_INTERVAL_SECONDS <= seconds <= MAX_HEARTBEAT_INTERVAL_SECONDS:
        raise ValueError(
            f"{ENV_HEARTBEAT} must be in "
            f"{MIN_HEARTBEAT_INTERVAL_SECONDS:g}..{MAX_HEARTBEAT_INTERVAL_SECONDS:g} seconds"
        )
    return seconds


def check_uvicorn_workers(workers: int) -> int:
    """Reject any worker count other than 1, explaining what to do instead."""
    if workers != REQUIRED_UVICORN_WORKERS:
        raise ValueError(
            f"{ENV_UVICORN_WORKERS} must be 1 (got {workers}). Scale out with more "
            "Sandbox replicas, not more workers: the execution admission lock and "
            "the managed-process table live in one process, so a second worker "
            "would serve the same workspace without seeing them."
        )
    return workers


def production_identity_errors(
    *,
    node_id_explicit: bool,
    node_address: str,
) -> list[str]:
    """Production requires an explicit identity, not an inherited default.

    Two replicas silently sharing ``sandbox-0`` is the worst failure this system
    has: each would treat the other's live processes as its own stale rows and
    reap them during orphan recovery.
    """
    errors: list[str] = []
    if not node_id_explicit:
        errors.append(
            f"{ENV_NODE_ID} must be set explicitly in production "
            "(Kubernetes: Downward API metadata.name); inheriting the "
            f"single-shard default {DEFAULT_NODE_ID!r} would let two replicas "
            "claim the same identity"
        )
    if not (node_address or "").strip():
        errors.append(
            f"{ENV_NODE_ADDRESS} must be non-empty in production "
            "(per-pod headless authority, e.g. "
            "sandbox-0.sandbox-headless.<ns>.svc.cluster.local:8081)"
        )
    return errors


__all__ = [
    "DEFAULT_EXECUTION_LEASE_SECONDS",
    "ENV_EXECUTION_LEASE",
    "MAX_EXECUTION_LEASE_SECONDS",
    "MIN_EXECUTION_LEASE_SECONDS",
    "DEFAULT_HEARTBEAT_INTERVAL_SECONDS",
    "DEFAULT_LIVENESS_MULTIPLIER",
    "DEFAULT_NODE_ID",
    "ENV_NODE_ADDRESS",
    "ENV_NODE_ID",
    "MAX_LIVENESS_MULTIPLIER",
    "MAX_NODE_ID_LENGTH",
    "MIN_LIVENESS_MULTIPLIER",
    "REQUIRED_UVICORN_WORKERS",
    "check_uvicorn_workers",
    "parse_heartbeat_interval",
    "parse_node_address",
    "parse_node_id",
    "production_identity_errors",
]
