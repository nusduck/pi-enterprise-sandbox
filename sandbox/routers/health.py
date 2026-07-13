"""Health check router.

``/health`` — process liveness (always 200 if this handler runs).
``/ready``  — dependency readiness (503 when storage, DB, or isolation fails).

Neither endpoint returns secrets, connection strings, absolute host paths,
or environment dumps.
"""

from __future__ import annotations

import logging
import shutil

from fastapi import APIRouter, Response
from prometheus_client import Counter, Gauge, generate_latest

from sandbox import __version__
from sandbox.config import settings
from sandbox.database import database
from sandbox.isolation import isolation_preflight
from sandbox.models import HealthResponse
from sandbox.services.execution_manager import execution_manager
from sandbox.services.session_manager import session_manager
from sandbox.services.workspace_manager import workspace_manager

router = APIRouter(tags=["monitoring"])
logger = logging.getLogger(__name__)

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
sandbox_client_denied_total = Counter(
    "sandbox_client_denied_total",
    "Inbound clients rejected by CIDR allowlist",
    ["reason"],
)


def _check_runtime(name: str) -> bool:
    return shutil.which(name) is not None


def _runtimes() -> dict[str, bool]:
    return {
        "python": _check_runtime("python3"),
        "bash": _check_runtime("bash"),
        "node": _check_runtime("node"),
    }


def _workspace_ready() -> tuple[bool, float]:
    """Return ``(writable, disk_free_mb)`` for the workspaces root.

    Creates the root if missing, then probes write+unlink. Never returns
    path strings or other host details.
    """
    try:
        for root in (settings.workspaces_path, settings.temp_path):
            root.mkdir(parents=True, exist_ok=True)
            if not root.is_dir():
                return False, 0.0
            probe = root / ".ready_write_probe"
            probe.write_bytes(b"ok")
            probe.unlink(missing_ok=True)
        return True, workspace_manager.disk_free_mb
    except OSError:
        logger.warning("readiness: workspaces root not writable")
        return False, 0.0


def _database_ready() -> bool:
    """Ping persistence without returning connection details or URLs."""
    try:
        with database.connect() as conn:
            conn.execute("SELECT 1")
        return True
    except Exception:
        # Broad catch: any backend failure means not ready. Do not log URL/credentials.
        logger.warning("readiness: database ping failed")
        return False


@router.get("/health", response_model=HealthResponse)
def health():
    """Liveness probe — process is up. Always 200 if the service answers."""
    try:
        free = workspace_manager.disk_free_mb
        ws_avail = True
    except OSError:
        free = 0.0
        ws_avail = False
    isolation = isolation_preflight.snapshot()
    return HealthResponse(
        status="ok",
        version=__version__,
        sessions_active=session_manager.count_active(),
        executions_total=execution_manager.total_count,
        workspace_available=ws_avail,
        disk_free_mb=free,
        runtimes=_runtimes(),
        isolation_backend=isolation.backend,
        isolation_required=isolation.required,
        isolation_preflight_passed=isolation.passed,
        isolation_policy_version=isolation.policy_version,
    )


@router.get("/ready", response_model=HealthResponse)
def ready(response: Response):
    """Readiness probe — dependencies can accept work.

    Checks:
    - workspace and persistent-temp roots exist and are writable
    - database accepts a simple ``SELECT 1``
    - configured process-isolation backend passes preflight

    Returns **503** with ``status: "not_ready"`` when any check fails.
    Does not include secrets, env dumps, or absolute paths.
    """
    isolation = isolation_preflight.snapshot()
    if not isolation.checked:
        # Some embedded/TestClient users do not enter the ASGI lifespan. Keep
        # readiness authoritative by performing the same preflight lazily.
        try:
            isolation = isolation_preflight.check(settings)
        except Exception:
            isolation = isolation_preflight.snapshot()

    ws_ok, free = _workspace_ready()
    db_ok = _database_ready()
    isolation_ok = isolation.checked and isolation.passed
    is_ready = ws_ok and db_ok and isolation_ok
    if not is_ready:
        response.status_code = 503
    return HealthResponse(
        status="ok" if is_ready else "not_ready",
        version=__version__,
        sessions_active=session_manager.count_active(),
        executions_total=execution_manager.total_count,
        workspace_available=ws_ok,
        disk_free_mb=free if ws_ok else 0.0,
        runtimes=_runtimes(),
        isolation_backend=isolation.backend,
        isolation_required=isolation.required,
        isolation_preflight_passed=isolation.passed,
        isolation_policy_version=isolation.policy_version,
    )


@router.get("/metrics")
def metrics():
    # Update gauges before serving
    sandbox_active_sessions.set(session_manager.count_active())
    return generate_latest()
