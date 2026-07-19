"""Regression: formal MySQL configuration has no legacy import side effects."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_import_sandbox_main_with_mysql_dsn_is_connection_free() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    removed_modules = (
        "sandbox/database.py",
        "sandbox/repositories.py",
        "sandbox/services/execution_stream.py",
        "sandbox/services/session_manager.py",
        "sandbox/services/approval_manager.py",
        "sandbox/services/ttl_cleanup.py",
        "sandbox/routers/sessions.py",
        "sandbox/routers/conversations.py",
        "sandbox/routers/approvals.py",
        "sandbox/routers/executions.py",
        "sandbox/routers/processes.py",
        "sandbox/routers/traces.py",
        "sandbox/routers/auth_router.py",
    )
    for relative in removed_modules:
        assert not (repo_root / relative).exists(), relative
    sandbox_sources = (repo_root / "sandbox").rglob("*.py")
    for source_path in sandbox_sources:
        source = source_path.read_text(encoding="utf-8")
        assert "SANDBOX_LEGACY_TEST_RUNTIME" not in source, source_path
        assert "sandbox.database" not in source, source_path
        assert "sandbox.repositories" not in source, source_path
    env = os.environ.copy()
    env.update(
        {
            "SANDBOX_DATABASE_URL": (
                "mysql+pymysql://sandbox:dev@127.0.0.1:1/sandbox"
            ),
            "SANDBOX_AUTH_ENABLED": "false",
            "SANDBOX_INTERNAL_PLANE_ENABLED": "false",
        }
    )

    script = """
import sys
from sandbox.main import app

for forbidden in (
    "sandbox.database",
    "sandbox.repositories",
    "sandbox.services.execution_stream",
    "sandbox.services.session_manager",
    "sandbox.services.ttl_cleanup",
    "sandbox.routers.traces",
):
    assert forbidden not in sys.modules, forbidden
assert not any(name.startswith("psycopg") for name in sys.modules)
paths = set(app.openapi()["paths"])
assert "/internal/v1/sessions/ensure" in paths
assert "/internal/v1/executions/bash" in paths
assert "/sessions/{session_id}/files" in paths
assert "/sessions/{session_id}/datasets" in paths
assert "/sessions/{session_id}/artifacts" in paths
assert "/sessions" not in paths
assert "/auth/me" not in paths
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=repo_root,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Unsupported database URL scheme" not in result.stderr
    assert "process orphan scan failed" not in result.stderr


def test_sqlite_dsn_cannot_activate_sandbox_runtime() -> None:
    """A stale development DSN must fail before removed imports could occur."""
    repo_root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update(
        {
            "DEPLOYMENT_ENV": "development",
            "SANDBOX_DATABASE_URL": "sqlite:////tmp/stale-sandbox.db",
            "SANDBOX_AUTH_ENABLED": "false",
            "SANDBOX_INTERNAL_PLANE_ENABLED": "false",
        }
    )
    script = """
try:
    import sandbox.main  # noqa: F401
except Exception as exc:
    assert "formal Sandbox runtime" in str(exc), repr(exc)
else:
    raise AssertionError("SQLite unexpectedly activated Sandbox runtime")
"""
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=repo_root,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "sandbox.database" not in result.stderr


def test_formal_mysql_public_resource_routes_fail_closed_without_runtime() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    env = os.environ.copy()
    env.update(
        {
            "SANDBOX_DATABASE_URL": (
                "mysql+pymysql://sandbox:dev@127.0.0.1:1/sandbox"
            ),
            "SANDBOX_AUTH_ENABLED": "false",
            "SANDBOX_INTERNAL_PLANE_ENABLED": "false",
        }
    )
    script = """
from fastapi.testclient import TestClient
from sandbox.main import app

client = TestClient(app, client=("127.0.0.1", 50000))
assert client.get("/auth/me").status_code == 404
assert client.get("/sessions").status_code == 404
assert client.get("/sessions/missing/files").status_code == 503
assert client.get("/sessions/missing/datasets").status_code == 503
assert client.get("/sessions/missing/artifacts").status_code == 503
"""

    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=repo_root,
        env=env,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )

    assert result.returncode == 0, result.stderr
