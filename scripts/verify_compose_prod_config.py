#!/usr/bin/env python3
"""Verify security-critical invariants in rendered production Compose JSON."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

CANONICAL_SKILL_TARGET = "/home/sandbox/skill"
REMOVED_SKILL_TARGETS = frozenset({"/sandbox/skills", "/app/.pi/skills"})
MYSQL_SCHEMES = frozenset({"mysql", "mysql+pymysql", "mysql2"})


def _fail(message: str) -> None:
    raise SystemExit(f"production Compose verification failed: {message}")


def _verify_skill_mount(service_name: str, service: dict[str, Any]) -> None:
    volumes = service.get("volumes") or []
    if not isinstance(volumes, list):
        _fail(f"{service_name} volumes must be a list")
    targets = [
        volume.get("target")
        for volume in volumes
        if isinstance(volume, dict) and isinstance(volume.get("target"), str)
    ]
    forbidden = sorted(REMOVED_SKILL_TARGETS.intersection(targets))
    if forbidden:
        _fail(f"{service_name} retains compatibility Skill mounts: {forbidden}")
    canonical = [
        volume
        for volume in volumes
        if isinstance(volume, dict)
        and volume.get("target") == CANONICAL_SKILL_TARGET
    ]
    if len(canonical) != 1:
        _fail(
            f"{service_name} must mount Skills exactly once at "
            f"{CANONICAL_SKILL_TARGET}"
        )
    if canonical[0].get("read_only") is not True:
        _fail(f"{service_name} canonical Skill mount must be read-only")


def _environment(service_name: str, service: dict[str, Any]) -> dict[str, Any]:
    value = service.get("environment") or {}
    if not isinstance(value, dict):
        _fail(f"{service_name} environment must be a mapping")
    return value


def _require_mysql_dsn(service_name: str, environment: dict[str, Any]) -> None:
    """Ensure the rendered formal Sandbox DSN cannot select a legacy backend."""
    value = environment.get("SANDBOX_DATABASE_URL")
    if not isinstance(value, str) or "://" not in value:
        _fail(f"{service_name} must render a MySQL SANDBOX_DATABASE_URL")
    scheme = value.split("://", 1)[0].lower()
    if scheme not in MYSQL_SCHEMES:
        _fail(f"{service_name} SANDBOX_DATABASE_URL must use a MySQL scheme")


def _is_true(value: Any) -> bool:
    return value is True or (
        isinstance(value, str) and value.strip().lower() == "true"
    )


def verify(config: dict[str, Any]) -> None:
    services = config.get("services")
    if not isinstance(services, dict):
        _fail("services mapping is missing")

    published = sorted(
        name for name, service in services.items() if service.get("ports")
    )
    if published != ["nginx"]:
        _fail(f"host ports published by unexpected services: {published}")

    nginx_targets = {
        int(port["target"])
        for port in services["nginx"].get("ports", [])
        if isinstance(port, dict) and "target" in port
    }
    if nginx_targets != {80, 443}:
        _fail(f"nginx published targets must be exactly 80/443: {nginx_targets}")

    migrate = services.get("agent-migrate")
    if not isinstance(migrate, dict):
        _fail("agent-migrate service is missing")
    if set((migrate.get("depends_on") or {}).keys()) != {"mysql"}:
        _fail("agent-migrate must depend only on mysql")
    if migrate["depends_on"]["mysql"].get("condition") != "service_healthy":
        _fail("agent-migrate must wait for mysql health")
    if set((migrate.get("networks") or {}).keys()) != {"backend_internal"}:
        _fail("agent-migrate must use only backend_internal")
    if migrate.get("ports"):
        _fail("agent-migrate must not publish ports")
    if migrate.get("restart") != "no":
        _fail("agent-migrate must remain a one-shot service")

    for name in ("sandbox", "agent", "agent-worker"):
        service = services.get(name) or {}
        dependency = (service.get("depends_on") or {}).get("agent-migrate") or {}
        if dependency.get("condition") != "service_completed_successfully":
            _fail(f"{name} must wait for agent-migrate success")

    sandbox = services.get("sandbox")
    if not isinstance(sandbox, dict):
        _fail("sandbox service is missing")
    sandbox_environment = _environment("sandbox", sandbox)
    _require_mysql_dsn("sandbox", sandbox_environment)
    if not _is_true(sandbox_environment.get("SANDBOX_INTERNAL_PLANE_ENABLED")):
        _fail("sandbox internal plane must be enabled in production")
    if sandbox_environment.get("SANDBOX_SKILLS_ROOT") != CANONICAL_SKILL_TARGET:
        _fail("sandbox SANDBOX_SKILLS_ROOT must use the canonical Skill path")
    replay_url = sandbox_environment.get("SANDBOX_INTERNAL_REDIS_URL")
    if not isinstance(replay_url, str) or "sandbox-replay-redis:6379/0" not in replay_url:
        _fail("sandbox internal Redis must use the dedicated replay service DB0")

    # These services consume the shared env_file for convenience but must not
    # receive Sandbox persistence authority. In particular, an old host .env
    # SQLite value must not survive Compose rendering on Agent/BFF containers.
    for name in ("agent-migrate", "api-server", "agent", "agent-worker"):
        service = services.get(name)
        if isinstance(service, dict):
            if _environment(name, service).get("SANDBOX_DATABASE_URL") not in (
                None,
                "",
            ):
                _fail(f"{name} must not receive SANDBOX_DATABASE_URL authority")

    for name in ("agent", "agent-worker"):
        environment = _environment(name, services.get(name) or {})
        if environment.get("AGENT_MIGRATE_ON_START") != "false":
            _fail(f"{name} must disable runtime migration")
        if environment.get("SKILLS_ROOT") != CANONICAL_SKILL_TARGET:
            _fail(f"{name} SKILLS_ROOT must use the canonical Skill path")

    for name in ("agent", "agent-worker", "sandbox"):
        service = services.get(name)
        if not isinstance(service, dict):
            _fail(f"{name} service is missing")
        _verify_skill_mount(name, service)


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: verify_compose_prod_config.py <rendered-config.json>")
    path = Path(sys.argv[1])
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _fail(f"cannot read rendered JSON: {type(exc).__name__}")
    if not isinstance(config, dict):
        _fail("rendered config root must be an object")
    verify(config)
    print("production Compose verification passed")


if __name__ == "__main__":
    main()
