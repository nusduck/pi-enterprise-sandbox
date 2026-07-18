"""Centralized public-route policy for auth middleware.

Root ``/`` is exact-only so it can never silently make every absolute path public
via ``startswith("/")``. Health, docs, metrics and ``/auth/`` are prefix matches.

Internal Agent plane paths (``/internal/v1`` …) are **not** public: they bypass
legacy API-key / JWT middleware only so the dedicated internal HMAC dependency
is the sole authenticator (see :func:`is_internal_v1_route`).
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

# Exact internal root (no trailing slash) accepted by some clients.
_INTERNAL_V1_EXACT = "/internal/v1"
# Strict prefix for all internal plane routes (trailing slash required for prefix).
_INTERNAL_V1_PREFIX = "/internal/v1/"


def is_public_route(path: str) -> bool:
    """Return True if *path* is exempt from API-token / JWT middleware auth."""
    if path in PUBLIC_EXACT_PATHS:
        return True
    return any(path.startswith(prefix) for prefix in PUBLIC_PREFIXES)


def is_internal_v1_route(path: str) -> bool:
    """Return True only for the Agent -> Sandbox internal plane path boundary.

    Matches ``/internal/v1`` exactly and paths under ``/internal/v1/``.
    Does **not** match ``/internal``, ``/internal/v10``, or other near-misses.
    Legacy API-key / user JWT must not authenticate these paths.
    """
    if path == _INTERNAL_V1_EXACT:
        return True
    return path.startswith(_INTERNAL_V1_PREFIX)
