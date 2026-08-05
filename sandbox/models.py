"""Pydantic models for Sandbox Service."""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, Field


# ── Enums ──────────────────────────────────────────────────────────────

class ExecutionStatus(str, Enum):
    """In-memory / API execution status for legacy execution_manager paths.

    Formal MySQL lifecycle uses SANDBOX_EXECUTION_STATUS_* in
    ``sandbox.app.domain.types`` (RUNNING → SUCCESS|FAILED|TIMEOUT|CANCELLED|UNKNOWN).
    Sandbox HITL statuses (PENDING_APPROVAL/APPROVED/REJECTED) are gone — Agent
    durable approval owns product HITL.
    """

    PENDING = "PENDING"
    RUNNING = "RUNNING"
    SUCCESS = "SUCCESS"
    FAILED = "FAILED"
    TIMEOUT = "TIMEOUT"
    CANCELLED = "CANCELLED"


class RiskLevel(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


class PolicyDecision(str, Enum):
    """Sandbox tool policy outcome.

    Product model: allow | hard_deny only at the sandbox boundary.
    Agent durable approval is the product HITL gate (not this enum).
    """

    ALLOW = "allow"
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
    # Two-tier at sandbox boundary: allow | hard_deny
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
    # Replica identity. Every workspace is bound to exactly one node, so knowing
    # which replica answered a probe is the difference between "the service is
    # broken" and "one shard is broken". Generation 0 means the node has not
    # registered (internal plane disabled — single-process development).
    node_id: str = ""
    node_generation: int = 0
    node_draining: bool = False


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
