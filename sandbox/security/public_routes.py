"""Centralized public-route policy for auth middleware.

Root ``/`` is exact-only so it can never silently make every absolute path public
via ``startswith("/")``. Health, docs, metrics and ``/auth/`` are prefix matches.
"""

from __future__ import annotations

# Paths that must match exactly (never treated as prefixes).
PUBLIC_EXACT_PATHS: frozenset[str] = frozenset({
    "/",
})

# Path prefixes that are public. Must not include bare "/".
PUBLIC_PREFIXES: tuple[str, ...] = (
    "/health",
    "/ready",
    "/metrics",
    "/docs",
    "/openapi",
    "/redoc",
    "/auth/",
)


def is_public_route(path: str) -> bool:
    """Return True if *path* is exempt from API-token / JWT middleware auth."""
    if path in PUBLIC_EXACT_PATHS:
        return True
    return any(path.startswith(prefix) for prefix in PUBLIC_PREFIXES)
