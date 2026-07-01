"""Sandbox Service — FastAPI application entry point."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from sandbox import __version__
from sandbox.config import settings
from sandbox.routers import (
    artifacts,
    executions,
    files,
    health,
    mcp_router,
    sessions,
)


def _configure_logging() -> None:
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )


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
    yield
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
app.include_router(executions.router)
app.include_router(files.router)
app.include_router(artifacts.router)
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
