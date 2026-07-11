"""Sandbox Configuration — loaded from environment / .env file."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, Any

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode

from sandbox.paths import AGENT_SKILL_PATH, AGENT_WORKSPACE_PATH
from sandbox.security.network_policy import (
    DEFAULT_ALLOWED_CLIENT_CIDRS,
    DEFAULT_TRUSTED_PROXY_CIDRS,
    NetworkPolicyConfigError,
    build_network_policy_from_settings,
    parse_csv_or_list,
)

# Host-safe local defaults (container/compose override via SANDBOX_* env vars).
_LOCAL_DATA_ROOT = Path.home() / ".pi-enterprise-sandbox"


class Settings(BaseSettings):
    # ── Service ──────────────────────────────────────────────────────
    # Listen address. ``bind_host`` is canonical (SANDBOX_BIND_HOST);
    # ``host`` (SANDBOX_HOST) remains as a backward-compatible alias.
    bind_host: str = "0.0.0.0"
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

    # ── Network (outbound process isolation) ─────────────────────────
    block_metadata_ips: bool = True
    default_deny_network: bool = True

    # ── Network (inbound client allowlist / trusted proxies) ─────────
    # Comma-separated CIDRs. Empty allowlist = deny all (never allow-all).
    # Defaults cover loopback + Docker/compose private ranges; tighten to
    # loopback-only on bare-metal hosts that do not need container peers.
    # NoDecode: operators pass CSV, not JSON arrays.
    allowed_client_cidrs: Annotated[list[str], NoDecode] = list(
        DEFAULT_ALLOWED_CLIENT_CIDRS
    )
    # Empty by default: X-Forwarded-For is ignored; TCP peer is authoritative.
    trusted_proxy_cidrs: Annotated[list[str], NoDecode] = list(
        DEFAULT_TRUSTED_PROXY_CIDRS
    )

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

    @field_validator("allowed_client_cidrs", "trusted_proxy_cidrs", mode="before")
    @classmethod
    def _split_cidr_env(cls, value: Any) -> list[str]:
        # Operators pass comma-separated CIDRs; JSON arrays also accepted.
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                import json

                try:
                    loaded = json.loads(text)
                except json.JSONDecodeError:
                    loaded = None
                if isinstance(loaded, list):
                    return parse_csv_or_list(loaded)
            return parse_csv_or_list(text)
        return parse_csv_or_list(value)

    @model_validator(mode="after")
    def _resolve_bind_host_and_validate_network(self) -> Settings:
        """Prefer SANDBOX_BIND_HOST; fall back to SANDBOX_HOST; validate CIDRs."""
        import os

        # Explicit env wins: BIND_HOST over HOST when both differ from defaults.
        env_bind = os.environ.get("SANDBOX_BIND_HOST")
        env_host = os.environ.get("SANDBOX_HOST")
        if env_bind is not None and env_bind.strip():
            object.__setattr__(self, "bind_host", env_bind.strip())
        elif env_host is not None and env_host.strip():
            # Legacy SANDBOX_HOST only — mirror into bind_host.
            object.__setattr__(self, "bind_host", env_host.strip())
            object.__setattr__(self, "host", env_host.strip())
        else:
            # Keep bind_host / host consistent when set via kwargs in tests.
            if self.bind_host and self.bind_host != "0.0.0.0":
                object.__setattr__(self, "host", self.bind_host)
            elif self.host and self.host != "0.0.0.0" and self.bind_host == "0.0.0.0":
                object.__setattr__(self, "bind_host", self.host)

        # Fail fast on illegal CIDR / empty bind — never treat as allow-all.
        try:
            build_network_policy_from_settings(self)
        except NetworkPolicyConfigError as exc:
            raise ValueError(str(exc)) from exc
        return self

    @property
    def workspaces_path(self) -> Path:
        return Path(self.workspaces_root)

    @property
    def skills_path(self) -> Path:
        return Path(self.skills_root)

    model_config = {"env_prefix": "SANDBOX_"}


settings = Settings()
