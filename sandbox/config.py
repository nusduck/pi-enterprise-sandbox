"""Sandbox Configuration — loaded from environment / .env file.

Priority (pydantic-settings): explicit kwargs → process env → env file → defaults.
Sensitive values never appear in :func:`effective_config` output.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

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

DeploymentEnv = Literal["development", "production"]
NetworkMode = Literal["disabled", "allowlist", "unrestricted"]

# Production JWT secret must be high-entropy (recommend: openssl rand -hex 32).
_MIN_JWT_SECRET_LEN = 32
_WEAK_SECRET_MARKERS = (
    "change-me",
    "changeme",
    "dev-only",
    "secret",
    "password",
    "example",
    "replace",
    "todo",
    "xxx",
)


class ProductionConfigError(ValueError):
    """Raised when production settings are unsafe; process must exit before listen."""


def _normalize_deployment_env(value: str | None) -> str:
    raw = (value or "development").strip().lower()
    if raw in ("prod", "production"):
        return "production"
    if raw in ("dev", "development", "local", "test"):
        return "development"
    # Unknown values fail closed to development for local tests; production
    # matrix still requires an explicit "production" string.
    return raw if raw in ("development", "production") else "development"


def _normalize_network_mode(value: str | None) -> str:
    raw = (value or "disabled").strip().lower()
    aliases = {
        "off": "disabled",
        "none": "disabled",
        "deny": "disabled",
        "block": "disabled",
        "disabled": "disabled",
        "allow": "allowlist",
        "allowlist": "allowlist",
        "whitelist": "allowlist",
        "open": "unrestricted",
        "unrestricted": "unrestricted",
        "full": "unrestricted",
    }
    mode = aliases.get(raw, raw)
    if mode not in ("disabled", "allowlist", "unrestricted"):
        raise ValueError(
            f"Invalid SANDBOX_NETWORK_MODE={value!r}; "
            "expected disabled|allowlist|unrestricted"
        )
    return mode


def _is_weak_secret(value: str) -> bool:
    text = (value or "").strip()
    if len(text) < _MIN_JWT_SECRET_LEN:
        return True
    lower = text.lower()
    return any(marker in lower for marker in _WEAK_SECRET_MARKERS)


def _looks_like_secret_key(name: str) -> bool:
    lower = name.lower()
    return any(
        token in lower
        for token in (
            "token",
            "secret",
            "password",
            "api_key",
            "apikey",
            "authorization",
            "credential",
            "dsn",
            "database_url",
            "private",
        )
    )


class Settings(BaseSettings):
    # ── Deployment ───────────────────────────────────────────────────
    # Canonical: DEPLOYMENT_ENV (no prefix). Also accepts SANDBOX_DEPLOYMENT_ENV.
    deployment_env: str = "development"

    # ── Service ──────────────────────────────────────────────────────
    # Listen address. ``bind_host`` is canonical (SANDBOX_BIND_HOST);
    # ``host`` (SANDBOX_HOST) remains as a backward-compatible alias.
    bind_host: str = "0.0.0.0"
    host: str = "0.0.0.0"
    port: int = 8081
    debug: bool = False

    # ── Paths (physical storage) ─────────────────────────────────────
    # Physical per-session workspaces live under workspaces_root/{workspace_id}.
    # Public API/SSE/tools use opaque workspace_id + relative paths only.
    workspaces_root: str = str(_LOCAL_DATA_ROOT / "workspaces")
    # Shared skills tree (read-only in containers).
    skills_root: str = str(_LOCAL_DATA_ROOT / "skill")

    # Legacy absolute presentation paths (internal only; not public contract).
    agent_workspace_path: str = AGENT_WORKSPACE_PATH
    agent_skill_path: str = AGENT_SKILL_PATH

    # Global presentation symlink is concurrent-unsafe; off by default.
    # Prefer physical per-session cwd + relative path contract on public surfaces.
    enable_global_workspace_symlink: bool = False

    # ── Resource limits ──────────────────────────────────────────────
    execution_timeout_seconds: int = 120
    max_output_chars: int = 50_000
    max_process_count: int = 20
    # Concurrent managed long-running processes (B2 Process Manager).
    max_managed_processes: int = 32
    max_cpu_time_seconds: int = 300
    max_memory_mb: int = 512
    max_file_size_mb: int = 50
    workspace_quota_mb: int = 500
    # Attachment upload limits (parent task P-00F1 defaults)
    max_attachments_per_turn: int = 10
    max_turn_attachment_mb: int = 200

    # ── Network (outbound process isolation) ─────────────────────────
    # Single mode drives command policy (default_deny_network) and should
    # match iptables posture set by entrypoint via the same env var.
    # disabled | allowlist | unrestricted
    network_mode: str = "disabled"
    # Hard security invariant: link-local / cloud metadata is always blocked.
    # Env may not disable this (enforced in model_validator).
    block_metadata_ips: bool = True
    # Derived from network_mode when unset; retained for backward-compatible tests.
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

    # ── CORS ─────────────────────────────────────────────────────────
    # Development may use "*"; production requires an explicit allowlist
    # and forbids wildcard + credentials together.
    cors_origins: Annotated[list[str], NoDecode] = ["*"]
    cors_allow_credentials: bool = True

    # ── Session TTL ──────────────────────────────────────────────────
    session_ttl_minutes: int = 30
    cleanup_interval_minutes: int = 5

    # ── Conversation / audit retention (agent session persistence) ───
    # Draft (empty / never continued) conversations: 24h
    draft_ttl_hours: int = 24
    # Active conversations without activity: 90 days
    conversation_ttl_days: int = 90
    # Audit / agent_events retention: 180 days
    audit_ttl_days: int = 180

    # ── Approval ─────────────────────────────────────────────────────
    approval_timeout_seconds: int = 300
    # When false, approval_required tools auto-execute with bypass audit;
    # hard_deny is never overridden. Default true (safe production posture).
    approval_enabled: bool = True

    # ── MCP ──────────────────────────────────────────────────────────
    mcp_enabled: bool = True
    mcp_host: str = "0.0.0.0"
    mcp_port: int = 8091
    mcp_auth_tokens: Annotated[list[str], NoDecode] = []

    # ── Auth ─────────────────────────────────────────────────────────
    api_token: str = ""  # If set, all endpoints require X-API-Key header
    api_token_header: str = "X-API-Key"
    # Optional JWT user auth (multi-user foundation). Off by default.
    auth_enabled: bool = False
    jwt_secret: str = ""
    jwt_ttl_seconds: int = 86400
    jwt_issuer: str = "pi-enterprise-sandbox"
    jwt_audience: str = "pi-enterprise-sandbox"
    # Public self-registration. Production must disable (admin invite only).
    auth_allow_public_register: bool = True

    # ── Logging ──────────────────────────────────────────────────────
    log_level: str = "INFO"
    sensitive_keys: list[str] = [
        "password", "secret", "token", "api_key",
        "authorization", "cookie", "auth", "key",
    ]

    # ── Database ─────────────────────────────────────────────────────
    # Host-safe default; compose sets sqlite:////sandbox/data/sandbox.db
    database_url: str = f"sqlite:///{_LOCAL_DATA_ROOT / 'data' / 'sandbox.db'}"

    model_config = SettingsConfigDict(
        env_prefix="SANDBOX_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # Prefer process env over .env file (standard) — already the case.
    )

    @field_validator("allowed_client_cidrs", "trusted_proxy_cidrs", "cors_origins", mode="before")
    @classmethod
    def _split_list_env(cls, value: Any) -> list[str]:
        # Operators pass comma-separated values; JSON arrays also accepted.
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

    @field_validator("mcp_auth_tokens", mode="before")
    @classmethod
    def _split_mcp_tokens(cls, value: Any) -> list[str]:
        if value is None or value == "":
            return []
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                import json

                try:
                    loaded = json.loads(text)
                except json.JSONDecodeError:
                    loaded = None
                if isinstance(loaded, list):
                    return [str(x).strip() for x in loaded if str(x).strip()]
            return [part.strip() for part in text.split(",") if part.strip()]
        if isinstance(value, list):
            return [str(x).strip() for x in value if str(x).strip()]
        return []

    @field_validator("network_mode", mode="before")
    @classmethod
    def _validate_network_mode(cls, value: Any) -> str:
        return _normalize_network_mode(None if value is None else str(value))

    @field_validator("deployment_env", mode="before")
    @classmethod
    def _validate_deployment_env(cls, value: Any) -> str:
        return _normalize_deployment_env(None if value is None else str(value))

    @model_validator(mode="after")
    def _resolve_bind_host_network_and_policy(self) -> Settings:
        """Prefer SANDBOX_BIND_HOST; fall back to SANDBOX_HOST; derive network; validate CIDRs."""
        # Unprefixed DEPLOYMENT_ENV (compose/.env) when not set via kwargs /
        # SANDBOX_DEPLOYMENT_ENV. Do not clobber explicit constructor values.
        if "deployment_env" not in self.model_fields_set:
            env_dep = os.environ.get("DEPLOYMENT_ENV")
            if env_dep is not None and env_dep.strip():
                object.__setattr__(
                    self, "deployment_env", _normalize_deployment_env(env_dep)
                )

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

        # Network mode → command-policy default_deny_network.
        # Explicit SANDBOX_DEFAULT_DENY_NETWORK still honored only in development
        # when network_mode is not unrestricted (prod forbids unrestricted).
        mode = self.network_mode
        if mode == "disabled":
            object.__setattr__(self, "default_deny_network", True)
        elif mode in ("allowlist", "unrestricted"):
            object.__setattr__(self, "default_deny_network", False)

        # Hard invariant: metadata IPs cannot be opened via env.
        object.__setattr__(self, "block_metadata_ips", True)

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

    @property
    def is_production(self) -> bool:
        return self.deployment_env == "production"

    @property
    def is_development(self) -> bool:
        return self.deployment_env == "development"


def validate_production_settings(s: Settings | None = None) -> None:
    """Fail fast on unsafe production combinations.

    Must run before the process accepts traffic (import-time or pre-listen).
    Development deployments are no-ops.
    """
    cfg = s or settings
    if not cfg.is_production:
        return

    errors: list[str] = []

    if not (cfg.api_token or "").strip():
        errors.append("SANDBOX_API_TOKEN must be non-empty in production")
    elif _is_weak_secret(cfg.api_token):
        errors.append(
            f"SANDBOX_API_TOKEN is weak or shorter than {_MIN_JWT_SECRET_LEN} characters"
        )

    if cfg.network_mode == "unrestricted":
        errors.append(
            "SANDBOX_NETWORK_MODE=unrestricted is forbidden in production "
            "(use disabled or allowlist)"
        )

    origins = [o.strip() for o in (cfg.cors_origins or []) if o and str(o).strip()]
    if not origins:
        errors.append("SANDBOX_CORS_ORIGINS must be an explicit allowlist in production")
    if any(o == "*" for o in origins):
        if cfg.cors_allow_credentials:
            errors.append(
                "CORS wildcard origin ('*') with credentials is forbidden in production"
            )
        else:
            errors.append(
                "CORS wildcard origin ('*') is forbidden in production; "
                "set SANDBOX_CORS_ORIGINS to an explicit allowlist"
            )

    if not cfg.auth_enabled:
        errors.append("SANDBOX_AUTH_ENABLED must be true in production")
    else:
        secret = (cfg.jwt_secret or "").strip()
        if not secret:
            errors.append("SANDBOX_JWT_SECRET must be set when auth is enabled in production")
        elif _is_weak_secret(secret):
            errors.append(
                f"SANDBOX_JWT_SECRET is weak or shorter than {_MIN_JWT_SECRET_LEN} characters"
            )
        if not (cfg.jwt_issuer or "").strip():
            errors.append("SANDBOX_JWT_ISSUER must be non-empty in production")
        if not (cfg.jwt_audience or "").strip():
            errors.append("SANDBOX_JWT_AUDIENCE must be non-empty in production")

    if cfg.auth_allow_public_register:
        errors.append(
            "SANDBOX_AUTH_ALLOW_PUBLIC_REGISTER must be false in production "
            "(admin pre-provision / invite only)"
        )

    if cfg.mcp_enabled and cfg.mcp_host in ("0.0.0.0", "::", "[::]"):
        tokens = [t for t in (cfg.mcp_auth_tokens or []) if t and str(t).strip()]
        # MCP on all interfaces without tokens is open to the network.
        if not tokens and not (cfg.api_token or "").strip():
            errors.append(
                "MCP listening on all interfaces requires SANDBOX_MCP_AUTH_TOKENS "
                "or SANDBOX_API_TOKEN in production"
            )

    if cfg.debug:
        errors.append("SANDBOX_DEBUG must be false in production")

    if errors:
        joined = "; ".join(errors)
        raise ProductionConfigError(
            f"Production configuration is unsafe ({len(errors)} issue(s)): {joined}"
        )


def effective_config(s: Settings | None = None) -> dict[str, Any]:
    """Return a redacted snapshot of effective settings for logs/diagnostics.

    Never includes tokens, secrets, full DSNs, or any value whose key looks
    sensitive. Database URLs are reduced to scheme + host-ish markers only.
    """
    cfg = s or settings
    data = cfg.model_dump()
    redacted: dict[str, Any] = {}
    for key, value in data.items():
        if _looks_like_secret_key(key):
            if key == "database_url":
                redacted[key] = _redact_database_url(str(value or ""))
            elif isinstance(value, list):
                redacted[key] = ["***"] if value else []
            elif value in (None, "", [], {}):
                redacted[key] = "<empty>"
            else:
                redacted[key] = "***"
            continue
        if isinstance(value, str) and _looks_like_embedded_secret(value):
            redacted[key] = "***"
            continue
        redacted[key] = value
    redacted["is_production"] = cfg.is_production
    redacted["network_mode"] = cfg.network_mode
    redacted["default_deny_network"] = cfg.default_deny_network
    redacted["block_metadata_ips"] = True  # invariant
    return redacted


def _redact_database_url(url: str) -> str:
    if not url:
        return "<empty>"
    # sqlite:////path → sqlite:///<redacted>
    if url.startswith("sqlite:"):
        return "sqlite:///<redacted>"
    # postgresql://user:pass@host:port/db → postgresql://***@host:port/<redacted>
    m = re.match(
        r"^(?P<scheme>[a-zA-Z0-9+]+)://(?P<creds>[^@]*)@(?P<host>[^/]+)(?:/(?P<db>.*))?$",
        url,
    )
    if m:
        host = m.group("host")
        return f"{m.group('scheme')}://***@{host}/<redacted>"
    m2 = re.match(r"^(?P<scheme>[a-zA-Z0-9+]+)://(?P<rest>.*)$", url)
    if m2:
        return f"{m2.group('scheme')}://<redacted>"
    return "<redacted>"


def _looks_like_embedded_secret(value: str) -> bool:
    lower = value.lower()
    if "://" in lower and any(
        p in lower for p in ("postgres", "mysql", "mongodb", "redis")
    ):
        return True
    return False


def ensure_safe_to_start(s: Settings | None = None) -> Settings:
    """Validate production posture; return settings for chaining."""
    cfg = s or settings
    validate_production_settings(cfg)
    return cfg


settings = Settings()
