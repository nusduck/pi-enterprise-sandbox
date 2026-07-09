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


def pytest_configure(config):  # noqa: ARG001
    """Re-assert env and ensure dirs exist early in the pytest lifecycle."""
    os.environ["SANDBOX_DATABASE_URL"] = f"sqlite:///{_DATA / 'sandbox.db'}"
    os.environ["SANDBOX_WORKSPACES_ROOT"] = str(_WORKSPACES)
    os.environ["SANDBOX_SKILLS_ROOT"] = str(_SKILLS)
    _WORKSPACES.mkdir(parents=True, exist_ok=True)
    _SKILLS.mkdir(parents=True, exist_ok=True)
    _DATA.mkdir(parents=True, exist_ok=True)


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """Best-effort cleanup of the temp test root."""
    import shutil

    shutil.rmtree(_TEST_ROOT, ignore_errors=True)
