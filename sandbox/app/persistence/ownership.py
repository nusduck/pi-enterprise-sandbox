"""Ownership filter helpers for multi-tenant repository SQL."""

from __future__ import annotations

from sandbox.app.domain.types import OwnerScope
from sandbox.app.persistence.errors import OwnershipError


def require_owner_scope(
    scope: OwnerScope | dict[str, str] | None,
    *,
    resource: str | None = None,
) -> OwnerScope:
    """Require non-empty org_id and user_id (plan multi-tenant ownership)."""
    if scope is None:
        raise OwnershipError(
            "Owner scope requires non-empty org_id and user_id",
            resource=resource,
        )
    if isinstance(scope, OwnerScope):
        org_id = str(scope.org_id).strip()
        user_id = str(scope.user_id).strip()
    else:
        org_id = str(scope.get("org_id") or scope.get("orgId") or "").strip()
        user_id = str(scope.get("user_id") or scope.get("userId") or "").strip()
    if not org_id or not user_id:
        raise OwnershipError(
            "Owner scope requires non-empty org_id and user_id",
            resource=resource,
        )
    return OwnerScope(org_id=org_id, user_id=user_id)


def apply_owner_scope_sql(
    where_sql: str,
    scope: OwnerScope,
    *,
    org_column: str = "org_id",
    user_column: str = "user_id",
    table_alias: str | None = None,
) -> tuple[str, tuple[str, str]]:
    """Append org_id + user_id equality predicates.

    Returns ``(sql_fragment, (org_id, user_id))`` for parameterized binding.
    """
    prefix = f"{table_alias}." if table_alias else ""
    owner_clause = (
        f"{prefix}{org_column} = %s AND {prefix}{user_column} = %s"
    )
    base = (where_sql or "").strip()
    if not base:
        return owner_clause, (scope.org_id, scope.user_id)
    if base.upper().startswith("WHERE"):
        return f"{base} AND {owner_clause}", (scope.org_id, scope.user_id)
    return f"{base} AND {owner_clause}", (scope.org_id, scope.user_id)
