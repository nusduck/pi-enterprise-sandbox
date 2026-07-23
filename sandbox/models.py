"""Pydantic models for Sandbox Service."""

from __future__ import annotations

from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# ── Enums ──────────────────────────────────────────────────────────────

class ExecutionStatus(str, Enum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    TIMEOUT = "TIMEOUT"
    CANCELLED = "CANCELLED"
    PENDING_APPROVAL = "PENDING_APPROVAL"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class PolicyDecision(str, Enum):
    """Three-tier tool policy outcome (Agent + Sandbox dual enforcement)."""

    ALLOW = "allow"
    APPROVAL_REQUIRED = "approval_required"
    HARD_DENY = "hard_deny"


class InternalPlaneHealthStatus(str, Enum):
    DISABLED = "disabled"
    NOT_CHECKED = "not_checked"
    READY = "ready"
    NOT_READY = "not_ready"


# ── File ───────────────────────────────────────────────────────────────

class FileReadRequest(BaseModel):
    path: str = Field(..., description="Relative path within workspace")
    offset: int | None = None
    limit: int | None = None


class FileWriteRequest(BaseModel):
    path: str = Field(..., description="Relative path within workspace")
    content: str
    mode: str = "w"  # w | a


class FileResponse(BaseModel):
    path: str
    content: str = ""
    size: int = 0
    truncated: bool = False
    mime_type: str = "text/plain"


class FileInfo(BaseModel):
    name: str
    path: str
    is_dir: bool = False
    size: int = 0
    modified_at: str = ""


class FileListResponse(BaseModel):
    files: list[FileInfo] = Field(default_factory=list)
    total: int = 0


class AttachmentUploadResponse(BaseModel):
    """Stable shape returned by multipart attachment upload."""

    attachment_id: str
    path: str
    name: str
    size: int = 0
    mime_type: str = "application/octet-stream"
    upload_time: str | None = None
    idempotency_key: str | None = None
    # Backward-compatible FileResponse-ish fields
    content: str = ""
    truncated: bool = False


class AttachmentContext(BaseModel):
    """ADR §4.5 structured attachment metadata on an agent message."""

    attachment_id: str | None = None
    filename: str
    path: str | None = None
    workspace_path: str | None = None
    mime_type: str = "application/octet-stream"
    size: int = 0
    upload_time: str | None = None


# ── Structured file search (ls / find / grep) ──────────────────────────

class LsRequest(BaseModel):
    path: str = "."
    depth: int = Field(default=1, ge=0, le=5)
    include_hidden: bool = False


class FindRequest(BaseModel):
    path: str = "."
    pattern: str = "*"
    type: str | None = Field(
        default=None,
        description="Optional filter: file | dir | symlink",
    )
    max_depth: int | None = Field(default=None, ge=0, le=20)
    limit: int | None = Field(default=None, ge=1, le=500)


class GrepRequest(BaseModel):
    path: str = "."
    query: str = Field(..., min_length=1)
    glob: str | None = None
    regex: bool = False
    case_sensitive: bool = True
    context: int | None = Field(default=None, ge=0, le=5)
    limit: int | None = Field(default=None, ge=1, le=500)


class FileSearchItem(BaseModel):
    path: str
    name: str
    type: str  # file | dir | symlink
    size: int = 0


class FileSearchSkipped(BaseModel):
    path: str
    reason: str


class FileSearchStats(BaseModel):
    examined: int = 0
    matched: int = 0
    skipped: int = 0
    bytes_scanned: int = 0
    duration_ms: float = 0.0
    depth_reached: int = 0


class FileSearchResponse(BaseModel):
    """Shared response envelope for ls / find."""

    items: list[FileSearchItem] = Field(default_factory=list)
    skipped: list[FileSearchSkipped] = Field(default_factory=list)
    stats: FileSearchStats = Field(default_factory=FileSearchStats)
    truncated: bool = False
    stop_reason: str | None = None


class GrepMatch(BaseModel):
    path: str
    line: int
    column: int = 1
    text: str
    before: list[str] = Field(default_factory=list)
    after: list[str] = Field(default_factory=list)


class GrepResponse(BaseModel):
    matches: list[GrepMatch] = Field(default_factory=list)
    skipped: list[FileSearchSkipped] = Field(default_factory=list)
    stats: FileSearchStats = Field(default_factory=FileSearchStats)
    truncated: bool = False
    stop_reason: str | None = None


# ── Dataset ────────────────────────────────────────────────────────────

class DatasetResponse(BaseModel):
    dataset_id: str
    org_id: str | None = None
    user_id: str | None = None
    conversation_id: str | None = None
    agent_session_id: str | None = None
    sandbox_session_id: str | None = None
    original_filename: str = ""
    name: str = ""
    path: str = ""
    stored_relative_path: str = ""
    mime_type: str = "application/octet-stream"
    size_bytes: int = 0
    size: int = 0
    sha256: str | None = None
    status: str = "uploading"
    created_at: str = ""
    completed_at: str | None = None


class DatasetListResponse(BaseModel):
    datasets: list[DatasetResponse] = Field(default_factory=list)
    total: int = 0


# ── Artifact ───────────────────────────────────────────────────────────

class ArtifactRegister(BaseModel):
    name: str | None = None
    path: str
    mime_type: str = "application/octet-stream"
    source_execution_id: str | None = None
    # Formal ownership / run binding (PR-09). Optional for legacy session-only.
    run_id: str | None = None
    org_id: str | None = None
    user_id: str | None = None
    conversation_id: str | None = None
    agent_session_id: str | None = None
    expected_sha256: str | None = None
    description: str | None = None


class ArtifactResponse(BaseModel):
    artifact_id: str
    name: str
    path: str
    mime_type: str
    source_execution_id: str | None = None
    size: int = 0
    created_at: str = ""
    sha256: str | None = None
    run_id: str | None = None
    status: str = "ready"


class ArtifactListResponse(BaseModel):
    artifacts: list[ArtifactResponse] = Field(default_factory=list)
    total: int = 0


# ── Tool Policy ────────────────────────────────────────────────────────

class ToolCallCheck(BaseModel):
    caller_id: str = "unknown"
    user_id: str | None = None
    session_id: str
    tool_name: str
    risk_level: RiskLevel = RiskLevel.LOW
    path: str | None = None
    command: str | None = None
    timeout: int | None = None
    file_size: int | None = None


class ToolCallDecision(BaseModel):
    allowed: bool = True
    # Three-tier: allow | approval_required | hard_deny
    decision: str = "allow"
    reason: str = ""
    risk_level: RiskLevel = RiskLevel.LOW
    policy_version: str = "2026-07-15.1"


# ── Health ─────────────────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: str = "ok"
    version: str = ""
    sessions_active: int = 0
    executions_total: int = 0
    workspace_available: bool = False
    disk_free_mb: float = 0.0
    runtimes: dict[str, bool] = Field(default_factory=dict)
    isolation_backend: str = "unknown"
    isolation_required: bool = False
    isolation_preflight_passed: bool = False
    isolation_policy_version: str = ""
    internal_plane_status: InternalPlaneHealthStatus = InternalPlaneHealthStatus.DISABLED


class FileEditRequest(BaseModel):
    """Unique old_string → new_string edit with optional race hash."""

    path: str = Field(..., description="Relative path within workspace")
    old_string: str = Field(..., description="Exact text to find (must match once)")
    new_string: str = Field(..., description="Replacement text")
    expected_hash: str | None = Field(
        default=None,
        description="Optional SHA-256 of current file content; rejects on mismatch",
    )


class FileApplyPatchRequest(BaseModel):
    """Apply a unified diff patch to a single workspace file."""

    path: str = Field(..., description="Relative path within workspace")
    patch: str = Field(..., description="Unified diff (---/+++/@@ hunks)")
    expected_hash: str | None = Field(
        default=None,
        description="Optional SHA-256 of current file content; rejects on mismatch",
    )


class FileEditResponse(BaseModel):
    """Edit/apply_patch result with unified diff and content hashes (ADR §9)."""

    path: str
    before_hash: str = ""
    after_hash: str = ""
    diff: str = ""
    changed_lines: int = 0
    ok: bool = True
    error: str | None = None
    match_count: int | None = None
    match_lines: list[int] | None = None


# ── Managed process (Process Manager / B2) ──────────────────────────────

class ProcessStatus(str, Enum):
    """Lifecycle states for managed long-running processes (ADR §8.3 / PR-08)."""

    CREATED = "created"
    RUNNING = "running"
    WAITING_INPUT = "waiting_input"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"
    ORPHANED = "orphaned"
    # Runner restart lost Popen handles; OS process may already be dead or was
    # identity-killed. Never remains RUNNING after recovery scan.
    LOST = "lost"


PROCESS_TERMINAL_STATUSES = frozenset(
    {
        ProcessStatus.COMPLETED.value,
        ProcessStatus.FAILED.value,
        ProcessStatus.CANCELLED.value,
        ProcessStatus.TIMEOUT.value,
        ProcessStatus.ORPHANED.value,
        ProcessStatus.LOST.value,
        ProcessStatus.COMPLETED,
        ProcessStatus.FAILED,
        ProcessStatus.CANCELLED,
        ProcessStatus.TIMEOUT,
        ProcessStatus.ORPHANED,
        ProcessStatus.LOST,
    }
)

PROCESS_ACTIVE_STATUSES = frozenset(
    {
        ProcessStatus.CREATED.value,
        ProcessStatus.RUNNING.value,
        ProcessStatus.WAITING_INPUT.value,
        ProcessStatus.CANCEL_REQUESTED.value,
        ProcessStatus.CREATED,
        ProcessStatus.RUNNING,
        ProcessStatus.WAITING_INPUT,
        ProcessStatus.CANCEL_REQUESTED,
    }
)


class ProcessStartRequest(BaseModel):
    session_id: str = Field(..., description="Sandbox session that owns the process")
    command: str = Field(..., description="Shell command to run under managed process")
    cwd: str | None = Field(
        default=None,
        description="Workspace-relative working directory (default: workspace root)",
    )
    env: dict[str, str] = Field(default_factory=dict)
    timeout: int | None = Field(
        default=None,
        gt=0,
        description=(
            "Wall-clock seconds before process is marked timeout and killed. "
            "Omit/null uses server process_timeout_seconds default. "
            "0 and values above max_process_timeout_seconds are rejected."
        ),
    )
    background: bool = Field(
        default=False,
        description="If false (foreground), process is stopped when the run/session ends",
    )
    run_id: str | None = Field(
        default=None,
        description="Optional agent run id for cancel cascade",
    )


class ProcessResponse(BaseModel):
    process_id: str
    session_id: str
    run_id: str | None = None
    command: str = ""
    status: str = ProcessStatus.CREATED.value
    pid: int | None = None
    exit_code: int | None = None
    background: bool = False
    cwd: str | None = None
    error: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    created_at: str = ""
    updated_at: str = ""
    trace_id: str | None = None


class ProcessStartResponse(BaseModel):
    process_id: str
    status: str = ProcessStatus.RUNNING.value
    started_at: str = ""
    # Plan §13.7 cursors (generation-offset); independent stdout/stderr streams.
    stdout_cursor: str = "0-0"
    stderr_cursor: str = "0-0"


class ProcessLogsResponse(BaseModel):
    stdout: str = ""
    stderr: str = ""
    next_offset: int = 0
    completed: bool = False
    truncated: bool = False
    # When truncated=true, clients can pull full logs from this path (B3).
    full_log_location: str | None = None
    log_total: int = 0
    stdout_cursor: str | None = None
    stderr_cursor: str | None = None
    next_stdout_cursor: str | None = None
    next_stderr_cursor: str | None = None


class ProcessReadRequest(BaseModel):
    """Incremental stream read by cursor (process_read tool contract)."""

    stream: str = Field(
        default="stdout",
        description="stdout | stderr",
    )
    cursor: str = Field(default="0-0", max_length=64)
    limit: int = Field(default=8192, ge=1, le=65536)


class ProcessReadResponse(BaseModel):
    process_id: str
    stream: str
    cursor: str
    next_cursor: str
    data: str = ""
    truncated: bool = False
    completed: bool = False
    status: str | None = None


class ExecutionLogsResponse(BaseModel):
    """Pageable logs for short bash/python/node executions (B3)."""

    stdout: str = ""
    stderr: str = ""
    next_offset: int = 0
    completed: bool = False
    truncated: bool = False
    full_log_location: str | None = None
    log_total: int = 0


class ExecutionEventResponse(BaseModel):
    """Sequenced execution lifecycle / delta event (B3)."""

    event_id: str
    source_type: str
    source_id: str
    sequence: int
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    run_id: str | None = None
    created_at: str = ""


class ProcessStdinRequest(BaseModel):
    data: str = Field(..., description="Text to write to process stdin")
    eof: bool = Field(default=False, description="Close stdin after write")


class ProcessSignalRequest(BaseModel):
    signal: str = Field(
        default="SIGTERM",
        description="POSIX signal name or number (SIGTERM, SIGINT, SIGKILL, …)",
    )


class ProcessWaitRequest(BaseModel):
    timeout: float | None = Field(
        default=None,
        description="Seconds to wait; null waits until terminal (or server default)",
    )
