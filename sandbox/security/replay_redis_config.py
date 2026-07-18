"""Pure config semantics for Sandbox internal-replay Redis isolation (PR-07).

Production must **not** reuse Agent broad Redis authority (``REDIS_PASSWORD`` /
``AGENT_REDIS_URL`` / ``REDIS_URL``). Logical DB index alone is **not** isolation.

Rules (offline-checkable, no network):
  * Dedicated secret / DSN for Sandbox replay only.
  * Fixed database index **0** (dedicated instance or ACL-isolated user on DB0).
  * Password must differ from Agent Redis password when that is known.
  * Host+user+password must not equal Agent Redis authority.

Errors never embed full DSNs, passwords, or secrets.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlparse

from sandbox.security.replay_store import REPLAY_KEY_PREFIX

# Documented least-privilege surface (ops / ACL checklists).
REPLAY_KEY_PATTERN = f"{REPLAY_KEY_PREFIX}*"
REPLAY_ALLOWED_COMMANDS: frozenset[str] = frozenset(
    {
        "SET",
        "PING",
        "HELLO",  # redis-py handshake
        "AUTH",
        "CLIENT",  # SETNAME / optional client metadata
        "INFO",  # some clients probe on connect — not required; not granted in ACL
    }
)
# Strict ACL grant recommendation (INFO intentionally omitted).
REPLAY_ACL_COMMANDS: frozenset[str] = frozenset({"SET", "PING", "HELLO", "AUTH"})
REPLAY_FIXED_DB = 0


@dataclass(frozen=True)
class RedisAuthorityView:
    """Redacted view of a Redis DSN (safe to log field-by-field without secrets)."""

    scheme: str
    host: str
    port: int
    username: str | None
    has_password: bool
    db: int

    @property
    def identity_token(self) -> str:
        """Host:port:user (no password) for comparing authorities without secrets."""
        user = self.username or ""
        return f"{self.scheme}|{self.host}|{self.port}|{user}|db={self.db}"


def _classify_scheme(url: str) -> str:
    lower = (url or "").strip().lower()
    if lower.startswith("rediss://"):
        return "rediss"
    if lower.startswith("redis://"):
        return "redis"
    if "://" in lower:
        return lower.split("://", 1)[0] or "unknown"
    return "unknown"


def parse_redis_authority(url: str | None) -> RedisAuthorityView:
    """Parse redis/rediss URL into a non-secret authority view.

    Raises ValueError with safe messages (scheme/host/db only).
    """
    text = (url or "").strip()
    if not text:
        raise ValueError("Redis URL is required")
    if any(ord(c) < 32 or ord(c) == 127 for c in text) or any(c.isspace() for c in text):
        raise ValueError("Redis URL must not contain whitespace or control characters")
    scheme = _classify_scheme(text)
    if scheme not in ("redis", "rediss"):
        raise ValueError(
            f"Redis URL must be redis:// or rediss:// (got scheme={scheme})"
        )
    try:
        parsed = urlparse(text)
    except Exception as exc:
        raise ValueError("Redis URL is not parseable") from exc
    host = (parsed.hostname or "").strip()
    if not host:
        raise ValueError("Redis URL must include a non-empty hostname")
    port = int(parsed.port or 6379)
    username = unquote(parsed.username) if parsed.username else None
    has_password = parsed.password is not None and str(parsed.password) != ""
    # path: "" or "/" → db 0; "/2" → 2
    path = (parsed.path or "").lstrip("/")
    if path == "":
        db = 0
    else:
        # Only first path segment; reject non-integer db
        seg = path.split("/", 1)[0]
        if not seg.isdigit():
            raise ValueError("Redis URL database index must be an integer path")
        db = int(seg)
        if db < 0 or db > 15:
            raise ValueError("Redis URL database index must be 0..15")
    return RedisAuthorityView(
        scheme=scheme,
        host=host.lower(),
        port=port,
        username=username,
        has_password=has_password,
        db=db,
    )


def extract_redis_password(url: str | None) -> str | None:
    """Return password material for isolation comparison only (never log)."""
    text = (url or "").strip()
    if not text:
        return None
    try:
        parsed = urlparse(text)
    except Exception:
        return None
    if parsed.password is None:
        return None
    return unquote(parsed.password)


def assert_replay_redis_isolation(
    internal_url: str,
    *,
    agent_redis_url: str | None = None,
    agent_redis_url_alt: str | None = None,
    agent_redis_password: str | None = None,
    require_password: bool = True,
    require_db_zero: bool = True,
) -> RedisAuthorityView:
    """Fail closed when Sandbox replay Redis is not independently isolated.

    * ``require_db_zero``: dedicated instance uses DB 0 (ACL users also on DB0).
    * Rejects password reuse vs Agent ``REDIS_PASSWORD`` / Agent DSN passwords.
    * Rejects identical host+user+password authority even if DB index differs
      (DB index is not isolation).
    """
    view = parse_redis_authority(internal_url)
    if require_password and not view.has_password:
        raise ValueError(
            "SANDBOX_INTERNAL_REDIS_URL must include an independent password "
            "(empty/auth-less replay Redis is rejected)"
        )
    if require_db_zero and view.db != REPLAY_FIXED_DB:
        raise ValueError(
            f"SANDBOX_INTERNAL_REDIS_URL must use database index {REPLAY_FIXED_DB} "
            f"(got db={view.db}); a non-zero DB index is not isolation from Agent Redis"
        )

    internal_pw = extract_redis_password(internal_url) or ""

    # Agent shared password env (REDIS_PASSWORD) — never reuse.
    agent_pw = (agent_redis_password or "").strip()
    if agent_pw and internal_pw and agent_pw == internal_pw:
        raise ValueError(
            "SANDBOX_INTERNAL_REDIS_URL password must not equal REDIS_PASSWORD "
            "(Agent broad Redis secret); use an independent replay secret"
        )

    for label, agent_url in (
        ("AGENT_REDIS_URL", agent_redis_url),
        ("REDIS_URL", agent_redis_url_alt),
    ):
        if not (agent_url or "").strip():
            continue
        try:
            agent_view = parse_redis_authority(agent_url)
        except ValueError:
            continue
        agent_pw2 = extract_redis_password(agent_url) or ""
        if agent_pw2 and internal_pw and agent_pw2 == internal_pw:
            raise ValueError(
                f"SANDBOX_INTERNAL_REDIS_URL password must not equal {label} password; "
                "use an independent replay secret"
            )
        # Same host+user+password is shared authority even if DB differs.
        if (
            agent_view.host == view.host
            and agent_view.port == view.port
            and (agent_view.username or "") == (view.username or "")
            and agent_pw2
            and internal_pw
            and agent_pw2 == internal_pw
        ):
            raise ValueError(
                "SANDBOX_INTERNAL_REDIS_URL must not share host/user/password with "
                f"{label} (database index alone is not isolation)"
            )

    return view


def replay_acl_policy_document() -> dict[str, Any]:
    """Static least-privilege policy description (no secrets)."""
    return {
        "key_pattern": REPLAY_KEY_PATTERN,
        "commands": sorted(REPLAY_ACL_COMMANDS),
        "fixed_db": REPLAY_FIXED_DB,
        "notes": [
            "Prefer dedicated Redis service with independent password/volume.",
            "If sharing a Redis process, use ACL user with ~sandbox:internal:replay:v1:* "
            "and +SET +PING (+HELLO +AUTH as needed); do not grant SELECT or keys *.",
            "Never reuse REDIS_PASSWORD / AGENT_REDIS_URL credentials for Sandbox.",
        ],
    }


__all__ = [
    "REPLAY_ACL_COMMANDS",
    "REPLAY_ALLOWED_COMMANDS",
    "REPLAY_FIXED_DB",
    "REPLAY_KEY_PATTERN",
    "RedisAuthorityView",
    "assert_replay_redis_isolation",
    "extract_redis_password",
    "parse_redis_authority",
    "replay_acl_policy_document",
]
