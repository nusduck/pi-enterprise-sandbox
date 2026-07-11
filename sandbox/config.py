"""Sandbox Configuration — loaded from environment / .env file."""

from __future__ import annotations

from pathlib import Path

from pydantic_settings import BaseSettings

from sandbox.paths import AGENT_SKILL_PATH, AGENT_WORKSPACE_PATH

# Host-safe local defaults (container/compose override via SANDBOX_* env vars).
_LOCAL_DATA_ROOT = Path.home() / ".pi-enterprise-sandbox"


class Settings(BaseSettings):
    # ── Service ──────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8081
    debug: bool = False

    # ── Paths (physical storage) ─────────────────────────────────────
    # Physical per-session workspaces live under workspaces_root/{session_id}.
    # Agent-visible logical path is always agent_workspace_path.
    workspaces_root: str = str(_LOCAL_DATA_ROOT / "workspaces")
    # Shared skills tree (read-only in containers). Default aligns with P3.
    skills_root: str = str(_LOCAL_DATA_ROOT / "skill")

    # Agent-visible stable paths (logical; not necessarily physical)
    agent_workspace_path: str = AGENT_WORKSPACE_PATH
    agent_skill_path: str = AGENT_SKILL_PATH

    # Global /home/sandbox/workspace symlink is concurrent-unsafe; off by default.
    # Prefer physical per-session cwd + logical path mapping in API/agent surfaces.
    enable_global_workspace_symlink: bool = False

    # ── Resource limits ──────────────────────────────────────────────
    execution_timeout_seconds: int = 120
    max_output_chars: int = 50_000
    max_process_count: int = 20
    max_cpu_time_seconds: int = 300
    max_memory_mb: int = 512
    max_file_size_mb: int = 50
    workspace_quota_mb: int = 500
    # Attachment upload limits (parent task P-00F1 defaults)
    max_attachments_per_turn: int = 10
    max_turn_attachment_mb: int = 200

    # ── Network ──────────────────────────────────────────────────────
    block_metadata_ips: bool = True
    default_deny_network: bool = True

    # ── Session TTL ──────────────────────────────────────────────────
    session_ttl_minutes: int = 30
    cleanup_interval_minutes: int = 5

    # ── Approval ─────────────────────────────────────────────────────
    approval_timeout_seconds: int = 300

    # ── MCP ──────────────────────────────────────────────────────────
    mcp_enabled: bool = True
    mcp_host: str = "0.0.0.0"
    mcp_port: int = 8091
    mcp_auth_tokens: list[str] = []

    # ── Auth ─────────────────────────────────────────────────────────
    api_token: str = ""  # If set, all endpoints require X-API-Key header
    api_token_header: str = "X-API-Key"
    # Optional JWT user auth (multi-user foundation). Off by default.
    auth_enabled: bool = False
    jwt_secret: str = ""
    jwt_ttl_seconds: int = 86400

    # ── Logging ──────────────────────────────────────────────────────
    log_level: str = "INFO"
    sensitive_keys: list[str] = [
        "password", "secret", "token", "api_key",
        "authorization", "cookie", "auth", "key",
    ]

    # ── Database ─────────────────────────────────────────────────────
    # Host-safe default; compose sets sqlite:////sandbox/data/sandbox.db
    database_url: str = f"sqlite:///{_LOCAL_DATA_ROOT / 'data' / 'sandbox.db'}"

    @property
    def workspaces_path(self) -> Path:
        return Path(self.workspaces_root)

    @property
    def skills_path(self) -> Path:
        return Path(self.skills_root)

    model_config = {"env_prefix": "SANDBOX_"}


settings = Settings()
