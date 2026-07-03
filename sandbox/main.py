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

    # Ensure workspaces root exists
    settings.workspaces_path.mkdir(parents=True, exist_ok=True)
    settings.skills_path.mkdir(parents=True, exist_ok=True)

    logger.info(
        "Workspaces: %s | Skills: %s | MCP: %s",
        settings.workspaces_path,
        settings.skills_path,
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

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


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


# ── Error handlers ─────────────────────────────────────────────────────

@app.exception_handler(PermissionError)
async def permission_error_handler(request: Request, exc: PermissionError):
    return JSONResponse(
        status_code=403,
        content={"detail": str(exc)},
    )


@app.exception_handler(ValueError)
async def value_error_handler(request: Request, exc: ValueError):
    return JSONResponse(
        status_code=400,
        content={"detail": str(exc)},
    )


# ── Register routers ───────────────────────────────────────────────────

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
