"""Pure execution-domain records for Sandbox MySQL persistence (plan §4.8–4.12).

These are data-only shapes. They intentionally exclude Conversation, Message,
and Run authority (those belong to Agent Service MySQL repositories).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True, slots=True)
class OwnerScope:
    """Multi-tenant ownership boundary (org_id + user_id)."""

    org_id: str
    user_id: str


@dataclass(frozen=True, slots=True)
class SandboxSessionRecord:
    """Sandbox Session — workspace / execution resource manager (no agent chat).

    Table: ``sandbox_sessions`` (Agent Knex migration, PR-02).
    ``agent_session_id`` is a logical indexed reference (no cyclic FK).
    """

    sandbox_session_id: str
    org_id: str
    user_id: str
    agent_session_id: str
    workspace_id: str
    status: str
    created_at: str
    updated_at: str
    closed_at: str | None = None


# Sandbox execution lifecycle (PR-07B batch 2B).
# RUNNING -> SUCCESS | FAILED | TIMEOUT | CANCELLED | UNKNOWN
# Terminals are sticky; UNKNOWN has no outgoing transition.
SANDBOX_EXECUTION_STATUS_RUNNING = "RUNNING"
SANDBOX_EXECUTION_STATUS_SUCCESS = "SUCCESS"
SANDBOX_EXECUTION_STATUS_FAILED = "FAILED"
SANDBOX_EXECUTION_STATUS_TIMEOUT = "TIMEOUT"
SANDBOX_EXECUTION_STATUS_CANCELLED = "CANCELLED"
SANDBOX_EXECUTION_STATUS_UNKNOWN = "UNKNOWN"

SANDBOX_EXECUTION_TERMINAL_STATUSES: frozenset[str] = frozenset(
    {
        SANDBOX_EXECUTION_STATUS_SUCCESS,
        SANDBOX_EXECUTION_STATUS_FAILED,
        SANDBOX_EXECUTION_STATUS_TIMEOUT,
        SANDBOX_EXECUTION_STATUS_CANCELLED,
        SANDBOX_EXECUTION_STATUS_UNKNOWN,
    }
)

SANDBOX_EXECUTION_FROM_RUNNING: frozenset[str] = frozenset(
    SANDBOX_EXECUTION_TERMINAL_STATUSES
)


def is_terminal_sandbox_execution_status(status: str) -> bool:
    return status in SANDBOX_EXECUTION_TERMINAL_STATUSES


def can_transition_sandbox_execution(from_status: str, to_status: str) -> bool:
    if from_status == SANDBOX_EXECUTION_STATUS_RUNNING:
        return to_status in SANDBOX_EXECUTION_FROM_RUNNING
    # Terminals sticky; UNKNOWN has no outgoing transitions.
    return False


@dataclass(frozen=True, slots=True)
class ExecutionRecord:
    """One concrete Sandbox tool execution (plan §4.9).

    Table: ``sandbox_executions`` (Agent Knex migration, PR-02 + PR-07B 2A).
    Distinct from Agent ``tool_executions`` / ``runs``.

    Claim fields (nullable; legacy NULL rows fail-closed on claim):
    ``tool_execution_id``, ``tool_call_id``, ``request_hash``,
    ``request_hash_version``, ``execution_fence_token``.
    """

    execution_id: str
    org_id: str
    user_id: str
    sandbox_session_id: str
    run_id: str
    agent_session_id: str
    kind: str
    status: str
    created_at: str
    started_at: str | None = None
    completed_at: str | None = None
    exit_code: int | None = None
    error_code: str | None = None
    trace_id: str | None = None
    result_json: dict[str, Any] | None = None
    # PR-07B batch 2A/2B claim linkage — never coerce null → 0.
    tool_execution_id: str | None = None
    tool_call_id: str | None = None
    request_hash: str | None = None
    request_hash_version: int | None = None
    execution_fence_token: int | None = None


@dataclass(frozen=True, slots=True)
class ProcessRecord:
    """Long-running process handle (plan §8.13 ``process_executions``)."""

    process_id: str
    org_id: str
    user_id: str
    sandbox_session_id: str
    run_id: str
    execution_id: str
    command_json: dict[str, Any] | list[Any]
    status: str
    created_at: str
    pid: int | None = None
    exit_code: int | None = None
    stdout_path: str | None = None
    stderr_path: str | None = None
    started_at: str | None = None
    ended_at: str | None = None


@dataclass(frozen=True, slots=True)
class DatasetRecord:
    """User dataset streamed into workspace (plan §8.14 ``datasets``)."""

    dataset_id: str
    org_id: str
    user_id: str
    conversation_id: str
    agent_session_id: str
    original_filename: str
    stored_relative_path: str
    status: str
    created_at: str
    mime_type: str | None = None
    size_bytes: int | None = None
    sha256: str | None = None
    completed_at: str | None = None


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    """Explicit user-deliverable artifact (plan §8.15 ``artifacts``)."""

    artifact_id: str
    org_id: str
    user_id: str
    conversation_id: str
    agent_session_id: str
    run_id: str
    relative_path: str
    display_name: str
    size_bytes: int
    sha256: str
    status: str
    created_at: str
    mime_type: str | None = None


@dataclass(frozen=True, slots=True)
class AuditRecord:
    """Sandbox execution audit event.

    Table: ``sandbox_audit_events`` (Agent Knex migration, PR-02).
    """

    audit_id: str
    org_id: str
    user_id: str
    event_type: str
    created_at: str
    sandbox_session_id: str | None = None
    execution_id: str | None = None
    process_id: str | None = None
    trace_id: str | None = None
    payload_json: dict[str, Any] | None = None
