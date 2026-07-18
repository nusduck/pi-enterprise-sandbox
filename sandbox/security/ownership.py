"""Actor resolution and ownership checks for multi-user auth.

When ``SANDBOX_AUTH_ENABLED`` is false, ownership is not enforced (open dev mode).
When enabled, session-owned public routes require a resolved end-user actor from
JWT or service+acting headers. Static service token alone is **not** an
end-user and cannot list/read/write/delete session resources on the legacy
public surface (PR-07B HMAC internal plane is separate and not implemented here).

Cross-user / cross-org access returns 404 (no existence leak).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, Request

from sandbox.config import settings

# Trusted acting headers (BFF → sandbox only; browsers must not set these).
HEADER_ACTING_USER = "X-Acting-User-Id"
HEADER_ACTING_ORG = "X-Acting-Organization-Id"
HEADER_ACTING_ROLE = "X-Acting-Role"

BOOTSTRAP_ORG_ID = "org_bootstrap"
BOOTSTRAP_USER_ID = "user_bootstrap"
BOOTSTRAP_ORG_NAME = "Bootstrap Organization"

_AUTH_REQUIRED_DETAIL = (
    "Authentication required: user JWT or service token with acting headers"
)
_SESSION_NOT_FOUND = "Session not found"


@dataclass(frozen=True)
class Actor:
    user_id: str
    organization_id: str
    role: str = "user"
    username: str | None = None

    @property
    def is_admin(self) -> bool:
        return (self.role or "user").lower() == "admin"


def _service_token_valid(request: Request) -> bool:
    if not settings.api_token:
        return False
    token = request.headers.get(settings.api_token_header, "")
    return bool(token) and token == settings.api_token


def _actor_from_jwt(request: Request) -> Actor | None:
    from sandbox.auth import verify_token

    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    payload = verify_token(auth[7:].strip())
    if not payload:
        return None
    user_id = payload.get("sub")
    if not user_id:
        return None
    return Actor(
        user_id=str(user_id),
        organization_id=str(payload.get("organization_id") or BOOTSTRAP_ORG_ID),
        role=str(payload.get("role") or "user"),
        username=payload.get("username"),
    )


def _actor_from_acting_headers(request: Request) -> Actor | None:
    """Resolve actor from BFF-trusted acting headers (requires valid service token)."""
    if not _service_token_valid(request):
        return None
    user_id = (request.headers.get(HEADER_ACTING_USER) or "").strip()
    org_id = (request.headers.get(HEADER_ACTING_ORG) or "").strip()
    if not user_id or not org_id:
        return None
    role = (request.headers.get(HEADER_ACTING_ROLE) or "user").strip() or "user"
    return Actor(user_id=user_id, organization_id=org_id, role=role)


def resolve_actor(request: Request) -> Actor | None:
    """Resolve the end-user actor for the request.

    Priority:
      1. Valid user JWT (Authorization Bearer)
      2. Valid service token + X-Acting-User-Id + X-Acting-Organization-Id
      3. Otherwise None (service token alone is not an end-user)
    """
    jwt_actor = _actor_from_jwt(request)
    if jwt_actor:
        return jwt_actor
    return _actor_from_acting_headers(request)


def apply_actor_to_request_state(request: Request) -> Actor | None:
    """Populate request.state with actor fields; return actor or None."""
    actor = resolve_actor(request)
    if actor:
        request.state.user_id = actor.user_id
        request.state.organization_id = actor.organization_id
        request.state.user_role = actor.role
        request.state.username = actor.username
    else:
        # Clear any stale values if middleware re-runs in tests
        request.state.user_id = None
        request.state.organization_id = None
        request.state.user_role = None
        request.state.username = None
    return actor


def require_actor(request: Request) -> Actor:
    """Return actor when auth is enabled; raise 401 if missing.

    When auth is disabled, returns a synthetic bootstrap actor so callers can
    still stamp ownership on new resources without branching everywhere.
    """
    if not settings.auth_enabled:
        return Actor(
            user_id=BOOTSTRAP_USER_ID,
            organization_id=BOOTSTRAP_ORG_ID,
            role="admin",
            username="bootstrap",
        )
    # Prefer values already set by middleware
    user_id = getattr(request.state, "user_id", None)
    org_id = getattr(request.state, "organization_id", None)
    role = getattr(request.state, "user_role", None) or "user"
    if user_id and org_id:
        return Actor(
            user_id=str(user_id),
            organization_id=str(org_id),
            role=str(role),
            username=getattr(request.state, "username", None),
        )
    actor = resolve_actor(request)
    if not actor:
        raise HTTPException(status_code=401, detail=_AUTH_REQUIRED_DETAIL)
    apply_actor_to_request_state(request)
    return actor


def assert_resource_owner(
    resource: Any,
    actor: Actor,
    *,
    owner_attr: str = "owner_user_id",
    org_attr: str = "organization_id",
    not_found_detail: str = "Not found",
) -> None:
    """Raise 404 if *actor* may not access *resource* (no existence leak).

    Admin role may access any resource in the same organization only.
    Missing org ownership under auth is fail-closed.
    """
    if not settings.auth_enabled:
        return

    owner = getattr(resource, owner_attr, None)
    if owner is None and isinstance(resource, dict):
        owner = resource.get(owner_attr)
    org = getattr(resource, org_attr, None)
    if org is None and isinstance(resource, dict):
        org = resource.get(org_attr)

    if not org:
        raise HTTPException(status_code=404, detail=not_found_detail)
    if str(org) != str(actor.organization_id):
        raise HTTPException(status_code=404, detail=not_found_detail)
    if actor.is_admin:
        return
    if not owner or str(owner) != str(actor.user_id):
        raise HTTPException(status_code=404, detail=not_found_detail)


def session_organization_id(session: Any) -> str | None:
    """Organization ownership for a session (metadata.organization_id)."""
    metadata = getattr(session, "metadata", None)
    if metadata is None and isinstance(session, dict):
        metadata = session.get("metadata")
    if isinstance(metadata, dict):
        org = metadata.get("organization_id")
        if org:
            return str(org)
    return None


def session_owner_user_id(session: Any) -> str | None:
    user_id = getattr(session, "user_id", None)
    if user_id is None and isinstance(session, dict):
        user_id = session.get("user_id")
    return str(user_id) if user_id else None


def assert_session_owner(session: Any, actor: Actor | None) -> None:
    """Enforce session ownership for legacy public session-owned routes.

    Under ``auth_enabled``:

    - ``actor is None`` (static service token alone) → **401 fail closed**.
      HMAC internal routes do not use this function.
    - Session must carry both ``user_id`` and ``metadata.organization_id``;
      missing either → **404** (no legacy unowned bypass).
    - Admin: same organization only.
    - User: same organization **and** same user_id.
    """
    if not settings.auth_enabled:
        return
    if actor is None:
        raise HTTPException(status_code=401, detail=_AUTH_REQUIRED_DETAIL)

    org = session_organization_id(session)
    user_id = session_owner_user_id(session)
    if not org or not user_id:
        raise HTTPException(status_code=404, detail=_SESSION_NOT_FOUND)
    if str(org) != str(actor.organization_id):
        raise HTTPException(status_code=404, detail=_SESSION_NOT_FOUND)
    if actor.is_admin:
        return
    if str(user_id) != str(actor.user_id):
        raise HTTPException(status_code=404, detail=_SESSION_NOT_FOUND)


def require_end_user_actor(request: Request | None) -> Actor | None:
    """Resolve actor for session-owned public routes.

    Auth off → None (caller skips ownership).
    Auth on + missing actor → 401 (before existence checks when possible).
    """
    if not settings.auth_enabled:
        return None
    if request is None:
        raise HTTPException(status_code=401, detail=_AUTH_REQUIRED_DETAIL)
    actor = resolve_actor(request)
    if actor is None:
        raise HTTPException(status_code=401, detail=_AUTH_REQUIRED_DETAIL)
    return actor


def require_owned_session(session_id: str, request: Request | None = None) -> Any:
    """Load a session and enforce end-user ownership under auth.

    Order under auth_enabled (no existence leak to service-token-alone):
      1. Require end-user actor (401 if missing)
      2. Load session (404 if missing)
      3. assert_session_owner (404 if not permitted)
    """
    from sandbox.services.session_manager import session_manager

    actor = require_end_user_actor(request)
    session = session_manager.get(session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=_SESSION_NOT_FOUND)
    if actor is not None:
        assert_session_owner(session, actor)
    return session


def assert_legacy_session_binding_create_allowed() -> None:
    """Gate POST /sessions formal AgentSession/Workspace binding create.

    Formal ``agent_session_id`` / ``workspace_id`` / ``sandbox_session_id`` are
    Agent-preallocated identities. Until PR-07B HMAC/fence transport exists,
    **no** present credential can prove that binding:

    - end-user JWT
    - service token + acting headers
    - static ``X-API-Key`` alone

    Therefore when ``auth_enabled`` (production multi-user / service auth mode)
    create is fail-closed. Dev/test with ``auth_enabled=false`` remains open for
    offline local suites only.
    """
    if settings.auth_enabled:
        raise HTTPException(
            status_code=503,
            detail=(
                "Formal AgentSession/Workspace binding create is unavailable: "
                "trusted binding proof (HMAC/fence) is not configured. "
                "User JWT, acting headers, and static API keys cannot declare "
                "preallocated workspace bindings."
            ),
        )


def session_visible_to_actor(session: Any, actor: Actor) -> bool:
    """Return True if *actor* may see *session* in list results (auth on).

    Missing org/user ownership → not visible (fail closed).
    Admin → same organization only.
    User → same organization and same user_id.
    """
    org = session_organization_id(session)
    user_id = session_owner_user_id(session)
    if not org or not user_id:
        return False
    if str(org) != str(actor.organization_id):
        return False
    if actor.is_admin:
        return True
    return str(user_id) == str(actor.user_id)
