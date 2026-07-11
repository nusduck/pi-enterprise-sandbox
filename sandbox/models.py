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
    reason: str = ""
    risk_level: RiskLevel = RiskLevel.LOW


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
