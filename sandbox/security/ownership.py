"""Actor resolution and ownership checks for multi-user auth.

When ``SANDBOX_AUTH_ENABLED`` is false, ownership is not enforced (open dev mode).
When enabled, end-user routes require a resolved actor from JWT or service+acting
headers. Cross-user / cross-org access returns 404 (no existence leak).
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
        raise HTTPException(
            status_code=401,
            detail="Authentication required: user JWT or service token with acting headers",
        )
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

    Admin role may access any resource in the same organization.
    """
    if not settings.auth_enabled:
        return

    owner = getattr(resource, owner_attr, None)
    if owner is None and isinstance(resource, dict):
        owner = resource.get(owner_attr)
    org = getattr(resource, org_attr, None)
    if org is None and isinstance(resource, dict):
        org = resource.get(org_attr)

    if org and str(org) != str(actor.organization_id):
        raise HTTPException(status_code=404, detail=not_found_detail)
    if actor.is_admin:
        return
    if owner and str(owner) != str(actor.user_id):
        raise HTTPException(status_code=404, detail=not_found_detail)


def assert_session_owner(session: Any, actor: Actor | None) -> None:
    """If session has user_id and auth is on with an actor, require match (404)."""
    if not settings.auth_enabled or actor is None:
        return
    user_id = getattr(session, "user_id", None)
    if user_id is None and isinstance(session, dict):
        user_id = session.get("user_id")
    if not user_id:
        return  # unowned / legacy session: allow when reachable
    if actor.is_admin:
        return
    if str(user_id) != str(actor.user_id):
        raise HTTPException(status_code=404, detail="Session not found")
