"""Pydantic models for Sandbox Service."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


# ── Enums ──────────────────────────────────────────────────────────────

class SessionStatus(str, Enum):
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"


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


class ToolExecutionMode(str, Enum):
    DIRECT = "direct"  # sandbox runtime via subprocess
    HTTP_API = "http_api"  # sandbox HTTP API


# ── Session ────────────────────────────────────────────────────────────

class SessionCreate(BaseModel):
    agent_session_id: str | None = None
    enterprise_session_id: str | None = None
    user_id: str | None = None
    caller_id: str = "unknown"
    metadata: dict[str, Any] = Field(default_factory=dict)
    # Public binding source of truth. workspace_id is a compatibility
    # assertion and is rejected without conversation_id or when mismatched.
    conversation_id: str | None = None
    workspace_id: str | None = None


class SessionResponse(BaseModel):
    session_id: str
    agent_session_id: str | None = None
    enterprise_session_id: str | None = None
    user_id: str | None = None
    caller_id: str = "unknown"
    status: SessionStatus = SessionStatus.RUNNING
    # Opaque workspace identity (never a host physical path).
    workspace_id: str | None = None
    created_at: str = ""
    updated_at: str = ""
    # Public metadata only — internal keys (``_physical_workspace`` …) stripped.
    metadata: dict[str, Any] = Field(default_factory=dict)


# ── Execution ──────────────────────────────────────────────────────────

class PythonExecutionRequest(BaseModel):
    code: str = Field(..., description="Python code string to execute")
    timeout: int | None = None
    env_overrides: dict[str, str] = Field(default_factory=dict)


class CommandExecutionRequest(BaseModel):
    command: str = Field(..., description="Shell command to execute")
    timeout: int | None = None
    env_overrides: dict[str, str] = Field(default_factory=dict)


class NodeExecutionRequest(BaseModel):
    code: str = Field(..., description="Node.js code string to execute")
    timeout: int | None = None
    env_overrides: dict[str, str] = Field(default_factory=dict)


class ExecutionResponse(BaseModel):
    execution_id: str
    session_id: str
    status: ExecutionStatus = ExecutionStatus.PENDING
    stdout_preview: str = ""
    stderr_preview: str = ""
    exit_code: int | None = None
    duration_ms: float = 0.0
    truncated: bool = False
    trace_id: str | None = None


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


# ── Artifact ───────────────────────────────────────────────────────────

class ArtifactRegister(BaseModel):
    name: str
    path: str
    mime_type: str = "application/octet-stream"
    source_execution_id: str | None = None


class ArtifactResponse(BaseModel):
    artifact_id: str
    name: str
    path: str
    mime_type: str
    source_execution_id: str | None = None
    size: int = 0
    created_at: str = ""


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


class ApprovalCheckRequest(BaseModel):
    tool_name: str
    command: str | None = None
    path: str | None = None
    timeout: int | None = None
    file_size: int | None = None
    # Stable execution-attempt key. Retries with the same key reuse the
    # durable approval instead of creating another human gate.
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=255)


class ApprovalCreateRequest(BaseModel):
    """Durable Agent Host interaction gate (also used by external MCP calls)."""

    session_id: str
    tool_name: str
    risk_level: RiskLevel = RiskLevel.HIGH
    reason: str = "approval required"
    payload: dict[str, Any] = Field(default_factory=dict)
    idempotency_key: str | None = Field(default=None, min_length=1, max_length=255)


class ApprovalDecisionRequest(BaseModel):
    approval_id: str
    decision: str = Field(..., pattern="^(approve|reject)$")


class ApprovalResponse(BaseModel):
    approval_id: str | None = None
    idempotency_key: str | None = None
    status: str
    risk_level: RiskLevel
    reason: str = ""
    decision: str | None = None  # allow | approval_required | hard_deny
    policy_version: str | None = None
    approval_bypassed: bool = False


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


# ── Conversation ────────────────────────────────────────────────────────

class ConversationResponse(BaseModel):
    id: str
    title: str = "New conversation"
    sandbox_session_id: str | None = None
    # Logical Pi SDK agent session bound 1:1 with this conversation (ADR 0002 §7).
    agent_session_id: str | None = None
    # Opaque conversation workspace id (e.g. conv_<id>); never a host path.
    workspace_id: str | None = None
    messages: list[dict[str, Any]] = Field(default_factory=list)
    owner_user_id: str | None = None
    organization_id: str | None = None
    interrupted: bool = False
    last_run_id: str | None = None
    legal_hold: bool = False
    created_at: str = ""
    updated_at: str = ""


class ConversationCreate(BaseModel):
    id: str | None = None
    title: str | None = None  # None = leave unchanged on PATCH
    sandbox_session_id: str | None = None
    agent_session_id: str | None = None
    # None on PATCH means "do not replace messages"; empty list is a valid clear
    messages: list[dict[str, Any]] | None = None
    owner_user_id: str | None = None
    organization_id: str | None = None
    interrupted: bool | None = None
    last_run_id: str | None = None
    legal_hold: bool | None = None


# ── Agent run / event / tool ledger ─────────────────────────────────────

class AgentRunStatus(str, Enum):
    PENDING = "pending"
    RUNNING = "running"
    WAITING_APPROVAL = "waiting_approval"
    WAITING_INPUT = "waiting_input"
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"
    FAILED = "failed"
    CANCELLED = "cancelled"
    BUDGET_EXCEEDED = "budget_exceeded"
    REJECTED = "rejected"


class ToolExecutionStatus(str, Enum):
    PREPARED = "prepared"
    WAITING_APPROVAL = "waiting_approval"
    EXECUTING = "executing"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
    UNKNOWN = "unknown"


# Terminal tool statuses — never auto-retry (especially ``unknown``).
TOOL_TERMINAL_STATUSES = frozenset(
    {
        ToolExecutionStatus.SUCCEEDED.value,
        ToolExecutionStatus.FAILED.value,
        ToolExecutionStatus.CANCELLED.value,
        ToolExecutionStatus.UNKNOWN.value,
    }
)


class AgentRunBudget(BaseModel):
    """Optional per-run budget limits (ADR §4.9). Null field = unlimited."""

    max_steps: int | None = None
    max_tool_calls: int | None = None
    max_run_duration: int | None = None
    max_llm_tokens: int | None = None
    max_cost: float | None = None
    max_consecutive_tool_failures: int | None = None
    max_processes: int | None = None


class AgentRunCreate(BaseModel):
    run_id: str | None = None
    conversation_id: str
    owner_user_id: str | None = None
    organization_id: str | None = None
    sandbox_session_id: str | None = None
    workspace_id: str | None = None
    model_id: str | None = None
    lease_owner: str | None = None
    lease_seconds: int = 120
    budget: AgentRunBudget | dict[str, Any] | None = None


class AgentRunResponse(BaseModel):
    run_id: str
    conversation_id: str
    owner_user_id: str | None = None
    organization_id: str | None = None
    status: str = AgentRunStatus.PENDING.value
    lease_owner: str | None = None
    lease_until: str | None = None
    version: int = 0
    sandbox_session_id: str | None = None
    workspace_id: str | None = None
    model_id: str | None = None
    budget_json: dict[str, Any] | None = None
    pending_approval_json: dict[str, Any] | None = None
    pending_input_json: dict[str, Any] | None = None
    # B7: actual model tokens/cost recorded at run completion
    usage: dict[str, Any] | None = None
    created_at: str = ""
    updated_at: str = ""


class AgentEventAppend(BaseModel):
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    event_id: str | None = None
    schema_version: int = 1


class AgentEventResponse(BaseModel):
    run_id: str
    sequence: int
    event_id: str
    type: str
    payload: dict[str, Any] = Field(default_factory=dict)
    schema_version: int = 1
    created_at: str = ""


class ToolExecutionPrepare(BaseModel):
    """Prepare a tool call ledger row (idempotent on tool_call_id / idempotency_key)."""

    tool_call_id: str
    run_id: str
    idempotency_key: str
    tool_name: str | None = None
    arguments: dict[str, Any] | None = None
    session_id: str | None = None
    conversation_id: str | None = None
    workspace_id: str | None = None
    execution_id: str | None = None
    summary: str | None = None


class ToolExecutionResponse(BaseModel):
    """Full ADR §4.4 tool execution ledger row."""

    tool_call_id: str
    run_id: str
    status: str = ToolExecutionStatus.PREPARED.value
    idempotency_key: str
    tool_name: str | None = None
    arguments: dict[str, Any] | None = None
    session_id: str | None = None
    conversation_id: str | None = None
    workspace_id: str | None = None
    execution_id: str | None = None
    started_at: str | None = None
    finished_at: str | None = None
    result_summary: str | None = None
    error: str | None = None
    result_json: dict[str, Any] | None = None
    # Backward-compat alias of result_summary (older clients / dual-write)
    summary: str | None = None
    created_at: str = ""
    updated_at: str = ""


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


class ClaimLeaseRequest(BaseModel):
    lease_owner: str
    expected_version: int | None = None
    lease_seconds: int = 120


class RenewLeaseRequest(BaseModel):
    lease_owner: str
    lease_seconds: int = 120


# ── Logical Pi SDK Agent Session (ADR 0002 §7) ──────────────────────────

class AgentSessionStatus(str, Enum):
    ACTIVE = "active"
    COMPACTED = "compacted"
    FAILED = "failed"
    ARCHIVED = "archived"


class AgentSessionCreate(BaseModel):
    conversation_id: str
    sdk_session_id: str | None = None
    workspace_id: str | None = None
    sandbox_session_id: str | None = None
    model_id: str | None = None
    thinking_level: str | None = None
    system_prompt_version: str | None = None
    tool_registry_version: str | None = None
    sdk_version: str | None = None
    session_schema_version: int = 3
    header_payload: dict[str, Any] = Field(default_factory=dict)
    # Optional stable id (agent generates asess_…)
    id: str | None = None


class AgentSessionResponse(BaseModel):
    id: str
    conversation_id: str
    sdk_session_id: str | None = None
    workspace_id: str | None = None
    sandbox_session_id: str | None = None
    status: str = AgentSessionStatus.ACTIVE.value
    model_id: str | None = None
    thinking_level: str | None = None
    system_prompt_version: str | None = None
    tool_registry_version: str | None = None
    sdk_version: str | None = None
    session_schema_version: int = 3
    header_payload: dict[str, Any] = Field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""
    last_compacted_at: str | None = None
    entry_count: int = 0


class AgentSessionEntryAppend(BaseModel):
    """Single SDK session entry to append (full raw payload)."""

    entry_type: str
    entry_payload: dict[str, Any] = Field(default_factory=dict)
    # Prefer SDK entry id when available
    id: str | None = None
    parent_entry_id: str | None = None
    branch_id: str | None = None
    sequence: int | None = None


class AgentSessionEntriesAppend(BaseModel):
    """Batch append of new SDK entries (live-persist during run)."""

    entries: list[AgentSessionEntryAppend] = Field(default_factory=list)
    # Optional header / metadata refresh
    header_payload: dict[str, Any] | None = None
    sdk_session_id: str | None = None
    model_id: str | None = None
    thinking_level: str | None = None
    last_compacted_at: str | None = None
    status: str | None = None


class AgentSessionEntryResponse(BaseModel):
    id: str
    agent_session_id: str
    sequence: int
    entry_type: str
    entry_payload: dict[str, Any] = Field(default_factory=dict)
    parent_entry_id: str | None = None
    branch_id: str | None = None
    created_at: str = ""


class AgentSessionResumeResponse(BaseModel):
    """Payload for SessionManager.open materialization."""

    session: AgentSessionResponse
    entries: list[AgentSessionEntryResponse] = Field(default_factory=list)
    # Header + entries as JSONL lines (ready to write to a temp file)
    jsonl: str = ""

# ── Managed process (Process Manager / B2) ──────────────────────────────

class ProcessStatus(str, Enum):
    """Lifecycle states for managed long-running processes (ADR §8.3)."""

    CREATED = "created"
    RUNNING = "running"
    WAITING_INPUT = "waiting_input"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"
    ORPHANED = "orphaned"


PROCESS_TERMINAL_STATUSES = frozenset(
    {
        ProcessStatus.COMPLETED.value,
        ProcessStatus.FAILED.value,
        ProcessStatus.CANCELLED.value,
        ProcessStatus.TIMEOUT.value,
        ProcessStatus.ORPHANED.value,
        ProcessStatus.COMPLETED,
        ProcessStatus.FAILED,
        ProcessStatus.CANCELLED,
        ProcessStatus.TIMEOUT,
        ProcessStatus.ORPHANED,
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
        description="Seconds before process is marked timeout and killed; null = no limit",
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


class ProcessLogsResponse(BaseModel):
    stdout: str = ""
    stderr: str = ""
    next_offset: int = 0
    completed: bool = False
    truncated: bool = False
    # When truncated=true, clients can pull full logs from this path (B3).
    full_log_location: str | None = None
    log_total: int = 0


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
