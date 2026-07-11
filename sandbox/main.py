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
from sandbox.config import settings
from sandbox.routers import (
    approvals,
    artifacts,
    conversations,
    executions,
    files,
    health,
    mcp_router,
    sessions,
    traces,
)
from sandbox.routers import auth_router, agent_router
from sandbox.security.network_policy import get_network_policy, init_network_policy
from sandbox.services.session_manager import session_manager
from sandbox.trace import reset_trace_id, set_trace_id


def _configure_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


async def _cleanup_loop() -> None:
    """Background task: periodically clean up expired sessions."""
    logger = logging.getLogger("sandbox.cleanup")
    while True:
        try:
            await asyncio.sleep(settings.cleanup_interval_minutes * 60)
            count = session_manager.cleanup_expired()
            if count:
                logger.info("Cleaned up %d expired sessions", count)
        except asyncio.CancelledError:
            break
        except Exception:
            logger.exception("Error during session cleanup")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup / shutdown lifecycle."""
    _configure_logging()
    logger = logging.getLogger("sandbox")
    logger.info("Sandbox Service v%s starting", __version__)

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

    # Best-effort agent-visible presentation dirs (container layout)
    from pathlib import Path

    from sandbox.paths import AGENT_SKILL_PATH, AGENT_WORKSPACE_PATH

    for agent_path in (AGENT_WORKSPACE_PATH, AGENT_SKILL_PATH):
        try:
            Path(agent_path).mkdir(parents=True, exist_ok=True)
        except OSError:
            pass  # host tests may not have permission under /home/sandbox

    logger.info(
        "Workspaces: %s | Skills: %s | Agent paths: %s , %s | MCP: %s",
        settings.workspaces_path,
        settings.skills_path,
        settings.agent_workspace_path,
        settings.agent_skill_path,
        "enabled" if settings.mcp_enabled else "disabled",
    )

    # Start TTL background cleanup task
    cleanup_task = asyncio.create_task(_cleanup_loop())
    logger.info(
        "Session cleanup every %d minutes",
        settings.cleanup_interval_minutes,
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
    allow_origins=["*"],
    allow_credentials=True,
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
app.include_router(agent_router.router)
app.include_router(sessions.router)
app.include_router(approvals.router)
app.include_router(conversations.router)
app.include_router(executions.router)
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
