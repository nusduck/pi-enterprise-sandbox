"""Sandbox Service — FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from sandbox import __version__
from sandbox.config import (
    effective_config,
    ensure_safe_to_start,
    settings,
)
from sandbox.routers import (
    health,
    internal_artifacts,
    internal_executions,
    internal_files,
    internal_processes,
    internal_sessions,
)
from sandbox.security.internal_http_auth import set_replay_store
from sandbox.security.network_policy import get_network_policy, init_network_policy
from sandbox.services.files_read_runtime import set_files_read_runtime
from sandbox.services.files_write_runtime import set_files_write_runtime
from sandbox.services.formal_execution_runtime import set_formal_execution_runtime
from sandbox.services.formal_artifact_runtime import set_formal_artifact_runtime
from sandbox.services.formal_process_runtime import set_formal_process_runtime
from sandbox.services.formal_session_runtime import set_formal_session_runtime
from sandbox.trace import (
    format_traceparent,
    reset_trace_context,
    resolve_trace_context,
    set_trace_context,
)

# Fail-fast before uvicorn binds when import loads this module in production.
ensure_safe_to_start(settings)

def _configure_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


def _cors_origins() -> list[str]:
    """Production requires an explicit allowlist; development may use '*'."""
    origins = [o.strip() for o in (settings.cors_origins or []) if o and str(o).strip()]
    if settings.is_production:
        # Defensive: validator already rejects '*'; still never emit empty/wildcard.
        cleaned = [o for o in origins if o != "*"]
        return cleaned or ["https://localhost"]
    return origins or ["*"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    _configure_logging()
    logger = logging.getLogger("sandbox")
    # Belt-and-suspenders: re-validate production matrix on lifespan start.
    ensure_safe_to_start(settings)
    logger.info(
        "Sandbox Service v%s starting (deployment_env=%s network_mode=%s "
        "internal_plane_enabled=%s)",
        __version__,
        settings.deployment_env,
        settings.network_mode,
        settings.internal_plane_enabled,
    )
    logger.info("Effective config (redacted): %s", effective_config(settings))

    # Validate and install inbound network policy (illegal CIDR fails startup).
    policy = init_network_policy(settings)
    logger.info(
        "Bind host: %s | Client allowlist: %d CIDR(s) | Trusted proxies: %d CIDR(s)",
        policy.bind_host,
        len(policy.allowed_networks),
        len(policy.trusted_proxy_networks),
    )

    # Ensure physical storage roots exist
    settings.workspaces_path.mkdir(parents=True, exist_ok=True)
    settings.temp_path.mkdir(parents=True, exist_ok=True)
    settings.skills_path.mkdir(parents=True, exist_ok=True)

    # Fail closed when isolation is required. Development direct mode still
    # runs this check so readiness truthfully reports the selected backend.
    from sandbox.isolation import isolation_preflight

    isolation_preflight.check(settings)

    # Best-effort skill presentation dir (container layout). Workspace
    # identity is opaque workspace_id + relative paths; no public absolute cwd.
    from pathlib import Path

    from sandbox.paths import AGENT_SKILL_PATH, LEGACY_AGENT_WORKSPACE_PATH

    for agent_path in (LEGACY_AGENT_WORKSPACE_PATH, AGENT_SKILL_PATH):
        try:
            Path(agent_path).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass  # host tests may not have permission under /home/sandbox

    logger.info("Workspaces root configured | Skills configured")

    # Formal MySQL schema is owned by Agent migrations.  Sandbox never performs
    # DDL or maintains a second session/run/retention store.

    # Internal control plane (HMAC replay Redis + claim MySQL + files.read).
    # Production requires enablement (validate_production_settings). Fail closed
    # on prepare/install errors so the process never accepts traffic half-ready.
    from sandbox.services.internal_plane_resources import InternalPlaneError
    from sandbox.services.internal_plane_wiring import (
        start_internal_plane,
        stop_internal_plane,
    )

    plane_bundle = None
    try:
        plane_bundle = await start_internal_plane(app, settings)
    except InternalPlaneError as exc:
        logger.error(
            "internal plane startup failed category=%s state=%s — refusing to serve",
            exc.category,
            exc.state,
        )
        raise
    except Exception as exc:
        logger.error(
            "internal plane startup failed type=%s — refusing to serve",
            type(exc).__name__,
        )
        raise

    try:
        yield
    finally:
        # Shutdown order: stop the internal plane (slots fail closed → drain →
        # close); never leave READY/INSTALLED without live resources.
        try:
            await stop_internal_plane(plane_bundle)
        except Exception as exc:
            logger.warning(
                "internal plane shutdown failed type=%s",
                type(exc).__name__,
            )
        logger.info("Sandbox Service shutting down")


app = FastAPI(
    title="Enterprise Sandbox Runtime",
    description="Enterprise-grade secure execution sandbox for Pi Agent",
    version=__version__,
    lifespan=lifespan,
)

# Explicit replay-store slot for internal HMAC auth. Production wiring must
# inject an authoritative RedisReplayStore; never auto-fallback to memory.
# Unconfigured → internal requests fail closed (see internal_http_auth).
set_replay_store(app, None)

# Explicit files.read runtime slot. Import-time is always None — never
# construct MySQL claim validators / filesystem drivers at module import.
# Production lifespan/wiring injects FilesReadRuntime; unconfigured → 503.
set_files_read_runtime(app, None)
set_files_write_runtime(app, None)
set_formal_execution_runtime(app, None)
set_formal_artifact_runtime(app, None)
set_formal_process_runtime(app, None)
set_formal_session_runtime(app, None)

# ── Middleware ──────────────────────────────────────────────────────────
# Starlette runs middleware in reverse registration order on the way in.
# Register allowlist last so it runs first — before auth and business routes.

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=settings.cors_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def api_token_auth_middleware(request: Request, call_next):
    """Require X-API-Key for non-public, non-internal routes when configured.

    ``/internal/v1`` and ``/internal/v1/*`` are excluded so legacy API keys cannot
    authenticate the Agent internal plane; those paths use HMAC internal auth only.
    """
    if settings.api_token:
        from sandbox.security.public_routes import is_internal_v1_route, is_public_route

        path = request.url.path
        if not is_public_route(path) and not is_internal_v1_route(path):
            token = request.headers.get(settings.api_token_header, "")
            if token != settings.api_token:
                return JSONResponse(
                    status_code=401,
                    content={"detail": "Invalid or missing API token"},
                )
    return await call_next(request)


@app.middleware("http")
async def jwt_auth_middleware(request: Request, call_next):
    """Optional user JWT when SANDBOX_AUTH_ENABLED=true.

    Service-to-service X-API-Key still authenticates the *service* and may reach
    legacy internal-ish routes (e.g. /sessions). End-user actor identity is
    resolved from:

      1. Authorization: Bearer <user jwt>
      2. Service token + X-Acting-User-Id + X-Acting-Organization-Id

    Service token alone is **not** an end-user actor; ownership routes require
    an actor via ``require_actor`` (401). Public: health, auth, docs, metrics.

    The Agent internal plane (``/internal/v1`` …) is bypassed here: user JWT and
    service API keys must not grant access; only HMAC internal auth does.
    """
    if not settings.auth_enabled:
        return await call_next(request)

    from sandbox.security.ownership import apply_actor_to_request_state
    from sandbox.security.public_routes import is_internal_v1_route, is_public_route

    path = request.url.path
    if is_public_route(path) or is_internal_v1_route(path):
        return await call_next(request)

    # Always try to attach actor (JWT or service+acting); never trust alone for identity
    actor = apply_actor_to_request_state(request)
    if actor is not None:
        return await call_next(request)

    # Valid service API key: allow request through without end-user actor
    # (sessions/health-style internal ops). Ownership routes still call require_actor.
    if settings.api_token:
        svc = request.headers.get(settings.api_token_header, "")
        if svc and svc == settings.api_token:
            return await call_next(request)

    # No JWT, no service token → 401
    return JSONResponse(status_code=401, content={"detail": "Authentication required"})


@app.middleware("http")
async def trace_id_middleware(request: Request, call_next):
    """Attach a W3C child span to request context and echo correlation headers."""
    context = resolve_trace_context(
        request.headers.get("traceparent"),
        request.headers.get("X-Trace-Id"),
    )
    token = set_trace_context(context)
    request.state.trace_id = context.trace_id
    request.state.span_id = context.span_id
    request.state.parent_span_id = context.parent_span_id
    try:
        response = await call_next(request)
        response.headers["X-Trace-Id"] = context.trace_id
        response.headers["traceparent"] = format_traceparent(context)
        return response
    finally:
        reset_trace_context(token)


@app.middleware("http")
async def request_logging(request: Request, call_next):
    """Log every incoming request with duration."""
    import time

    start = time.monotonic()
    response = await call_next(request)
    duration_ms = (time.monotonic() - start) * 1000

    logger = logging.getLogger("sandbox.access")
    logger.info(
        "%s %s -> %s (%.0fms)",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    return response


@app.middleware("http")
async def client_allowlist_middleware(request: Request, call_next):
    """Reject clients outside SANDBOX_ALLOWED_CLIENT_CIDRS before auth/routes.

    Effective client IP:
    - Default: TCP peer only (``X-Forwarded-For`` ignored).
    - If peer ∈ SANDBOX_TRUSTED_PROXY_CIDRS: parse XFF right-to-left,
      stripping trusted hops.

    Applied to all Sandbox HTTP routes, including
    ``/health`` and ``/ready`` are gated for consistency; loopback is in the
    default allowlist so container healthchecks keep working. Add the probe
    network to the allowlist if orchestrator probes arrive from elsewhere.
    """
    policy = get_network_policy()
    peer = request.client.host if request.client else None
    xff = request.headers.get("x-forwarded-for")
    allowed, effective, reason = policy.evaluate(peer, xff)

    # Expose resolved IP to downstream handlers without re-parsing headers.
    request.state.client_ip = str(effective) if effective is not None else None
    request.state.client_ip_reason = reason

    if allowed:
        return await call_next(request)

    try:
        from sandbox.routers.health import sandbox_client_denied_total

        sandbox_client_denied_total.labels(reason=reason).inc()
    except Exception:  # pragma: no cover — metrics must not break deny path
        pass

    logging.getLogger("sandbox.security.network_policy").warning(
        "Client denied method=%s path=%s reason=%s",
        request.method,
        request.url.path,
        reason,
    )
    return JSONResponse(
        status_code=403,
        content={"detail": "Client address not allowlisted"},
    )


# ── Error handlers ─────────────────────────────────────────────────────

@app.exception_handler(PermissionError)
async def permission_error_handler(request: Request, exc: PermissionError):
    from sandbox.paths import sanitize_path_error

    return JSONResponse(
        status_code=403,
        content={"detail": sanitize_path_error(str(exc))},
    )


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    from sandbox.paths import sanitize_path_error

    return JSONResponse(
        status_code=400,
        content={"detail": sanitize_path_error(str(exc))},
    )


# ── Register routers ───────────────────────────────────────────────────

# Public file, dataset, and artifact adapters are retained only for the
# user-facing BFF flows. Session identity and all authority come from the
# formal AgentSession/SandboxSession binding installed by the internal plane.
from sandbox.routers import artifacts, datasets, files

app.include_router(files.router)
app.include_router(datasets.router)
app.include_router(artifacts.router)
app.include_router(health.router)
# Agent internal plane (HMAC only). Not public; JWT/API-key middleware skips
# /internal/v1 but cannot authenticate — require_internal_auth is sole gate.
app.include_router(internal_files.router)
app.include_router(internal_executions.router)
app.include_router(internal_artifacts.router)
app.include_router(internal_sessions.router)
app.include_router(internal_processes.router)


# ── Root ───────────────────────────────────────────────────────────────

@app.get("/")
def root():
    return {
        "service": "enterprise-sandbox",
        "version": __version__,
        "docs": "/docs",
        "health": "/health",
        "metrics": "/metrics",
    }
