"""Sandbox Configuration — loaded from environment / .env file.

Priority (pydantic-settings): explicit kwargs → process env → env file → defaults.
Sensitive values never appear in :func:`effective_config` output.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from collections.abc import Mapping
from typing import Annotated, Any, Literal

from pydantic import Field, PrivateAttr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from sandbox.paths import AGENT_SKILL_PATH, AGENT_WORKSPACE_PATH
from sandbox.security.network_policy import (
    DEFAULT_ALLOWED_CLIENT_CIDRS,
    DEFAULT_TRUSTED_PROXY_CIDRS,
    NetworkPolicyConfigError,
    build_network_policy_from_settings,
    parse_csv_or_list,
)

# Fixed internal-plane identity (must match Agent issuer and golden fixtures).
INTERNAL_TOKEN_ISSUER = "agent-service"
INTERNAL_TOKEN_AUDIENCE = "sandbox-service"
INTERNAL_TOKEN_SUBJECT = "agent-worker"
_MAX_INTERNAL_TOKEN_LEEWAY = 5

# Internal request body cap: fit 50 MiB file content as base64 inside JSON
# (~67 MiB payload + envelope) with headroom. Hard max prevents unbounded
# misconfiguration DoS while still allowing large write-style tools later.
_DEFAULT_INTERNAL_MAX_REQUEST_BODY_BYTES = 72 * 1024 * 1024  # 72 MiB
_HARD_MAX_INTERNAL_MAX_REQUEST_BODY_BYTES = 512 * 1024 * 1024  # 512 MiB

# Host-safe local defaults (container/compose override via SANDBOX_* env vars).
_LOCAL_DATA_ROOT = Path.home() / ".pi-enterprise-sandbox"

DeploymentEnv = Literal["development", "test", "production"]
ApprovalMode = Literal["ask", "auto_approve", "deny"]
NetworkMode = Literal["disabled", "allowlist", "unrestricted"]
IsolationBackendName = Literal["direct", "bubblewrap"]
PolicyProfile = Literal["strict", "balanced"]

# Canonical deployment environments and project-legal aliases only.
# Unknown values and explicit empty strings fail closed (never silently → development).
_DEPLOYMENT_ENV_ALIASES: dict[str, DeploymentEnv] = {
    "development": "development",
    "dev": "development",
    "local": "development",
    "test": "test",
    "production": "production",
    "prod": "production",
}

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

# Formal default DSN for Sandbox persistence (MySQL 8 + PyMySQL dialect).
# No password embedded — operators supply credentials via SANDBOX_DATABASE_URL
# or compose MYSQL_* substitution. Host-local placeholder for import-time only.
_DEFAULT_MYSQL_DATABASE_URL = "mysql+pymysql://sandbox@127.0.0.1:3306/sandbox"

# Accepted MySQL URL schemes for formal / production configuration.
_MYSQL_URL_PREFIXES = ("mysql://", "mysql+pymysql://", "mysql2://")


def database_url_scheme(url: str | None) -> str:
    """Return the URL scheme (lowercased) or empty string."""
    text = (url or "").strip()
    if not text or "://" not in text:
        return ""
    return text.split("://", 1)[0].lower()


def is_mysql_database_url(url: str | None) -> bool:
    """True when URL uses a formal MySQL scheme (mysql / mysql+pymysql / mysql2)."""
    text = (url or "").strip().lower()
    return any(text.startswith(prefix) for prefix in _MYSQL_URL_PREFIXES)


def is_legacy_test_database_url(url: str | None) -> bool:
    """True for sqlite/postgres DSNs used only by temporary unit-test injection.

    TEMPORARY GAP (PR-02 T5 topology/config track): pytest / conftest may still
    inject ``sqlite://`` (or legacy postgres) because ``sandbox.database`` has
    not been cut over to MySQL yet. That path is **not** a production fallback
    and is rejected by :func:`validate_production_settings`.
    """
    scheme = database_url_scheme(url)
    return scheme in ("sqlite", "postgresql", "postgres")


class ProductionConfigError(ValueError):
    """Raised when production settings are unsafe; process must exit before listen."""


def _normalize_deployment_env(value: str | None) -> str:
    """Map legal deployment env aliases; reject unknown / empty (fail closed).

    Accepted canonical values: ``development``, ``test``, ``production``.
    Project-legal aliases: ``dev`` / ``local`` → development, ``prod`` → production.
    Explicit empty strings and typos (e.g. ``producton``) raise ``ValueError`` —
    they must never silently degrade to development.
    """
    if value is None:
        raise ValueError(
            "DEPLOYMENT_ENV is required when set; expected development|test|production "
            "(aliases: dev|local|prod)"
        )
    if type(value) is not str:
        raise ValueError(
            f"Invalid DEPLOYMENT_ENV={value!r}; expected development|test|production "
            "(aliases: dev|local|prod)"
        )
    raw = value.strip().lower()
    if not raw:
        raise ValueError(
            "DEPLOYMENT_ENV must not be empty; expected development|test|production "
            "(aliases: dev|local|prod)"
        )
    mapped = _DEPLOYMENT_ENV_ALIASES.get(raw)
    if mapped is None:
        raise ValueError(
            f"Invalid DEPLOYMENT_ENV={value!r}; expected development|test|production "
            "(aliases: dev|local|prod). Unknown values fail closed and are not "
            "downgraded to development."
        )
    return mapped


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


def _normalize_policy_profile(value: str | None) -> str:
    raw = (value or "strict").strip().lower()
    profile = raw
    if profile not in ("strict", "balanced"):
        raise ValueError(
            f"Invalid SANDBOX_POLICY_PROFILE={value!r}; expected strict|balanced"
        )
    return profile


def _normalize_isolation_backend(value: str | None) -> str:
    raw = (value or "direct").strip().lower()
    if raw not in ("direct", "bubblewrap"):
        raise ValueError(
            f"Invalid SANDBOX_ISOLATION_BACKEND={value!r}; expected direct|bubblewrap"
        )
    return raw


def _normalize_approval_mode(value: Any) -> str:
    raw = str(value or "ask").strip().lower().replace("-", "_")
    if raw not in {"ask", "auto_approve", "deny"}:
        raise ValueError(
            f"Invalid APPROVAL_MODE={value!r}; expected ask|auto_approve|deny"
        )
    return raw


def _parse_approval_enabled(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    raw = str(value).strip().lower()
    if raw == "true":
        return True
    if raw == "false":
        return False
    raise ValueError(
        f"Invalid APPROVAL_ENABLED={value!r}; expected true or false"
    )


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
            "redis_url",
            "private",
            "keyring",
            "hmac",
        )
    )


def _positive_int_field(value: Any, *, name: str, minimum: int = 1, maximum: int) -> int:
    """Strict positive int for internal-plane / MySQL bound settings."""
    if type(value) is bool or type(value) is float:
        raise ValueError(f"{name} must be an integer {minimum}..{maximum}")
    if type(value) is int:
        n = value
    elif type(value) is str:
        text = value.strip()
        if not text or any(c not in "0123456789" for c in text):
            raise ValueError(f"{name} must be an integer {minimum}..{maximum}")
        n = int(text)
    else:
        raise ValueError(f"{name} must be an integer {minimum}..{maximum}")
    if not minimum <= n <= maximum:
        raise ValueError(f"{name} must be an integer {minimum}..{maximum}")
    return n


def _nonneg_int_field(value: Any, *, name: str, maximum: int) -> int:
    """Strict integer 0..maximum (0 = unlimited / unset for child rlimits)."""
    if type(value) is bool or type(value) is float:
        raise ValueError(f"{name} must be an integer 0..{maximum}")
    if type(value) is int:
        n = value
    elif type(value) is str:
        text = value.strip()
        if not text or any(c not in "0123456789" for c in text):
            raise ValueError(f"{name} must be an integer 0..{maximum}")
        n = int(text)
    else:
        raise ValueError(f"{name} must be an integer 0..{maximum}")
    if not 0 <= n <= maximum:
        raise ValueError(f"{name} must be an integer 0..{maximum}")
    return n


# Hard caps for misconfiguration (always enforced). Production tightens
# lower bounds further in validate_production_settings.
_HARD_MAX_PROCESS_COUNT = 65_536
_HARD_MAX_MEMORY_MB = 65_536
_HARD_MAX_CPU_TIME_SECONDS = 604_800  # 7d
_HARD_MAX_FILE_SIZE_MB = 102_400  # 100 GiB
_HARD_MAX_OPEN_FILES = 1_048_576
_HARD_MAX_OUTPUT_CHARS = 100_000_000
_HARD_MAX_EXECUTION_TIMEOUT = 604_800

# Production safe ranges for child hard limits (fail closed outside).
_PROD_RESOURCE_RANGES: dict[str, tuple[str, int, int]] = {
    # attr → (env name, min, max)
    "max_process_count": ("SANDBOX_MAX_PROCESS_COUNT", 1, 4_096),
    "max_memory_mb": ("SANDBOX_MAX_MEMORY_MB", 16, 65_536),
    "max_cpu_time_seconds": ("SANDBOX_MAX_CPU_TIME_SECONDS", 1, 86_400),
    "max_file_size_mb": ("SANDBOX_MAX_FILE_SIZE_MB", 1, 10_240),
    "max_open_files": ("SANDBOX_MAX_OPEN_FILES", 16, 65_536),
    "max_output_chars": ("SANDBOX_MAX_OUTPUT_CHARS", 1_024, 50_000_000),
    "execution_timeout_seconds": ("SANDBOX_EXECUTION_TIMEOUT_SECONDS", 1, 86_400),
}


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
    # Public surfaces use opaque workspace_id plus relative/logical paths;
    # physical storage paths never leave the Sandbox service.
    workspaces_root: str = str(_LOCAL_DATA_ROOT / "workspaces")
    # Persistent per-workspace temp trees live under temp_root/tmp_{workspace_id}.
    # Untrusted executions see the selected tree as /tmp.
    temp_root: str = str(_LOCAL_DATA_ROOT / "tmp-workspaces")
    # Shared skills tree (read-only in containers).
    skills_root: str = str(_LOCAL_DATA_ROOT / "skill")
    # PR-09 control-plane roots — NEVER Bubblewrap-bound into workspace/tmp.
    # Immutable artifact snapshots (download source of truth).
    artifacts_root: str = str(_LOCAL_DATA_ROOT / "artifacts")
    # Dataset staging parts + quota reservations/locks (Sandbox API only).
    control_root: str = str(_LOCAL_DATA_ROOT / "control")

    # Stable Agent-visible logical roots; never physical storage paths.
    # /home/sandbox/workspace is a per-execution Bubblewrap bind target only —
    # never a process-global mutable symlink.
    agent_workspace_path: str = AGENT_WORKSPACE_PATH
    agent_skill_path: str = AGENT_SKILL_PATH

    # ── Process isolation ────────────────────────────────────────────
    # Host tests/local Python default to direct. Compose explicitly enables
    # bubblewrap; production validation requires it and fail-closed readiness.
    isolation_backend: str = "direct"
    isolation_required: bool = False
    bwrap_path: str = "/usr/bin/bwrap"
    bwrap_uid: int = 10001
    bwrap_gid: int = 10001
    # strict is the safe code default. balanced is only valid with required
    # Bubblewrap isolation; Compose enables it explicitly for development.
    policy_profile: str = "strict"

    # ── Resource limits ──────────────────────────────────────────────
    # Hard RLIMIT_* are applied in the forked child preexec (never on the
    # Sandbox service process). 0 = do not set that rlimit (dev only).
    # Production validation requires positive values inside safe ranges.
    execution_timeout_seconds: int = 120
    max_output_chars: int = 50_000
    max_process_count: int = 20  # RLIMIT_NPROC (tightened in child)
    # Concurrent managed long-running processes (B2 Process Manager).
    max_managed_processes: int = 32
    # Dual-layer active caps: per trusted session_id / user owner + global.
    # Owner prefers SessionResponse.user_id; workspace fallback only without user_id.
    max_managed_processes_per_session: int = 8
    max_managed_processes_per_owner: int = 16
    # Managed process wall-clock timeout (process_start). Null/omitted API
    # timeout always resolves to process_timeout_seconds; never unlimited.
    # Absolute ceiling rejects oversized client values (fail closed).
    process_timeout_seconds: int = 14_400
    max_process_timeout_seconds: int = 86_400
    # In-memory retention for terminal process maps (_entries/_logs/_done_events).
    # Active processes are never evicted. Terminal rows remain in DB.
    max_retained_terminal_processes: int = 256
    max_retained_terminal_processes_per_session: int = 64
    max_cpu_time_seconds: int = 300  # RLIMIT_CPU (seconds)
    max_memory_mb: int = 512  # RLIMIT_AS (mebibytes → bytes)
    max_file_size_mb: int = 50  # RLIMIT_FSIZE (mebibytes → bytes) + API write caps
    max_open_files: int = 256  # RLIMIT_NOFILE (fd count)
    workspace_quota_mb: int = 500
    temp_quota_mb: int = 500
    # Defense-in-depth **monitoring** for children (bash/python/process):
    # bounded tree sample + admit check. NOT a hard multi-tenant disk cap.
    # Production with positive quotas also requires operator-asserted hard backend.
    workspace_child_quota_enforcement: bool = True
    workspace_child_quota_sample_interval_s: float = 2.0
    # Max directory entries (files/dirs/symlinks) per bounded scan budget.
    # Exceeding fails closed (workspace_inode_limit_exceeded) — no unbounded walk.
    workspace_child_quota_max_entries: int = 100_000
    # Operator assertion that workspace/temp roots sit on an external hard
    # volume/project quota (XFS/project/LVM). Default false; production with
    # positive SANDBOX_*_QUOTA_MB requires explicit true after live verification.
    # Never auto-detect; never enable by default in compose.
    workspace_quota_hard_backend_asserted: bool = False
    # Attachment upload limits (parent task P-00F1 defaults)
    max_attachments_per_turn: int = 10
    max_turn_attachment_mb: int = 200

    # ── Shared execution environment ─────────────────────────────────
    # Comma-separated process-env key names to inject into every bash/python/
    # node/process_start child (after base safe_env, before env_overrides).
    # Values are read from the sandbox service process environment (typically
    # project .env via compose env_file). Service credentials are hard-denied
    # even if listed. Prefer SANDBOX_EXEC_ENV_<NAME>=value for explicit opt-in.
    shared_env_keys: Annotated[list[str], NoDecode] = []

    # ── Outbound execution network policy (child processes) ──────────
    # SANDBOX_NETWORK_MODE — independent of inbound HTTP client CIDRs.
    # disabled     — command policy denies network tools; Bubblewrap --unshare-net
    # allowlist    — command policy allows network tools; WITHOUT a per-child
    #                egress proxy this is NOT real isolation (dev only)
    # unrestricted — command policy allows network tools; shared container net
    #                (explicit development only; never production)
    # Production accepts only disabled until a controlled egress proxy exists.
    # Container-wide iptables is intentionally not an isolation authority.
    network_mode: str = "disabled"
    # Hard security invariant: link-local / cloud metadata is always blocked.
    # Env may not disable this (enforced in model_validator).
    block_metadata_ips: bool = True
    # Derived from network_mode when unset; retained for backward-compatible tests.
    default_deny_network: bool = True

    # ── Inbound Sandbox HTTP client policy (not execution egress) ────
    # SANDBOX_ALLOWED_CLIENT_CIDRS — source allowlist for the Sandbox API.
    # Comma-separated CIDRs. Empty allowlist = deny all (never allow-all).
    # Defaults cover loopback + Docker/compose private ranges; tighten to
    # loopback-only on bare-metal hosts that do not need container peers.
    # NoDecode: operators pass CSV, not JSON arrays.
    # Do not confuse with legacy SANDBOX_ALLOWED_CIDRS (removed; was iptables).
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
    # ask (default) pauses for a human; deny rejects approval-required work;
    # auto_approve is an explicit development-only bypass. ``approval_enabled``
    # remains a legacy boolean alias: true → ask, false → deny.
    approval_mode: ApprovalMode | None = None
    approval_enabled: bool | None = None

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

    # ── Internal HMAC (Agent -> Sandbox plane) ────────────────────────
    # JSON object: kid -> canonical unpadded base64url key material.
    # Empty = internal plane unconfigured (requests fail closed). No default keys.
    # Env: SANDBOX_INTERNAL_HMAC_KEYRING
    internal_hmac_keyring: str = ""
    # Must identify an entry in internal_hmac_keyring when keyring is set.
    # Env: SANDBOX_INTERNAL_HMAC_ACTIVE_KID
    internal_hmac_active_kid: str = ""
    # Clock skew tolerance for internal tokens (0..5 seconds). Default 0.
    # Env: SANDBOX_INTERNAL_TOKEN_LEEWAY_SECONDS
    internal_token_leeway_seconds: int = 0
    # Hard cap on raw internal request bodies (bytes). Stream is always bounded
    # even when Content-Length is absent or lies. Default 72 MiB (50 MiB file
    # base64+JSON headroom). Env: SANDBOX_INTERNAL_MAX_REQUEST_BODY_BYTES
    internal_max_request_body_bytes: int = _DEFAULT_INTERNAL_MAX_REQUEST_BODY_BYTES

    # ── Internal plane lifecycle (PR-07B Batch B) ─────────────────────
    # Default disabled: existing public/dev paths keep working without Redis
    # or claim DB wiring. Production may enable explicitly; never forced here.
    # Env: SANDBOX_INTERNAL_PLANE_ENABLED
    internal_plane_enabled: bool = False
    # Redis DSN for internal replay store only. Secret-redacted in effective_config.
    # Env: SANDBOX_INTERNAL_REDIS_URL
    internal_redis_url: str = ""
    # PyMySQL connect/read/write timeouts (seconds) for execution-domain DB.
    # Env: SANDBOX_MYSQL_CONNECT_TIMEOUT_SECONDS / READ / WRITE
    mysql_connect_timeout_seconds: int = 5
    mysql_read_timeout_seconds: int = 30
    mysql_write_timeout_seconds: int = 30
    # Hard upper bound on concurrent MySQL connections opened by MysqlDatabase.
    # Env: SANDBOX_MYSQL_MAX_CONNECTIONS
    mysql_max_connections: int = 8
    # Internal tool supervisor concurrency + drain (seconds).
    # Env: SANDBOX_INTERNAL_MAX_CONCURRENCY / SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS
    internal_max_concurrency: int = 64
    internal_drain_timeout_seconds: float = 30.0

    # Parsed kid -> key bytes (never logged; not a public settings field).
    _internal_hmac_keys: dict[str, bytes] = PrivateAttr(default_factory=dict)

    # ── Logging ──────────────────────────────────────────────────────
    log_level: str = "INFO"
    sensitive_keys: list[str] = [
        "password", "secret", "token", "api_key",
        "authorization", "cookie", "auth", "key",
    ]

    # ── Database ─────────────────────────────────────────────────────
    # Formal default: MySQL 8 (PyMySQL dialect). Compose / .env always set
    # SANDBOX_DATABASE_URL with credentials from MYSQL_* env — never hardcode
    # live secrets here.
    #
    # TEMPORARY GAP: non-production unit tests may still pass sqlite:// via
    # explicit Settings(database_url=...) or SANDBOX_DATABASE_URL from conftest.
    # That is test-only injection, not a production or compose default.
    database_url: str = _DEFAULT_MYSQL_DATABASE_URL

    model_config = SettingsConfigDict(
        env_prefix="SANDBOX_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        # Prefer process env over .env file (standard) — already the case.
    )

    @field_validator(
        "allowed_client_cidrs",
        "trusted_proxy_cidrs",
        "cors_origins",
        "shared_env_keys",
        mode="before",
    )
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

    @field_validator("network_mode", mode="before")
    @classmethod
    def _validate_network_mode(cls, value: Any) -> str:
        return _normalize_network_mode(None if value is None else str(value))

    @field_validator("policy_profile", mode="before")
    @classmethod
    def _validate_policy_profile(cls, value: Any) -> str:
        return _normalize_policy_profile(None if value is None else str(value))

    @field_validator("isolation_backend", mode="before")
    @classmethod
    def _validate_isolation_backend(cls, value: Any) -> str:
        return _normalize_isolation_backend(None if value is None else str(value))

    @field_validator("deployment_env", mode="before")
    @classmethod
    def _validate_deployment_env(cls, value: Any) -> str:
        # Default field value "development" is applied by pydantic when unset.
        # Explicit None / empty / unknown must fail closed (no silent degrade).
        if value is None:
            raise ValueError(
                "DEPLOYMENT_ENV must not be null; expected development|test|production "
                "(aliases: dev|local|prod)"
            )
        return _normalize_deployment_env(value if type(value) is str else str(value))

    @field_validator("approval_mode", mode="before")
    @classmethod
    def _validate_approval_mode(cls, value: Any) -> str | None:
        if value is None or (isinstance(value, str) and not value.strip()):
            return None
        return _normalize_approval_mode(value)

    @field_validator("approval_enabled", mode="before")
    @classmethod
    def _validate_approval_enabled(cls, value: Any) -> bool | None:
        if value is None or value == "":
            return None
        return _parse_approval_enabled(value)

    @field_validator("internal_token_leeway_seconds", mode="before")
    @classmethod
    def _validate_internal_token_leeway(cls, value: Any) -> int:
        if value is None or value == "":
            return 0
        # Reject bool (subclass of int) and float before coercion.
        if type(value) is bool or type(value) is float:
            raise ValueError(
                "SANDBOX_INTERNAL_TOKEN_LEEWAY_SECONDS must be an integer 0..5"
            )
        if type(value) is int:
            leeway = value
        elif type(value) is str:
            text = value.strip()
            if not text or any(c not in "0123456789" for c in text):
                raise ValueError(
                    "SANDBOX_INTERNAL_TOKEN_LEEWAY_SECONDS must be an integer 0..5"
                )
            leeway = int(text)
        else:
            raise ValueError(
                "SANDBOX_INTERNAL_TOKEN_LEEWAY_SECONDS must be an integer 0..5"
            )
        if not 0 <= leeway <= _MAX_INTERNAL_TOKEN_LEEWAY:
            raise ValueError(
                "SANDBOX_INTERNAL_TOKEN_LEEWAY_SECONDS must be an integer 0..5"
            )
        return leeway

    @field_validator("internal_max_request_body_bytes", mode="before")
    @classmethod
    def _validate_internal_max_request_body_bytes(cls, value: Any) -> int:
        name = "SANDBOX_INTERNAL_MAX_REQUEST_BODY_BYTES"
        if value is None or value == "":
            return _DEFAULT_INTERNAL_MAX_REQUEST_BODY_BYTES
        # bool is a subclass of int — reject before any numeric coercion.
        if type(value) is bool:
            raise ValueError(f"{name} must be an integer, not bool")
        if type(value) is float:
            raise ValueError(f"{name} must be an integer, not float")
        if type(value) is int:
            n = value
        elif type(value) is str:
            text = value.strip()
            if not text or any(c not in "0123456789" for c in text):
                raise ValueError(
                    f"{name} must be a positive integer "
                    f"1..{_HARD_MAX_INTERNAL_MAX_REQUEST_BODY_BYTES}"
                )
            n = int(text)
        else:
            raise ValueError(
                f"{name} must be a positive integer "
                f"1..{_HARD_MAX_INTERNAL_MAX_REQUEST_BODY_BYTES}"
            )
        if not 1 <= n <= _HARD_MAX_INTERNAL_MAX_REQUEST_BODY_BYTES:
            raise ValueError(
                f"{name} must be a positive integer "
                f"1..{_HARD_MAX_INTERNAL_MAX_REQUEST_BODY_BYTES}"
            )
        return n

    @field_validator("internal_plane_enabled", mode="before")
    @classmethod
    def _validate_internal_plane_enabled(cls, value: Any) -> bool:
        if value is None or value == "":
            return False
        if type(value) is bool:
            return value
        raw = str(value).strip().lower()
        if raw == "true":
            return True
        if raw == "false":
            return False
        raise ValueError(
            f"Invalid SANDBOX_INTERNAL_PLANE_ENABLED={value!r}; expected true or false"
        )

    @field_validator(
        "mysql_connect_timeout_seconds",
        "mysql_read_timeout_seconds",
        "mysql_write_timeout_seconds",
        mode="before",
    )
    @classmethod
    def _validate_mysql_timeouts(cls, value: Any, info: Any) -> int:
        name = f"SANDBOX_{str(info.field_name).upper()}"
        if value is None or value == "":
            defaults = {
                "mysql_connect_timeout_seconds": 5,
                "mysql_read_timeout_seconds": 30,
                "mysql_write_timeout_seconds": 30,
            }
            return defaults[str(info.field_name)]
        return _positive_int_field(value, name=name, minimum=1, maximum=600)

    @field_validator("mysql_max_connections", mode="before")
    @classmethod
    def _validate_mysql_max_connections(cls, value: Any) -> int:
        if value is None or value == "":
            return 8
        return _positive_int_field(
            value, name="SANDBOX_MYSQL_MAX_CONNECTIONS", minimum=1, maximum=256
        )

    @field_validator("internal_max_concurrency", mode="before")
    @classmethod
    def _validate_internal_max_concurrency(cls, value: Any) -> int:
        if value is None or value == "":
            return 64
        return _positive_int_field(
            value, name="SANDBOX_INTERNAL_MAX_CONCURRENCY", minimum=1, maximum=10_000
        )

    @field_validator("internal_drain_timeout_seconds", mode="before")
    @classmethod
    def _validate_internal_drain_timeout(cls, value: Any) -> float:
        name = "SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS"
        if value is None or value == "":
            return 30.0
        if type(value) is bool:
            raise ValueError(f"{name} must be a non-negative number, not bool")
        if type(value) is int or type(value) is float:
            n = float(value)
        elif type(value) is str:
            text = value.strip()
            if not text:
                raise ValueError(f"{name} must be a non-negative number")
            try:
                n = float(text)
            except ValueError as exc:
                raise ValueError(f"{name} must be a non-negative number") from exc
        else:
            raise ValueError(f"{name} must be a non-negative number")
        if n < 0 or n > 3600:
            raise ValueError(f"{name} must be in 0..3600 seconds")
        return n

    @field_validator("max_process_count", mode="before")
    @classmethod
    def _validate_max_process_count(cls, value: Any) -> int:
        if value is None or value == "":
            return 20
        return _nonneg_int_field(
            value, name="SANDBOX_MAX_PROCESS_COUNT", maximum=_HARD_MAX_PROCESS_COUNT
        )

    @field_validator("max_memory_mb", mode="before")
    @classmethod
    def _validate_max_memory_mb(cls, value: Any) -> int:
        if value is None or value == "":
            return 512
        return _nonneg_int_field(
            value, name="SANDBOX_MAX_MEMORY_MB", maximum=_HARD_MAX_MEMORY_MB
        )

    @field_validator("max_cpu_time_seconds", mode="before")
    @classmethod
    def _validate_max_cpu_time_seconds(cls, value: Any) -> int:
        if value is None or value == "":
            return 300
        return _nonneg_int_field(
            value,
            name="SANDBOX_MAX_CPU_TIME_SECONDS",
            maximum=_HARD_MAX_CPU_TIME_SECONDS,
        )

    @field_validator("max_file_size_mb", mode="before")
    @classmethod
    def _validate_max_file_size_mb(cls, value: Any) -> int:
        if value is None or value == "":
            return 50
        return _nonneg_int_field(
            value, name="SANDBOX_MAX_FILE_SIZE_MB", maximum=_HARD_MAX_FILE_SIZE_MB
        )

    @field_validator("max_open_files", mode="before")
    @classmethod
    def _validate_max_open_files(cls, value: Any) -> int:
        if value is None or value == "":
            return 256
        return _nonneg_int_field(
            value, name="SANDBOX_MAX_OPEN_FILES", maximum=_HARD_MAX_OPEN_FILES
        )

    @field_validator("max_output_chars", mode="before")
    @classmethod
    def _validate_max_output_chars(cls, value: Any) -> int:
        if value is None or value == "":
            return 50_000
        return _nonneg_int_field(
            value, name="SANDBOX_MAX_OUTPUT_CHARS", maximum=_HARD_MAX_OUTPUT_CHARS
        )

    @field_validator("execution_timeout_seconds", mode="before")
    @classmethod
    def _validate_execution_timeout_seconds(cls, value: Any) -> int:
        if value is None or value == "":
            return 120
        return _nonneg_int_field(
            value,
            name="SANDBOX_EXECUTION_TIMEOUT_SECONDS",
            maximum=_HARD_MAX_EXECUTION_TIMEOUT,
        )

    @model_validator(mode="after")
    def _resolve_bind_host_network_and_policy(self) -> Settings:
        """Prefer SANDBOX_BIND_HOST; fall back to SANDBOX_HOST; derive network; validate CIDRs."""
        # APPROVAL_MODE is the canonical cross-service setting. The prefixed
        # Sandbox fields win when supplied; legacy booleans map false to the
        # safe deny mode rather than silently broadening permissions.
        if "approval_mode" in self.model_fields_set and self.approval_mode is not None:
            approval_mode = _normalize_approval_mode(self.approval_mode)
        elif "approval_enabled" in self.model_fields_set and self.approval_enabled is not None:
            approval_mode = "ask" if self.approval_enabled else "deny"
        else:
            env_mode = os.environ.get("APPROVAL_MODE")
            env_enabled = os.environ.get("APPROVAL_ENABLED")
            if env_mode is not None and env_mode.strip():
                approval_mode = _normalize_approval_mode(env_mode)
            elif env_enabled is not None and env_enabled.strip():
                approval_mode = "ask" if _parse_approval_enabled(env_enabled) else "deny"
            else:
                approval_mode = "ask"
        object.__setattr__(self, "approval_mode", approval_mode)
        object.__setattr__(self, "approval_enabled", approval_mode != "deny")

        # Unprefixed DEPLOYMENT_ENV (compose/.env) when not set via kwargs /
        # SANDBOX_DEPLOYMENT_ENV. Do not clobber explicit constructor values.
        # Explicit empty DEPLOYMENT_ENV fails closed (no silent default).
        if "deployment_env" not in self.model_fields_set:
            if "DEPLOYMENT_ENV" in os.environ:
                object.__setattr__(
                    self,
                    "deployment_env",
                    _normalize_deployment_env(os.environ.get("DEPLOYMENT_ENV")),
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
        # Production forbids allowlist and unrestricted (no fake isolation).
        mode = self.network_mode
        if mode == "disabled":
            object.__setattr__(self, "default_deny_network", True)
        elif mode in ("allowlist", "unrestricted"):
            object.__setattr__(self, "default_deny_network", False)

        # Hard invariant: metadata IPs cannot be opened via env.
        object.__setattr__(self, "block_metadata_ips", True)

        if self.policy_profile == "balanced" and (
            self.isolation_backend != "bubblewrap" or not self.isolation_required
        ):
            raise ValueError(
                "SANDBOX_POLICY_PROFILE=balanced requires "
                "SANDBOX_ISOLATION_BACKEND=bubblewrap and "
                "SANDBOX_ISOLATION_REQUIRED=true"
            )

        # Fail fast on illegal CIDR / empty bind — never treat as allow-all.
        try:
            build_network_policy_from_settings(self)
        except NetworkPolicyConfigError as exc:
            raise ValueError(str(exc)) from exc

        # Internal HMAC keyring: empty is allowed (internal plane disabled).
        # When either keyring or active kid is set, both must parse strictly.
        # Never install built-in / weak default keys.
        raw_keyring = (self.internal_hmac_keyring or "").strip()
        raw_active = (self.internal_hmac_active_kid or "").strip()
        if raw_keyring or raw_active:
            if not raw_keyring:
                raise ValueError(
                    "SANDBOX_INTERNAL_HMAC_KEYRING is required when "
                    "SANDBOX_INTERNAL_HMAC_ACTIVE_KID is set"
                )
            if not raw_active:
                raise ValueError(
                    "SANDBOX_INTERNAL_HMAC_ACTIVE_KID is required when "
                    "SANDBOX_INTERNAL_HMAC_KEYRING is set"
                )
            from sandbox.security.internal_keyring import (
                InternalKeyringError,
                parse_internal_hmac_keyring,
                validate_active_kid,
            )

            try:
                keys = parse_internal_hmac_keyring(raw_keyring)
                validate_active_kid(keys, raw_active)
            except InternalKeyringError as exc:
                raise ValueError(str(exc)) from exc
            object.__setattr__(self, "_internal_hmac_keys", keys)
            object.__setattr__(self, "internal_hmac_keyring", raw_keyring)
            object.__setattr__(self, "internal_hmac_active_kid", raw_active)
        else:
            object.__setattr__(self, "_internal_hmac_keys", {})
        return self

    @property
    def internal_hmac_keys(self) -> Mapping[str, bytes]:
        """Parsed internal HMAC keyring (kid -> key bytes). Empty if unconfigured."""
        return self._internal_hmac_keys

    @property
    def workspaces_path(self) -> Path:
        return Path(self.workspaces_root)

    @property
    def temp_path(self) -> Path:
        return Path(self.temp_root)

    @property
    def skills_path(self) -> Path:
        return Path(self.skills_root)

    @property
    def artifacts_path(self) -> Path:
        return Path(self.artifacts_root)

    @property
    def control_path(self) -> Path:
        return Path(self.control_root)

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

    # Execution isolation authority is Bubblewrap --unshare-net under
    # network_mode=disabled. Without a per-child controlled egress proxy,
    # allowlist must not be offered as production isolation (fail closed).
    if cfg.network_mode == "unrestricted":
        errors.append(
            "SANDBOX_NETWORK_MODE=unrestricted is forbidden in production "
            "(use disabled)"
        )
    elif cfg.network_mode == "allowlist":
        errors.append(
            "SANDBOX_NETWORK_MODE=allowlist is forbidden in production until a "
            "per-child network namespace with controlled egress proxy exists "
            "(use disabled; do not treat container-wide port/CIDR allowlists "
            "as execution isolation)"
        )
    elif cfg.network_mode != "disabled":
        errors.append(
            f"SANDBOX_NETWORK_MODE={cfg.network_mode!r} is forbidden in production "
            "(use disabled)"
        )

    if cfg.policy_profile != "strict":
        errors.append(
            "SANDBOX_POLICY_PROFILE=balanced is forbidden in production (use strict)"
        )

    if cfg.approval_mode == "auto_approve":
        errors.append(
            "SANDBOX_APPROVAL_MODE=auto_approve is forbidden in production "
            "(use ask or deny)"
        )

    if cfg.isolation_backend != "bubblewrap":
        errors.append("SANDBOX_ISOLATION_BACKEND must be bubblewrap in production")
    if not cfg.isolation_required:
        errors.append("SANDBOX_ISOLATION_REQUIRED must be true in production")

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

    if cfg.debug:
        errors.append("SANDBOX_DEBUG must be false in production")

    # Positive workspace/temp quotas claim multi-tenant disk isolation.
    # Child monitoring alone is NOT a hard total (inter-sample races, RLIMIT_FSIZE
    # multi-file floods). Production requires BOTH:
    #   1) child quota monitoring enabled (bounded fail-closed sampler)
    #   2) operator-asserted external hard backend (volume/project quota)
    if cfg.workspace_quota_mb > 0 or cfg.temp_quota_mb > 0:
        if not cfg.workspace_child_quota_enforcement:
            errors.append(
                "SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT must be true in production "
                "when workspace_quota_mb or temp_quota_mb is positive "
                "(defense-in-depth child monitoring)"
            )
        if not cfg.workspace_quota_hard_backend_asserted:
            errors.append(
                "SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED must be true in "
                "production when workspace_quota_mb or temp_quota_mb is positive "
                "(operator must provision volume/project quota; process monitoring "
                "is not a hard multi-tenant disk cap). Leave false until live gate "
                "verifies the external quota, then set explicitly."
            )
    if cfg.workspace_child_quota_enforcement and (
        float(cfg.workspace_child_quota_sample_interval_s) < 0.5
        or float(cfg.workspace_child_quota_sample_interval_s) > 60.0
    ):
        errors.append(
            "SANDBOX_WORKSPACE_CHILD_QUOTA_SAMPLE_INTERVAL_S must be in [0.5, 60] "
            "when child quota monitoring is enabled"
        )
    if cfg.workspace_child_quota_enforcement and int(
        cfg.workspace_child_quota_max_entries
    ) < 1000:
        errors.append(
            "SANDBOX_WORKSPACE_CHILD_QUOTA_MAX_ENTRIES must be >= 1000 when "
            "child quota monitoring is enabled"
        )

    # Internal control plane is mandatory in production: Agent HMAC tools need
    # replay Redis + claim MySQL readiness. Dev may leave the plane disabled.
    if not cfg.internal_plane_enabled:
        errors.append(
            "SANDBOX_INTERNAL_PLANE_ENABLED must be true in production "
            "(Agent internal plane requires explicit enablement)"
        )
    else:
        try:
            validate_internal_plane_config(cfg)
        except ValueError as exc:
            # validate_internal_plane_config messages are field-level (no secrets).
            errors.append(str(exc))

    # Internal HMAC: no built-in defaults. Production (enabled plane) already
    # requires keyring via validate_internal_plane_config; still reject empty
    # parse results if a keyring string is present.
    if (cfg.internal_hmac_keyring or "").strip():
        if not cfg.internal_hmac_keys:
            errors.append(
                "SANDBOX_INTERNAL_HMAC_KEYRING is set but produced an empty keyring"
            )
        if not (cfg.internal_hmac_active_kid or "").strip():
            errors.append(
                "SANDBOX_INTERNAL_HMAC_ACTIVE_KID must be set with the keyring "
                "in production"
            )
        if not 0 <= int(cfg.internal_token_leeway_seconds) <= _MAX_INTERNAL_TOKEN_LEEWAY:
            errors.append(
                "SANDBOX_INTERNAL_TOKEN_LEEWAY_SECONDS must be 0..5 in production"
            )

    # MySQL is the sole formal production database. SQLite / PostgreSQL are
    # rejected here even if some unit tests still inject them under development.
    db_url = (cfg.database_url or "").strip()
    if not db_url:
        errors.append(
            "SANDBOX_DATABASE_URL must be set to a MySQL DSN in production "
            "(mysql:// or mysql+pymysql://)"
        )
    elif not is_mysql_database_url(db_url):
        scheme = database_url_scheme(db_url) or "unknown"
        errors.append(
            f"SANDBOX_DATABASE_URL must be MySQL in production (got scheme={scheme}); "
            "SQLite and PostgreSQL are not permitted as production databases"
        )

    # Managed-process resource caps: production must not allow unbounded wall
    # time or unlimited in-memory retention of terminal process structures.
    for name, value in (
        ("SANDBOX_PROCESS_TIMEOUT_SECONDS", cfg.process_timeout_seconds),
        ("SANDBOX_MAX_PROCESS_TIMEOUT_SECONDS", cfg.max_process_timeout_seconds),
        ("SANDBOX_MAX_MANAGED_PROCESSES", cfg.max_managed_processes),
        (
            "SANDBOX_MAX_MANAGED_PROCESSES_PER_SESSION",
            cfg.max_managed_processes_per_session,
        ),
        (
            "SANDBOX_MAX_MANAGED_PROCESSES_PER_OWNER",
            cfg.max_managed_processes_per_owner,
        ),
        (
            "SANDBOX_MAX_RETAINED_TERMINAL_PROCESSES",
            cfg.max_retained_terminal_processes,
        ),
        (
            "SANDBOX_MAX_RETAINED_TERMINAL_PROCESSES_PER_SESSION",
            cfg.max_retained_terminal_processes_per_session,
        ),
    ):
        try:
            iv = int(value)
        except (TypeError, ValueError):
            errors.append(f"{name} must be a positive integer")
            continue
        if iv <= 0:
            errors.append(f"{name} must be > 0 in production (got {value!r})")
    try:
        if int(cfg.process_timeout_seconds) > int(cfg.max_process_timeout_seconds):
            errors.append(
                "SANDBOX_PROCESS_TIMEOUT_SECONDS must be <= "
                "SANDBOX_MAX_PROCESS_TIMEOUT_SECONDS in production"
            )
    except (TypeError, ValueError):
        pass  # already reported above

    # Child hard RLIMIT_* / output caps: production forbids 0 (unlimited) and
    # values outside documented safe ranges. Applied in child preexec only.
    for attr, (env_name, lo, hi) in _PROD_RESOURCE_RANGES.items():
        raw = getattr(cfg, attr, None)
        try:
            iv = int(raw)
        except (TypeError, ValueError):
            errors.append(f"{env_name} must be an integer {lo}..{hi} in production")
            continue
        if not lo <= iv <= hi:
            errors.append(
                f"{env_name} must be {lo}..{hi} in production (got {raw!r}); "
                "0/unlimited is forbidden"
            )

    # Production Linux: refuse start when critical resource module primitives
    # are missing (cannot enforce hard limits). Offline macOS is a no-op.
    try:
        from sandbox.utils.resource_limits import (
            ResourceLimitError,
            assert_production_resource_primitives,
        )

        assert_production_resource_primitives()
    except ResourceLimitError as exc:
        errors.append(str(exc))
    except Exception as exc:  # pragma: no cover — import/platform edge
        errors.append(f"resource primitive check failed: {exc}")

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
            elif key == "internal_redis_url" or key.endswith("redis_url"):
                redacted[key] = _redact_redis_url(str(value or ""))
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
    # mysql+pymysql://user:pass@host:port/db → mysql+pymysql://***@host:port/<redacted>
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


def _assert_redis_url_shape(url: str, *, field: str) -> str:
    """Strict redis/rediss DSN shape for internal plane config (no network)."""
    from sandbox.security.replay_redis_config import parse_redis_authority

    text = (url or "").strip()
    if not text:
        raise ValueError(f"{field} is required when internal_plane_enabled=true")
    try:
        parse_redis_authority(text)
    except ValueError as exc:
        # Re-bind field name without echoing URL material.
        msg = str(exc)
        if msg.startswith("Redis URL"):
            msg = msg.replace("Redis URL", field, 1)
        raise ValueError(msg) from exc
    return text


def validate_internal_plane_config(
    s: Settings | None = None,
    *,
    agent_redis_url: str | None = None,
    agent_redis_url_alt: str | None = None,
    agent_redis_password: str | None = None,
) -> None:
    """Pure internal-plane config gate (no I/O, no Redis import, no network).

    When ``internal_plane_enabled`` is False, only validates typed numeric bounds
    already enforced by Settings validators (no Redis/HMAC requirement).
    When enabled, requires independent replay Redis isolation (DB0 + secret not
    shared with Agent), HMAC keyring, and **drain timeout > 0**.
    Never forces production enabled.
    """
    from sandbox.security.replay_redis_config import assert_replay_redis_isolation

    cfg = s or settings
    errors: list[str] = []

    # Bounds always apply (enabled or not) so misconfig is visible early.
    for name, value, lo, hi in (
        ("SANDBOX_MYSQL_CONNECT_TIMEOUT_SECONDS", cfg.mysql_connect_timeout_seconds, 1, 600),
        ("SANDBOX_MYSQL_READ_TIMEOUT_SECONDS", cfg.mysql_read_timeout_seconds, 1, 600),
        ("SANDBOX_MYSQL_WRITE_TIMEOUT_SECONDS", cfg.mysql_write_timeout_seconds, 1, 600),
        ("SANDBOX_MYSQL_MAX_CONNECTIONS", cfg.mysql_max_connections, 1, 256),
        ("SANDBOX_INTERNAL_MAX_CONCURRENCY", cfg.internal_max_concurrency, 1, 10_000),
    ):
        try:
            iv = int(value)
        except (TypeError, ValueError):
            errors.append(f"{name} must be an integer {lo}..{hi}")
            continue
        if not lo <= iv <= hi:
            errors.append(f"{name} must be an integer {lo}..{hi} (got {value!r})")

    try:
        drain = float(cfg.internal_drain_timeout_seconds)
        if drain < 0 or drain > 3600:
            errors.append(
                "SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS must be in 0..3600 "
                f"(got {cfg.internal_drain_timeout_seconds!r})"
            )
    except (TypeError, ValueError):
        errors.append("SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS must be a non-negative number")

    if not cfg.internal_plane_enabled:
        if errors:
            raise ValueError(
                "Internal plane configuration is invalid "
                f"({len(errors)} issue(s)): " + "; ".join(errors)
            )
        return

    # Enabled plane: drain must be strictly positive (no zero-timeout "false drain").
    try:
        drain = float(cfg.internal_drain_timeout_seconds)
        if drain <= 0:
            errors.append(
                "SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS must be > 0 when "
                "internal_plane_enabled=true (zero is not a safe shutdown bound)"
            )
    except (TypeError, ValueError):
        pass  # already reported

    # Enabled: fail closed on missing plane dependencies + isolation.
    try:
        _assert_redis_url_shape(
            cfg.internal_redis_url, field="SANDBOX_INTERNAL_REDIS_URL"
        )
    except ValueError as exc:
        errors.append(str(exc))
    else:
        # Resolve Agent authority from explicit args or process env (pure read).
        env_agent = agent_redis_url
        env_alt = agent_redis_url_alt
        env_pw = agent_redis_password
        if env_agent is None:
            env_agent = os.environ.get("AGENT_REDIS_URL")
        if env_alt is None:
            env_alt = os.environ.get("REDIS_URL")
        if env_pw is None:
            env_pw = os.environ.get("REDIS_PASSWORD")
        try:
            assert_replay_redis_isolation(
                cfg.internal_redis_url,
                agent_redis_url=env_agent,
                agent_redis_url_alt=env_alt,
                agent_redis_password=env_pw,
                require_password=True,
                require_db_zero=True,
            )
        except ValueError as exc:
            errors.append(str(exc))

    if not (cfg.internal_hmac_keyring or "").strip():
        errors.append(
            "SANDBOX_INTERNAL_HMAC_KEYRING is required when "
            "SANDBOX_INTERNAL_PLANE_ENABLED=true"
        )
    if not (cfg.internal_hmac_active_kid or "").strip():
        errors.append(
            "SANDBOX_INTERNAL_HMAC_ACTIVE_KID is required when "
            "SANDBOX_INTERNAL_PLANE_ENABLED=true"
        )
    if (cfg.internal_hmac_keyring or "").strip() and not cfg.internal_hmac_keys:
        errors.append(
            "SANDBOX_INTERNAL_HMAC_KEYRING is set but produced an empty keyring"
        )

    db_url = (cfg.database_url or "").strip()
    if not db_url or not is_mysql_database_url(db_url):
        scheme = database_url_scheme(db_url) or "missing"
        errors.append(
            "SANDBOX_DATABASE_URL must be MySQL (mysql:// or mysql+pymysql://) "
            f"when internal plane is enabled (got scheme={scheme})"
        )

    if errors:
        raise ValueError(
            "Internal plane configuration is unsafe "
            f"({len(errors)} issue(s)): " + "; ".join(errors)
        )


def _redact_redis_url(url: str) -> str:
    if not url:
        return "<empty>"
    m = re.match(
        r"^(?P<scheme>rediss?)://(?P<creds>[^@]*)@(?P<host>[^/]+)(?:/(?P<db>.*))?$",
        url,
        flags=re.IGNORECASE,
    )
    if m:
        return f"{m.group('scheme').lower()}://***@{m.group('host')}/<redacted>"
    m2 = re.match(r"^(?P<scheme>rediss?)://(?P<rest>.*)$", url, flags=re.IGNORECASE)
    if m2:
        return f"{m2.group('scheme').lower()}://<redacted>"
    return "<redacted>"


settings = Settings()
