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
    # Bind to conversation-owned workspace (preferred over raw physical path).
    conversation_id: str | None = None
    workspace_id: str | None = None
    # Legacy: physical path override for rebinding. Logical path is ignored.
    workspace_path: str | None = None


class SessionResponse(BaseModel):
    session_id: str
    agent_session_id: str | None = None
    enterprise_session_id: str | None = None
    user_id: str | None = None
    caller_id: str = "unknown"
    status: SessionStatus = SessionStatus.RUNNING
    workspace_path: str = ""
    created_at: str = ""
    updated_at: str = ""
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
    policy_version: str = "2026-07-11.1"


class ApprovalCheckRequest(BaseModel):
    tool_name: str
    command: str | None = None
    path: str | None = None
    timeout: int | None = None
    file_size: int | None = None


class ApprovalDecisionRequest(BaseModel):
    approval_id: str
    decision: str = Field(..., pattern="^(approve|reject)$")


class ApprovalResponse(BaseModel):
    approval_id: str | None = None
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


# ── Conversation ────────────────────────────────────────────────────────

class ConversationResponse(BaseModel):
    id: str
    title: str = "New conversation"
    sandbox_session_id: str | None = None
    workspace_path: str | None = None
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
    workspace_path: str | None = None
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
    COMPLETED = "completed"
    INTERRUPTED = "interrupted"
    FAILED = "failed"
    CANCELLED = "cancelled"


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


class AgentRunCreate(BaseModel):
    conversation_id: str
    owner_user_id: str | None = None
    organization_id: str | None = None
    sandbox_session_id: str | None = None
    workspace_id: str | None = None
    model_id: str | None = None
    lease_owner: str | None = None
    lease_seconds: int = 120


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
    tool_call_id: str
    run_id: str
    idempotency_key: str
    summary: str | None = None


class ToolExecutionResponse(BaseModel):
    tool_call_id: str
    run_id: str
    status: str = ToolExecutionStatus.PREPARED.value
    idempotency_key: str
    summary: str | None = None
    created_at: str = ""
    updated_at: str = ""


class ClaimLeaseRequest(BaseModel):
    lease_owner: str
    expected_version: int | None = None
    lease_seconds: int = 120
