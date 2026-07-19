from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def _script(name: str) -> str:
    return (ROOT / "scripts" / name).read_text(encoding="utf-8")


def test_backup_and_restore_scripts_have_valid_shell_syntax() -> None:
    for name in ("backup.sh", "restore.sh"):
        subprocess.run(
            ["bash", "-n", str(ROOT / "scripts" / name)],
            check=True,
            capture_output=True,
            text=True,
        )


def test_backup_uses_only_formal_mysql_and_excludes_secrets() -> None:
    source = _script("backup.sh").lower()
    assert "mysqldump" in source
    assert "single-transaction" in source
    assert "sqlite" not in source
    assert "postgres" not in source
    assert "cp .env" not in source
    assert "runtime-files.tar.gz" in source
    for runtime_root in ("workspaces", "tmp", "artifacts", "control"):
        assert f"/var/sandbox/{runtime_root}" in source


def test_restore_is_guarded_and_targets_mysql() -> None:
    source = _script("restore.sh").lower()
    assert "restore_confirm" in source
    assert "mysql.sql.gz" in source
    assert "exec mysql" in source
    assert "sqlite" not in source
    assert "postgres" not in source
    assert "agent-migrate" in source
