"""Process-wide isolation preflight state exposed through readiness."""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

from sandbox.config import Settings, settings
from sandbox.isolation.factory import build_isolation_backend

logger = logging.getLogger("sandbox.isolation")

ISOLATION_POLICY_VERSION = "bwrap-v2"


@dataclass(frozen=True)
class IsolationStatusSnapshot:
    backend: str
    required: bool
    checked: bool
    passed: bool
    policy_version: str


class IsolationPreflightState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._snapshot = IsolationStatusSnapshot(
            backend="unknown",
            required=False,
            checked=False,
            passed=False,
            policy_version=ISOLATION_POLICY_VERSION,
        )

    def check(self, config: Settings | None = None) -> IsolationStatusSnapshot:
        cfg = config or settings
        backend = build_isolation_backend(cfg)
        try:
            backend.preflight()
        except Exception:
            snapshot = IsolationStatusSnapshot(
                backend=backend.name,
                required=bool(cfg.isolation_required),
                checked=True,
                passed=False,
                policy_version=ISOLATION_POLICY_VERSION,
            )
            with self._lock:
                self._snapshot = snapshot
            if cfg.isolation_required:
                logger.exception("Required isolation preflight failed")
                raise
            logger.warning("Optional isolation preflight failed", exc_info=True)
            return snapshot

        snapshot = IsolationStatusSnapshot(
            backend=backend.name,
            required=bool(cfg.isolation_required),
            checked=True,
            passed=True,
            policy_version=ISOLATION_POLICY_VERSION,
        )
        with self._lock:
            self._snapshot = snapshot
        logger.info(
            "Isolation preflight passed (backend=%s policy=%s)",
            backend.name,
            ISOLATION_POLICY_VERSION,
        )
        return snapshot

    def snapshot(self) -> IsolationStatusSnapshot:
        with self._lock:
            return self._snapshot


isolation_preflight = IsolationPreflightState()
