"""Sandbox Configuration — loaded from environment / .env file."""

from __future__ import annotations

from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # ── Service ──────────────────────────────────────────────────────
    host: str = "0.0.0.0"
    port: int = 8081
    debug: bool = False

    # ── Paths ────────────────────────────────────────────────────────
    workspaces_root: str = "/sandbox/workspaces"
    skills_root: str = "/sandbox/skills"

    # ── Resource limits ──────────────────────────────────────────────
    execution_timeout_seconds: int = 120
    max_output_chars: int = 50_000
    max_process_count: int = 20
    max_cpu_time_seconds: int = 300
    max_memory_mb: int = 512
    max_file_size_mb: int = 50
    workspace_quota_mb: int = 500

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

    # ── Logging ──────────────────────────────────────────────────────
    log_level: str = "INFO"
    sensitive_keys: list[str] = [
        "password", "secret", "token", "api_key",
        "authorization", "cookie", "auth", "key",
    ]

    # ── Database ─────────────────────────────────────────────────────
    database_url: str = "sqlite:////sandbox/data/sandbox.db"

    @property
    def workspaces_path(self) -> Path:
        return Path(self.workspaces_root)

    @property
    def skills_path(self) -> Path:
        return Path(self.skills_root)

    model_config = {"env_prefix": "SANDBOX_"}


settings = Settings()
