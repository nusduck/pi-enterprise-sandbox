"""Sandbox Service — FastAPI application entry point."""

from __future__ import annotations

import asyncio
import logging
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from sandbox import __version__
from sandbox.config import effective_config, ensure_safe_to_start, settings
from sandbox.routers import (
    agent_runs,
    agent_sessions,
    approvals,
    artifacts,
    conversations,
    executions,
    files,
    health,
    mcp_router,
    processes,
    sessions,
    traces,
)
from sandbox.routers import auth_router
from sandbox.security.network_policy import get_network_policy, init_network_policy
from sandbox.services.session_manager import session_manager
from sandbox.trace import reset_trace_id, set_trace_id

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


async def _cleanup_loop() -> None:
    """Background task: session TTL then retention (drafts/inactive/audit)."""
    logger = logging.getLogger("sandbox.cleanup")
    while True:
        try:
            await asyncio.sleep(settings.cleanup_interval_minutes * 60)
            count = session_manager.cleanup_expired()
            if count:
                logger.info("Cleaned up %d expired sessions", count)
            # Retention: 24h drafts, 90d inactive conversations, 180d events/audit.
            # Logs metrics only (ids/counts); never message bodies.
            try:
                from sandbox.services.ttl_cleanup import run_retention_cleanup

                report = run_retention_cleanup(dry_run=False)
                if report.get("deleted_total"):
                    logger.info(
                        "Retention cleanup deleted_total=%s duration_ms=%s",
                        report.get("deleted_total"),
                        report.get("duration_ms"),
                    )
            except Exception:
                logger.exception("Error during retention cleanup")
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Error during session cleanup")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    _configure_logging()
    logger = logging.getLogger("sandbox")
    # Belt-and-suspenders: re-validate production matrix on lifespan start.
    ensure_safe_to_start(settings)
    logger.info(
        "Sandbox Service v%s starting (deployment_env=%s network_mode=%s)",
        __version__,
        settings.deployment_env,
        settings.network_mode,
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
    settings.skills_path.mkdir(parents=True, exist_ok=True)

    # Best-effort skill presentation dir (container layout). Workspace
    # identity is opaque workspace_id + relative paths; no public absolute cwd.
    from pathlib import Path

    from sandbox.paths import AGENT_SKILL_PATH, LEGACY_AGENT_WORKSPACE_PATH

    for agent_path in (LEGACY_AGENT_WORKSPACE_PATH, AGENT_SKILL_PATH):
        try:
            Path(agent_path).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass  # host tests may not have permission under /home/sandbox

    logger.info(
        "Workspaces root configured | Skills configured | MCP: %s",
        "enabled" if settings.mcp_enabled else "disabled",
    )

    # Process Manager: re-scan orphaned processes after schema is ready
    try:
        from sandbox.database import database as _db
        from sandbox.services.process_manager import process_manager

        _db.migrate_agent_session()
        _db.migrate_process()
        _db.migrate_execution_events()
        _db.migrate_tool_ledger()
        _db.migrate_b6_runtime()
        _db.migrate_agent_run_usage()
        orphaned = process_manager.mark_orphans()
        if orphaned:
            logger.info("Process Manager marked %d orphaned process(es)", orphaned)
    except Exception:
        logger.exception("Process Manager orphan scan failed at startup")

    # Start session + retention background cleanup task
    cleanup_task = asyncio.create_task(_cleanup_loop())
    logger.info(
        "Session + retention cleanup every %d minutes "
        "(drafts=%dh inactive=%dd audit=%dd)",
        settings.cleanup_interval_minutes,
        settings.draft_ttl_hours,
        settings.conversation_ttl_days,
        settings.audit_ttl_days,
    )

    yield

    # Shutdown: cancel the cleanup task
    cleanup_task.cancel()
    try:
        await cleanup_task
    except asyncio.CancelledError:
        pass
    logger.info("Sandbox Service shutting down")


app = FastAPI(
    title="Enterprise Sandbox Runtime",
    description="Enterprise-grade secure execution sandbox for Pi Agent",
    version=__version__,
    lifespan=lifespan,
)

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
    """Require X-API-Key header for all endpoints except health/public, if configured."""
    if settings.api_token:
        from sandbox.security.public_routes import is_public_route

        if not is_public_route(request.url.path):
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
    internal routes (e.g. /sessions). End-user actor identity is resolved from:

      1. Authorization: Bearer <user jwt>
      2. Service token + X-Acting-User-Id + X-Acting-Organization-Id

    Service token alone is **not** an end-user actor; ownership routes require
    an actor via ``require_actor`` (401). Public: health, auth, docs, metrics.
    """
    if not settings.auth_enabled:
        return await call_next(request)

    from sandbox.security.ownership import apply_actor_to_request_state
    from sandbox.security.public_routes import is_public_route

    if is_public_route(request.url.path):
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
    """Attach a trace ID to request context and echo it in responses."""
    trace_id = request.headers.get("X-Trace-Id") or f"trace_{uuid.uuid4().hex}"
    token = set_trace_id(trace_id)
    try:
        response = await call_next(request)
        response.headers["X-Trace-Id"] = trace_id
        return response
    finally:
        reset_trace_id(token)


@app.middleware("http")
async def mcp_auth_middleware(request: Request, call_next):
    """Check X-Auth-Token for /mcp/ endpoints if auth tokens are configured."""
    if (
        settings.mcp_auth_tokens
        and request.url.path.startswith("/mcp/")
    ):
        token = request.headers.get("X-Auth-Token", "")
        if token not in settings.mcp_auth_tokens:
            return JSONResponse(
                status_code=401,
                content={"detail": "Invalid or missing MCP auth token"},
            )
    return await call_next(request)


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

    Applied to HTTP and MCP (``/mcp/*``) alike. All routes including
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

app.include_router(auth_router.router)
app.include_router(agent_runs.router)
app.include_router(agent_sessions.router)
app.include_router(sessions.router)
app.include_router(approvals.router)
app.include_router(conversations.router)
app.include_router(executions.router)
app.include_router(processes.router)
app.include_router(files.router)
app.include_router(artifacts.router)
app.include_router(traces.router)
app.include_router(health.router)
app.include_router(mcp_router.router)


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
