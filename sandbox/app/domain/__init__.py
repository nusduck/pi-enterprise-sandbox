"""Sandbox domain pure types (no I/O).

Conversation / Message / Run authority lives in Agent Service — not here.
"""

from sandbox.app.domain.types import (
    SANDBOX_EXECUTION_FROM_RUNNING,
    SANDBOX_EXECUTION_STATUS_CANCELLED,
    SANDBOX_EXECUTION_STATUS_FAILED,
    SANDBOX_EXECUTION_STATUS_RUNNING,
    SANDBOX_EXECUTION_STATUS_SUCCESS,
    SANDBOX_EXECUTION_STATUS_TIMEOUT,
    SANDBOX_EXECUTION_STATUS_UNKNOWN,
    SANDBOX_EXECUTION_TERMINAL_STATUSES,
    ArtifactRecord,
    AuditRecord,
    DatasetRecord,
    ExecutionRecord,
    OwnerScope,
    ProcessRecord,
    SandboxSessionRecord,
    can_transition_sandbox_execution,
    is_terminal_sandbox_execution_status,
)

__all__ = [
    "SANDBOX_EXECUTION_FROM_RUNNING",
    "SANDBOX_EXECUTION_STATUS_CANCELLED",
    "SANDBOX_EXECUTION_STATUS_FAILED",
    "SANDBOX_EXECUTION_STATUS_RUNNING",
    "SANDBOX_EXECUTION_STATUS_SUCCESS",
    "SANDBOX_EXECUTION_STATUS_TIMEOUT",
    "SANDBOX_EXECUTION_STATUS_UNKNOWN",
    "SANDBOX_EXECUTION_TERMINAL_STATUSES",
    "ArtifactRecord",
    "AuditRecord",
    "DatasetRecord",
    "ExecutionRecord",
    "OwnerScope",
    "ProcessRecord",
    "SandboxSessionRecord",
    "can_transition_sandbox_execution",
    "is_terminal_sandbox_execution_status",
]
