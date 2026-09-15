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
# Application services that fetch credentials from DBPM, and the connection
# URLs that must therefore carry no password (ADR 0011 D10).
APP_CREDENTIAL_URLS: dict[str, tuple[str, ...]] = {
    "agent": ("AGENT_DATABASE_URL", "AGENT_REDIS_URL", "REDIS_URL"),
    "agent-worker": ("AGENT_DATABASE_URL", "AGENT_REDIS_URL", "REDIS_URL"),
    "sandbox": ("SANDBOX_DATABASE_URL",),
    "sandbox-mcp": ("SANDBOX_MCP_REDIS_URL",),
}


def _embeds_password(value: Any) -> bool:
    if not isinstance(value, str) or "://" not in value:
        return False
    authority = value.split("://", 1)[1].split("/", 1)[0]
    if "@" not in authority:
        return False
    userinfo = authority.rsplit("@", 1)[0]
    return ":" in userinfo and userinfo.split(":", 1)[1] != ""


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

    # ADR 0011 D6: no service migrates. The DBA applies the exported schema
    # release; services only verify the live schema against the manifest.
    if "agent-migrate" in services:
        _fail("agent-migrate must not exist; schema is applied from the release by the DBA")
    for name, service in services.items():
        if "agent-migrate" in (service.get("depends_on") or {}):
            _fail(f"{name} must not depend on agent-migrate")


    sandbox = services.get("sandbox")
    if not isinstance(sandbox, dict):
        _fail("sandbox service is missing")
    sandbox_environment = _environment("sandbox", sandbox)
    _require_mysql_dsn("sandbox", sandbox_environment)
    if not _is_true(sandbox_environment.get("SANDBOX_INTERNAL_PLANE_ENABLED")):
        _fail("sandbox internal plane must be enabled in production")
    if sandbox_environment.get("SANDBOX_SKILLS_ROOT") != CANONICAL_SKILL_TARGET:
        _fail("sandbox SANDBOX_SKILLS_ROOT must use the canonical Skill path")
    # exec 内部面来源白名单：空值会拒绝全部内部面请求，放行全部等于没有这道闸。
    allow_cidr = str(sandbox_environment.get("EXEC_INTERNAL_ALLOW_CIDR") or "").strip()
    allow_entries = [entry.strip() for entry in allow_cidr.split(",") if entry.strip()]
    if not allow_entries:
        _fail("sandbox EXEC_INTERNAL_ALLOW_CIDR must be set in production")
    if any(entry.endswith("/0") for entry in allow_entries):
        _fail("sandbox EXEC_INTERNAL_ALLOW_CIDR must not allow every source (/0) in production")
    replay_url = sandbox_environment.get("SANDBOX_INTERNAL_REDIS_URL")
    if not isinstance(replay_url, str) or "sandbox-replay-redis:6379/0" not in replay_url:
        _fail("sandbox internal Redis must use the dedicated replay service DB0")

    # ADR 0011 D10: the development credential stub never renders in production.
    # Checked after the DSN scheme so a non-MySQL DSN is reported as such first.
    if "dbpm-fake" in services:
        _fail("dbpm-fake (development credential stub) must not render in production")
    for name, url_keys in APP_CREDENTIAL_URLS.items():
        environment = _environment(name, services.get(name) or {})
        dbpm_url = environment.get("DBPM_URL")
        if not isinstance(dbpm_url, str) or dbpm_url.strip() == "" or "dbpm-fake" in dbpm_url:
            _fail(f"{name} must fetch credentials from a real DBPM_URL")
        for key in url_keys:
            if _embeds_password(environment.get(key)):
                _fail(f"{name} {key} must not embed a password; credentials come from DBPM")

    # These services consume the shared env_file for convenience but must not
    # receive Sandbox persistence authority. In particular, an old host .env
    # SQLite value must not survive Compose rendering on Agent/BFF containers.
    for name in ("api-server", "agent", "agent-worker"):
        service = services.get(name)
        if isinstance(service, dict):
            if _environment(name, service).get("SANDBOX_DATABASE_URL") not in (
                None,
                "",
            ):
                _fail(f"{name} must not receive SANDBOX_DATABASE_URL authority")

    for name in ("agent", "agent-worker"):
        environment = _environment(name, services.get(name) or {})
        if "AGENT_MIGRATE_ON_START" in environment:
            _fail(f"{name} must not carry a runtime migration switch")
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
