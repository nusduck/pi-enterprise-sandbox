"""Pytest bootstrap — host-safe paths before any sandbox imports.

Sets SANDBOX_* env vars at collection time so the Settings singleton and
module-level database.initialize() never touch /sandbox (read-only on macOS).
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

# ── Temp roots for this test process ────────────────────────────────────
_TEST_ROOT = Path(tempfile.mkdtemp(prefix="pi_sandbox_pytest_"))
_WORKSPACES = _TEST_ROOT / "workspaces"
_SKILLS = _TEST_ROOT / "skill"
_DATA = _TEST_ROOT / "data"

_WORKSPACES.mkdir(parents=True, exist_ok=True)
_SKILLS.mkdir(parents=True, exist_ok=True)
_DATA.mkdir(parents=True, exist_ok=True)

# Force env BEFORE sandbox.config / sandbox.database are imported by tests.
# Use assignment (not setdefault) so a host SANDBOX_DATABASE_URL pointing at
# /sandbox cannot break collection.
os.environ["SANDBOX_DATABASE_URL"] = f"sqlite:///{_DATA / 'sandbox.db'}"
os.environ["SANDBOX_WORKSPACES_ROOT"] = str(_WORKSPACES)
os.environ["SANDBOX_SKILLS_ROOT"] = str(_SKILLS)
# Default allowlist includes loopback; pair with TestClient client=127.0.0.1 below.
os.environ.setdefault(
    "SANDBOX_ALLOWED_CLIENT_CIDRS",
    "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
)
os.environ.setdefault("SANDBOX_TRUSTED_PROXY_CIDRS", "")


def pytest_configure(config):  # noqa: ARG001
    """Re-assert env and ensure dirs exist early in the pytest lifecycle."""
    os.environ["SANDBOX_DATABASE_URL"] = f"sqlite:///{_DATA / 'sandbox.db'}"
    os.environ["SANDBOX_WORKSPACES_ROOT"] = str(_WORKSPACES)
    os.environ["SANDBOX_SKILLS_ROOT"] = str(_SKILLS)
    _WORKSPACES.mkdir(parents=True, exist_ok=True)
    _SKILLS.mkdir(parents=True, exist_ok=True)
    _DATA.mkdir(parents=True, exist_ok=True)

    # Starlette TestClient defaults client host to "testclient" (not an IP).
    # Point it at loopback so the inbound allowlist middleware accepts suite traffic.
    try:
        from starlette.testclient import TestClient

        _orig_init = TestClient.__init__

        def _init_with_loopback(self, *args, **kwargs):  # noqa: ANN001
            kwargs.setdefault("client", ("127.0.0.1", 50000))
            return _orig_init(self, *args, **kwargs)

        if getattr(TestClient.__init__, "_sandbox_loopback_patch", False) is not True:
            _init_with_loopback._sandbox_loopback_patch = True  # type: ignore[attr-defined]
            TestClient.__init__ = _init_with_loopback  # type: ignore[method-assign]
    except Exception:
        pass


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """Best-effort cleanup of the temp test root."""
    import shutil

    shutil.rmtree(_TEST_ROOT, ignore_errors=True)
