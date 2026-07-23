"""Pytest bootstrap — host-safe paths before any sandbox imports.

Sets SANDBOX_* env vars at collection time so the Settings singleton uses
host-safe storage roots and a non-routable formal MySQL test DSN.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

# ── Temp roots for this test process ────────────────────────────────────
_TEST_ROOT = Path(tempfile.mkdtemp(prefix="pi_sandbox_pytest_"))
_WORKSPACES = _TEST_ROOT / "workspaces"
_TEMPS = _TEST_ROOT / "tmp-workspaces"
_SKILLS = _TEST_ROOT / "skill"
_ARTIFACTS = _TEST_ROOT / "artifacts"
_CONTROL = _TEST_ROOT / "control"

_WORKSPACES.mkdir(parents=True, exist_ok=True)
_TEMPS.mkdir(parents=True, exist_ok=True)
_SKILLS.mkdir(parents=True, exist_ok=True)
_ARTIFACTS.mkdir(parents=True, exist_ok=True)
_CONTROL.mkdir(parents=True, exist_ok=True)

# Force env BEFORE sandbox.config is imported by tests.
# Use assignment (not setdefault) so host/.env values cannot pollute the suite.
os.environ["SANDBOX_DATABASE_URL"] = (
    "mysql+pymysql://sandbox@127.0.0.1:3306/pi_sandbox_unit_test"
)
os.environ["SANDBOX_WORKSPACES_ROOT"] = str(_WORKSPACES)
os.environ["SANDBOX_TEMP_ROOT"] = str(_TEMPS)
os.environ["SANDBOX_SKILLS_ROOT"] = str(_SKILLS)
os.environ["SANDBOX_ARTIFACTS_ROOT"] = str(_ARTIFACTS)
os.environ["SANDBOX_CONTROL_ROOT"] = str(_CONTROL)
# Hermetic suite defaults (production still uses repo .env / compose).
# Security tests monkeypatch auth_enabled=True explicitly.
os.environ["SANDBOX_AUTH_ENABLED"] = "false"
os.environ["SANDBOX_EXECUTION_TIMEOUT_SECONDS"] = "120"
os.environ["SANDBOX_MAX_OUTPUT_CHARS"] = "50000"
os.environ["SANDBOX_INTERNAL_PLANE_ENABLED"] = "false"
os.environ["SANDBOX_INTERNAL_REDIS_URL"] = ""
os.environ["SANDBOX_INTERNAL_HMAC_KEYRING"] = ""
os.environ["SANDBOX_INTERNAL_HMAC_ACTIVE_KID"] = ""
# Default allowlist includes loopback; pair with TestClient client=127.0.0.1 below.
os.environ.setdefault(
    "SANDBOX_ALLOWED_CLIENT_CIDRS",
    "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
)
os.environ.setdefault("SANDBOX_TRUSTED_PROXY_CIDRS", "")


def _force_hermetic_sandbox_env() -> None:
    os.environ["SANDBOX_DATABASE_URL"] = (
        "mysql+pymysql://sandbox@127.0.0.1:3306/pi_sandbox_unit_test"
    )
    os.environ["SANDBOX_WORKSPACES_ROOT"] = str(_WORKSPACES)
    os.environ["SANDBOX_TEMP_ROOT"] = str(_TEMPS)
    os.environ["SANDBOX_SKILLS_ROOT"] = str(_SKILLS)
    os.environ["SANDBOX_ARTIFACTS_ROOT"] = str(_ARTIFACTS)
    os.environ["SANDBOX_CONTROL_ROOT"] = str(_CONTROL)
    os.environ["SANDBOX_AUTH_ENABLED"] = "false"
    os.environ["SANDBOX_EXECUTION_TIMEOUT_SECONDS"] = "120"
    os.environ["SANDBOX_MAX_OUTPUT_CHARS"] = "50000"
    os.environ["SANDBOX_INTERNAL_PLANE_ENABLED"] = "false"
    os.environ["SANDBOX_INTERNAL_REDIS_URL"] = ""
    os.environ["SANDBOX_INTERNAL_HMAC_KEYRING"] = ""
    os.environ["SANDBOX_INTERNAL_HMAC_ACTIVE_KID"] = ""
    _WORKSPACES.mkdir(parents=True, exist_ok=True)
    _TEMPS.mkdir(parents=True, exist_ok=True)
    _SKILLS.mkdir(parents=True, exist_ok=True)
    _ARTIFACTS.mkdir(parents=True, exist_ok=True)
    _CONTROL.mkdir(parents=True, exist_ok=True)


def pytest_configure(config):  # noqa: ARG001
    """Re-assert hermetic env and ensure dirs exist early in the pytest lifecycle."""
    _force_hermetic_sandbox_env()

    # If Settings was already imported (e.g. plugin order), rebind the singleton
    # so suite defaults override a polluted repo .env — production config untouched.
    import sys

    if "sandbox.config" in sys.modules:
        from sandbox import config as sandbox_config

        sandbox_config.settings = sandbox_config.Settings()

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


# ── PR-07A session create helpers (formal AgentSession + workspace ids) ─

_CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"


def formal_id(kind: str = "X") -> str:
    """Return a unique 26-char Crockford Base32 formal id for tests.

    Uses cryptographic randomness so concurrent / cross-module suites never
    collide on formal agent_session_id or workspace_id values.
    """
    import secrets

    _ = kind  # retained for call-site readability
    return "".join(secrets.choice(_CROCKFORD) for _ in range(26))


def session_create_payload(caller_id: str = "test", **extra) -> dict:
    """Minimal valid POST /sessions body (AgentSession-bound workspace)."""
    payload = {
        "caller_id": caller_id,
        "agent_session_id": extra.pop("agent_session_id", formal_id("AGT")),
        "workspace_id": extra.pop("workspace_id", formal_id("WSP")),
    }
    payload.update(extra)
    return payload
