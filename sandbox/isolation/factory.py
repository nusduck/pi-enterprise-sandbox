"""Isolation backend construction from central settings."""

from __future__ import annotations

from sandbox.config import Settings, settings
from sandbox.isolation.base import IsolationBackend
from sandbox.isolation.bubblewrap import BubblewrapIsolationBackend
from sandbox.isolation.direct import DirectIsolationBackend


def build_isolation_backend(config: Settings | None = None) -> IsolationBackend:
    cfg = config or settings
    name = str(cfg.isolation_backend or "direct").strip().lower()
    if name == "bubblewrap":
        return BubblewrapIsolationBackend(
            executable=cfg.bwrap_path,
            skills_root=cfg.skills_path,
            uid=cfg.bwrap_uid,
            gid=cfg.bwrap_gid,
        )
    if name == "direct":
        return DirectIsolationBackend()
    raise ValueError(f"Unknown isolation backend: {cfg.isolation_backend!r}")
