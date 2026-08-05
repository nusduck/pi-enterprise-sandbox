"""Reconcile process rows left active by a Sandbox replica's previous run.

Recovery is **node-scoped**, and that scope is the entire point of this module.

A managed child process is a ``Popen`` handle inside one replica, living in that
replica's PID namespace. No other replica can read it, signal it, or verify its
identity. Before placement existed, startup recovery scanned every globally
active row, so each starting replica marked every other replica's live processes
as LOST — a rolling restart of N pods killed running work N times over.

Two rules keep that from happening:

1. Only rows carrying **this node's id** and an **older generation** are
   considered. Current-generation rows belong to the process running right now.
2. A PID is signalled only for a row this node actually owns. Rows predating
   placement have no attribution, so they are closed out on paper but never
   signalled — a PID number without a verified owner may name anything.
"""

from __future__ import annotations

import logging
import signal
from typing import Any, Protocol

from sandbox.app.domain.types import ProcessRecord
from sandbox.services.process_identity import (
    identity_matches,
    process_alive,
    safe_signal_identity,
)

logger = logging.getLogger("sandbox.services.process_orphan_recovery")


class RecoveryStore(Protocol):
    """The slice of the formal process writer that recovery needs."""

    def list_active_for_recovery(
        self,
        *,
        node_id: str,
        node_generation: int,
        limit: int = 1000,
    ) -> list[ProcessRecord]: ...

    def upsert_from_runtime(self, entry: dict[str, Any]) -> bool: ...


def _as_int(value: Any) -> int | None:
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _terminate(pid: int, pgid: int | None, start_identity: str) -> bool:
    """SIGTERM then SIGKILL a PID whose start identity still matches.

    The identity check is what makes this safe against PID reuse: between the
    row being written and recovery running, the kernel may have handed that
    number to an unrelated process.
    """
    result = safe_signal_identity(
        pid=pid, pgid=pgid, start_identity=start_identity, signum=signal.SIGTERM
    )
    if not result.get("signaled"):
        return False
    if identity_matches(pid, start_identity):
        safe_signal_identity(
            pid=pid,
            pgid=pgid,
            start_identity=start_identity,
            signum=signal.SIGKILL,
        )
    return True


def _signal_orphan(record: ProcessRecord, command_json: dict[str, Any]) -> bool:
    """Tear down the OS processes behind one owned row. Returns True if signalled."""
    namespace_pid = _as_int(command_json.get("namespace_pid"))
    namespace_start_identity = command_json.get("namespace_start_identity")
    pgid = _as_int(command_json.get("pgid"))
    start_identity = command_json.get("start_identity")

    signaled = False
    # The namespace init is the recovery authority: killing it (rather than its
    # process group) makes Linux tear down every descendant, including those
    # that called setsid() to escape the group.
    if namespace_pid is not None and namespace_start_identity:
        signaled = _terminate(namespace_pid, None, str(namespace_start_identity))

    if record.pid is not None and start_identity:
        if _terminate(int(record.pid), pgid, str(start_identity)):
            signaled = True
    elif record.pid is not None and process_alive(record.pid):
        logger.warning(
            "formal process %s active after restart without start_identity; "
            "not signaling pid %s",
            record.process_id,
            record.pid,
        )
    return signaled


def _lost_entry(
    record: ProcessRecord,
    command_json: dict[str, Any],
    *,
    signaled: bool,
    now: str,
    lost_status: str,
) -> dict[str, Any]:
    return {
        "process_id": record.process_id,
        "org_id": record.org_id,
        "user_id": record.user_id,
        "sandbox_session_id": record.sandbox_session_id,
        "session_id": record.sandbox_session_id,
        "run_id": record.run_id,
        "execution_id": record.execution_id,
        "command": command_json.get("command") or "",
        "cwd": command_json.get("cwd"),
        "pgid": _as_int(command_json.get("pgid")),
        "start_identity": command_json.get("start_identity"),
        "namespace_pid": _as_int(command_json.get("namespace_pid")),
        "namespace_pgid": _as_int(command_json.get("namespace_pgid")),
        "namespace_start_identity": command_json.get("namespace_start_identity"),
        "pid_namespace": command_json.get("pid_namespace"),
        "timeout_seconds": command_json.get("timeout_seconds"),
        "background": bool(command_json.get("background")),
        "status": lost_status,
        "pid": record.pid,
        "exit_code": -signal.SIGTERM if signaled else -1,
        "stdout_path": record.stdout_path,
        "stderr_path": record.stderr_path,
        "started_at": record.started_at,
        "finished_at": record.ended_at or now,
        "created_at": record.created_at,
        # Keep the original attribution. This row is history now; restamping it
        # with the current generation would make the next restart believe it had
        # already been recovered by a newer incarnation than the one that ran it.
        "node_id": record.node_id,
        "node_generation": record.node_generation,
    }


def recover_orphans(
    store: RecoveryStore,
    *,
    node_id: str,
    node_generation: int,
    now: str,
    lost_status: str,
) -> int:
    """Close out this node's stale process rows; return how many were recovered."""
    recovered = 0
    unattributed = 0

    for record in store.list_active_for_recovery(
        node_id=node_id, node_generation=node_generation
    ):
        owned = record.node_id is not None and str(record.node_id) == node_id
        command_json = (
            dict(record.command_json) if isinstance(record.command_json, dict) else {}
        )

        if owned:
            signaled = _signal_orphan(record, command_json)
        else:
            signaled = False
            unattributed += 1
            if record.pid is not None:
                logger.warning(
                    "formal process %s has no node attribution; closing it out "
                    "without signaling pid %s",
                    record.process_id,
                    record.pid,
                )

        store.upsert_from_runtime(
            _lost_entry(
                record,
                command_json,
                signaled=signaled,
                now=now,
                lost_status=lost_status,
            )
        )
        recovered += 1

    if recovered:
        logger.info(
            "Marked %d formal process execution(s) as LOST after restart "
            "(node_id=%s generation=%s, %d unattributed and not signaled)",
            recovered,
            node_id,
            node_generation,
            unattributed,
        )
    return recovered


__all__ = ["RecoveryStore", "recover_orphans"]
