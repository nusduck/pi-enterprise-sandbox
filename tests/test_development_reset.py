"""Fail-closed tests for the irreversible development reset."""

from __future__ import annotations

from pathlib import Path

import pytest

from sandbox.development_reset import (
    EXPECTED_CONFIRMATION,
    EXPECTED_PROJECT_ID,
    ResetConfig,
    ResetRejected,
    execute_reset,
    preflight,
)


def _config(tmp_path: Path, **overrides: object) -> ResetConfig:
    allowed = tmp_path / "project-state"
    data = allowed / "data"
    workspace = allowed / "workspaces"
    attachments = allowed / "attachments"
    for path in (data, workspace, attachments):
        path.mkdir(parents=True, exist_ok=True)
    values: dict[str, object] = {
        "deployment_env": "development",
        "project_id": EXPECTED_PROJECT_ID,
        "confirmation": EXPECTED_CONFIRMATION,
        "allowed_root": allowed,
        "database_url": f"sqlite:///{data / 'sandbox.db'}",
        "expected_database_name": "sandbox",
        "workspace_root": workspace,
        "attachment_root": attachments,
    }
    values.update(overrides)
    return ResetConfig(**values)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("deployment_env", "production"),
        ("project_id", "another-project"),
        ("confirmation", "yes"),
    ],
)
def test_preflight_rejects_wrong_environment_identity_or_confirmation(
    tmp_path: Path, field: str, value: str
) -> None:
    sentinel = tmp_path / "sentinel"
    sentinel.write_text("keep", encoding="utf-8")
    with pytest.raises(ResetRejected):
        preflight(_config(tmp_path, **{field: value}))
    assert sentinel.read_text(encoding="utf-8") == "keep"


def test_preflight_rejects_root_and_out_of_scope_targets(tmp_path: Path) -> None:
    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(ResetRejected):
        preflight(_config(tmp_path, workspace_root=outside))
    with pytest.raises(ResetRejected):
        preflight(_config(tmp_path, allowed_root=Path("/")))


def test_dry_run_lists_targets_without_deleting(tmp_path: Path) -> None:
    config = _config(tmp_path)
    db_path = Path(config.database_url.removeprefix("sqlite:///"))
    db_path.write_text("db", encoding="utf-8")
    (config.workspace_root / "keep.txt").write_text("workspace", encoding="utf-8")

    result = execute_reset(preflight(config), dry_run=True)

    assert result.deleted == ()
    assert db_path.exists()
    assert (config.workspace_root / "keep.txt").exists()


def test_sqlite_reset_clears_only_declared_project_state(tmp_path: Path) -> None:
    config = _config(tmp_path)
    db_path = Path(config.database_url.removeprefix("sqlite:///"))
    for path in (db_path, Path(f"{db_path}-wal"), Path(f"{db_path}-shm")):
        path.write_text("db", encoding="utf-8")
    (config.workspace_root / "conversation").mkdir()
    (config.workspace_root / "conversation" / "a.txt").write_text("a", encoding="utf-8")
    (config.attachment_root / "upload.bin").write_text("a", encoding="utf-8")
    outside = tmp_path / "outside.txt"
    outside.write_text("keep", encoding="utf-8")

    result = execute_reset(preflight(config))

    assert not db_path.exists()
    assert list(config.workspace_root.iterdir()) == []
    assert list(config.attachment_root.iterdir()) == []
    assert outside.read_text(encoding="utf-8") == "keep"
    assert result.deleted
