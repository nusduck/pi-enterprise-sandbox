"""Empty-database migration baseline contracts.

SQLite is the always-on CI empty-db baseline parity path: idempotent init,
checksum fail-closed, and failed-migration rollback. PostgreSQL production
semantics are identical via the shared ``apply_migrations`` runner; optional
live PostgreSQL tests run when ``TEST_POSTGRES_URL`` (or
``SANDBOX_TEST_DATABASE_URL`` with a postgresql scheme) is set.
"""

from __future__ import annotations

import os
import sqlite3
from pathlib import Path

import pytest

import sandbox.database as database_module
from sandbox.database import Database, Migration, MigrationChecksumError


def _postgres_url() -> str | None:
    for key in ("TEST_POSTGRES_URL", "SANDBOX_TEST_DATABASE_URL"):
        value = os.environ.get(key, "").strip()
        if value.startswith("postgresql://") or value.startswith("postgres://"):
            return value
    return None


POSTGRES_URL = _postgres_url()
requires_postgres = pytest.mark.skipif(
    POSTGRES_URL is None,
    reason="Set TEST_POSTGRES_URL for live PostgreSQL baseline parity tests",
)


def test_sqlite_empty_database_records_baseline_and_is_idempotent(tmp_path: Path) -> None:
    path = tmp_path / "sandbox.db"
    db = Database(f"sqlite:///{path}")

    db.initialize()
    db.initialize()

    with sqlite3.connect(path) as conn:
        rows = conn.execute(
            "SELECT version, checksum FROM schema_migrations ORDER BY version"
        ).fetchall()
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    assert rows == [(database_module.BASELINE_MIGRATION.version, database_module.BASELINE_MIGRATION.checksum)]
    assert user_count == 0


def test_applied_migration_checksum_mismatch_fails_closed(tmp_path: Path) -> None:
    path = tmp_path / "sandbox.db"
    db = Database(f"sqlite:///{path}")
    db.initialize()
    with sqlite3.connect(path) as conn:
        conn.execute("UPDATE schema_migrations SET checksum = 'tampered'")
        conn.commit()

    with pytest.raises(MigrationChecksumError):
        db.initialize()


def test_failed_migration_rolls_back_schema_and_version(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "sandbox.db"
    failing = Migration(
        version="0002_failure",
        sql="CREATE TABLE should_rollback (id TEXT PRIMARY KEY); INVALID SQL;",
    )
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        (database_module.BASELINE_MIGRATION, failing),
    )

    with pytest.raises(Exception):
        Database(f"sqlite:///{path}").initialize()

    with sqlite3.connect(path) as conn:
        tables = {
            row[0]
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
        }
    assert "should_rollback" not in tables
    assert "sessions" not in tables
    assert "schema_migrations" not in tables


def test_initialize_does_not_upgrade_legacy_partial_schema(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.execute("CREATE TABLE conversations (id TEXT PRIMARY KEY)")
        conn.commit()

    with pytest.raises(Exception):
        Database(f"sqlite:///{path}").initialize()

    with sqlite3.connect(path) as conn:
        columns = [row[1] for row in conn.execute("PRAGMA table_info(conversations)")]
    assert columns == ["id"]


@requires_postgres
def test_postgres_empty_database_reinit_is_noop() -> None:
    """Empty PostgreSQL re-init records baseline once and is a pure no-op thereafter."""
    assert POSTGRES_URL is not None
    db = Database(POSTGRES_URL)
    db.initialize()
    db.initialize()

    with db.connect() as conn:
        rows = conn.execute(
            "SELECT version, checksum FROM schema_migrations ORDER BY version"
        ).fetchall()
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()
    versions = [
        (
            str(database_module._row_value(row, "version")),
            str(database_module._row_value(row, "checksum")),
        )
        for row in rows
    ]
    assert versions == [
        (database_module.BASELINE_MIGRATION.version, database_module.BASELINE_MIGRATION.checksum)
    ]
    assert int(database_module._row_value(user_count, "count", 0)) == 0


@requires_postgres
def test_postgres_migration_checksum_mismatch_is_observable() -> None:
    assert POSTGRES_URL is not None
    db = Database(POSTGRES_URL)
    db.initialize()
    with db.connect() as conn:
        conn.execute(
            "UPDATE schema_migrations SET checksum = ? WHERE version = ?",
            ("tampered", database_module.BASELINE_MIGRATION.version),
        )
        conn.commit()

    with pytest.raises(MigrationChecksumError, match="checksum mismatch"):
        db.initialize()


@requires_postgres
def test_postgres_failed_migration_rolls_back_transaction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert POSTGRES_URL is not None
    failing = Migration(
        version="0002_failure",
        sql="CREATE TABLE should_rollback (id TEXT PRIMARY KEY); INVALID SQL;",
        pg_sql="CREATE TABLE should_rollback (id TEXT PRIMARY KEY); INVALID SQL;",
    )
    monkeypatch.setattr(
        database_module,
        "MIGRATIONS",
        (database_module.BASELINE_MIGRATION, failing),
    )

    # Use a fresh database name suffix path: wipe public schema via re-init on empty DB.
    # Drop application tables left by prior tests so failure path starts clean.
    db = Database(POSTGRES_URL)
    with db.connect() as conn:
        conn.execute("DROP SCHEMA public CASCADE")
        conn.execute("CREATE SCHEMA public")
        conn.commit()

    with pytest.raises(Exception):
        db.initialize()

    with db.connect() as conn:
        tables = {
            str(database_module._row_value(row, "table_name"))
            for row in conn.execute(
                """
                SELECT table_name FROM information_schema.tables
                WHERE table_schema = 'public'
                """
            ).fetchall()
        }
    assert "should_rollback" not in tables
    assert "sessions" not in tables
    assert "schema_migrations" not in tables
