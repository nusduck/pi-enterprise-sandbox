"""Fail-closed reset for this project's disposable development state."""

from __future__ import annotations

import argparse
import os
import re
import shutil
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


EXPECTED_PROJECT_ID = "pi-enterprise-sandbox"
EXPECTED_CONFIRMATION = f"RESET {EXPECTED_PROJECT_ID} DEVELOPMENT DATA"
_SAFE_DB_NAME = re.compile(r"^[A-Za-z0-9_-]+$")


class ResetRejected(RuntimeError):
    """Preflight rejected a destructive reset before any side effect."""


@dataclass(frozen=True)
class ResetConfig:
    deployment_env: str
    project_id: str
    confirmation: str
    allowed_root: Path
    database_url: str
    expected_database_name: str
    workspace_root: Path
    attachment_root: Path


@dataclass(frozen=True)
class ResetPlan:
    config: ResetConfig
    allowed_root: Path
    database_kind: str
    database_path: Path | None
    targets: tuple[Path, ...]


@dataclass(frozen=True)
class ResetResult:
    dry_run: bool
    targets: tuple[str, ...]
    deleted: tuple[str, ...]


def _within(child: Path, parent: Path, *, allow_equal: bool = False) -> Path:
    resolved = child.expanduser().resolve(strict=False)
    try:
        relative = resolved.relative_to(parent)
    except ValueError as exc:
        raise ResetRejected(f"target is outside allowed root: {resolved}") from exc
    if not allow_equal and relative == Path("."):
        raise ResetRejected(f"target must not equal allowed root: {resolved}")
    return resolved


def _sqlite_path(database_url: str) -> Path:
    parsed = urlparse(database_url)
    if parsed.scheme != "sqlite":
        raise ResetRejected("database URL is not SQLite")
    raw = parsed.path if parsed.path else database_url.removeprefix("sqlite:///")
    if not raw.strip() or raw.strip("/") == "":
        raise ResetRejected("SQLite database path is empty or root")
    return Path(raw)


def preflight(config: ResetConfig) -> ResetPlan:
    """Validate every guard and return an immutable, printable reset plan."""
    if config.deployment_env != "development":
        raise ResetRejected("DEPLOYMENT_ENV must be exactly 'development'")
    if config.project_id != EXPECTED_PROJECT_ID:
        raise ResetRejected(f"project id must be exactly '{EXPECTED_PROJECT_ID}'")
    if config.confirmation != EXPECTED_CONFIRMATION:
        raise ResetRejected(f"confirmation must be exactly '{EXPECTED_CONFIRMATION}'")

    allowed = config.allowed_root.expanduser().resolve(strict=False)
    if allowed == Path(allowed.anchor) or not allowed.is_dir():
        raise ResetRejected("allowed root must be an existing non-root directory")
    workspace = _within(config.workspace_root, allowed)
    attachments = _within(config.attachment_root, allowed)

    parsed = urlparse(config.database_url)
    if parsed.scheme == "sqlite":
        database_path = _within(_sqlite_path(config.database_url), allowed)
        targets = (
            database_path,
            Path(f"{database_path}-wal"),
            Path(f"{database_path}-shm"),
            workspace,
            attachments,
        )
        return ResetPlan(config, allowed, "sqlite", database_path, targets)

    if parsed.scheme in {"postgresql", "postgres"}:
        actual_name = parsed.path.lstrip("/")
        expected = config.expected_database_name
        if not expected or not _SAFE_DB_NAME.fullmatch(expected):
            raise ResetRejected("expected PostgreSQL database name is missing or unsafe")
        if actual_name != expected:
            raise ResetRejected(
                f"PostgreSQL database mismatch: expected '{expected}', got '{actual_name}'"
            )
        return ResetPlan(config, allowed, "postgresql", None, (workspace, attachments))

    raise ResetRejected("database URL must use sqlite, postgresql, or postgres")


def _clear_directory(path: Path, deleted: list[str]) -> None:
    if not path.exists():
        path.mkdir(parents=True, exist_ok=True)
        return
    if path.is_symlink() or not path.is_dir():
        raise ResetRejected(f"state root changed after preflight: {path}")
    for child in path.iterdir():
        if child.is_symlink() or child.is_file():
            child.unlink()
        else:
            shutil.rmtree(child)
        deleted.append(str(child))


def _reset_postgresql(database_url: str) -> None:
    import psycopg2

    conn = psycopg2.connect(database_url)
    try:
        with conn.cursor() as cursor:
            cursor.execute("DROP SCHEMA public CASCADE")
            cursor.execute("CREATE SCHEMA public")
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def execute_reset(plan: ResetPlan, *, dry_run: bool = False) -> ResetResult:
    """Execute a preflighted plan; dry-run never opens DB or mutates files."""
    target_labels = tuple(str(path) for path in plan.targets)
    if dry_run:
        return ResetResult(True, target_labels, ())

    # Re-run all guards immediately before the first side effect to catch
    # caller mistakes and path/symlink changes between planning and execution.
    verified = preflight(plan.config)
    if verified != plan:
        raise ResetRejected("reset plan changed after preflight")

    deleted: list[str] = []
    if plan.database_kind == "postgresql":
        _reset_postgresql(plan.config.database_url)
    else:
        assert plan.database_path is not None
        for path in (plan.database_path, Path(f"{plan.database_path}-wal"), Path(f"{plan.database_path}-shm")):
            if path.exists():
                if path.is_dir():
                    raise ResetRejected(f"database target unexpectedly became a directory: {path}")
                path.unlink()
                deleted.append(str(path))

    _clear_directory(plan.config.workspace_root.resolve(strict=False), deleted)
    _clear_directory(plan.config.attachment_root.resolve(strict=False), deleted)
    return ResetResult(False, target_labels, tuple(deleted))


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ResetRejected(f"{name} is required")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description="Irreversibly clear project development state")
    parser.add_argument("--confirm", required=True)
    parser.add_argument("--execute", action="store_true", help="Perform deletion; default is dry-run")
    args = parser.parse_args()
    try:
        config = ResetConfig(
            deployment_env=_required_env("DEPLOYMENT_ENV"),
            project_id=_required_env("PROJECT_ID"),
            confirmation=args.confirm,
            allowed_root=Path(_required_env("RESET_ALLOWED_ROOT")),
            database_url=_required_env("SANDBOX_DATABASE_URL"),
            expected_database_name=_required_env("RESET_DATABASE_NAME"),
            workspace_root=Path(_required_env("SANDBOX_WORKSPACES_ROOT")),
            attachment_root=Path(_required_env("SANDBOX_ATTACHMENTS_ROOT")),
        )
        result = execute_reset(preflight(config), dry_run=not args.execute)
    except (ResetRejected, OSError, RuntimeError) as exc:
        print(f"Reset rejected: {exc}")
        return 1
    print("DRY RUN" if result.dry_run else "RESET COMPLETE")
    for target in result.targets:
        print(f"- {target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
