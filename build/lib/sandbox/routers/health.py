"""Health check router."""

from __future__ import annotations

import shutil

from fastapi import APIRouter
from prometheus_client import Counter, Gauge, generate_latest

from sandbox import __version__
from sandbox.config import settings
from sandbox.models import HealthResponse
from sandbox.services.execution_manager import execution_manager
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(tags=["monitoring"])

# ── Prometheus metrics ─────────────────────────────────────────────────

sandbox_execution_total = Counter(
    "sandbox_execution_total", "Total executions",
    ["session_id", "status"],
)
sandbox_execution_failed_total = Counter(
    "sandbox_execution_failed_total", "Failed executions",
)
sandbox_execution_timeout_total = Counter(
    "sandbox_execution_timeout_total", "Timed out executions",
)
sandbox_execution_duration_seconds = Gauge(
    "sandbox_execution_duration_seconds",
    "Execution duration in seconds",
)
sandbox_active_sessions = Gauge(
    "sandbox_active_sessions", "Active sessions",
)
sandbox_workspace_bytes = Gauge(
    "sandbox_workspace_bytes", "Workspace disk usage bytes",
)
sandbox_mcp_requests_total = Counter(
    "sandbox_mcp_requests_total", "Total MCP requests",
    ["tool_name"],
)
sandbox_rate_limited_total = Counter(
    "sandbox_rate_limited_total", "Rate limited requests",
    ["caller_id"],
)


def _check_runtime(name: str) -> bool:
    return shutil.which(name) is not None


@router.get("/health", response_model=HealthResponse)
def health():
    return HealthResponse(
        status="ok",
        version=__version__,
        sessions_active=session_manager.count_active(),
        executions_total=execution_manager.total_count,
        workspace_available=True,
        disk_free_mb=workspace_manager.disk_free_mb,
        runtimes={
            "python": _check_runtime("python3"),
            "bash": _check_runtime("bash"),
            "node": _check_runtime("node"),
        },
    )


@router.get("/ready", response_model=HealthResponse)
def ready():
    # Ready = we can accept requests and workspace is writable
    ws = settings.workspaces_path
    writable = ws.exists() and ws.is_dir()
    return HealthResponse(
        status="ok" if writable else "degraded",
        version=__version__,
        sessions_active=session_manager.count_active(),
        workspace_available=writable,
        disk_free_mb=workspace_manager.disk_free_mb if writable else 0.0,
        runtimes={
            "python": _check_runtime("python3"),
            "bash": _check_runtime("bash"),
            "node": _check_runtime("node"),
        },
    )


@router.get("/metrics")
def metrics():
    # Update gauges before serving
    sandbox_active_sessions.set(session_manager.count_active())
    return generate_latest()
