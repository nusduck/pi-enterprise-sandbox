"""手工 DDL 流程的脚本棘轮（ADR 0011 D6，design §6.2）。

纯静态：不起容器、不连库。
- 开发建表脚本：语法有效、首个错误即停、不用 --force、执行后只读核对；
- 恢复脚本：恢复后不再自动迁移，改为只读核对；
- CLI 的四个子命令都已在 agent package.json 暴露。
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCHEMA_APPLY = ROOT / "scripts" / "dev" / "schema-apply.sh"
RESTORE = ROOT / "scripts" / "restore.sh"


def test_schema_apply_script_has_valid_shell_syntax() -> None:
    subprocess.run(["bash", "-n", str(SCHEMA_APPLY)], check=True, capture_output=True, text=True)
    # 文档直接写 `scripts/dev/schema-apply.sh`，没有可执行位就是 permission denied。
    assert SCHEMA_APPLY.stat().st_mode & 0o111, "schema-apply.sh must be executable"


def test_schema_apply_stops_on_first_error_and_verifies() -> None:
    source = SCHEMA_APPLY.read_text(encoding="utf-8")
    assert "set -euo pipefail" in source
    assert "--force" not in source.replace("不使用 --force", "")
    assert "cli-schema.js" in source and ' sql --out ' in source and ' verify' in source
    # 只有空库才执行首装包，非空库只核对。
    assert "TABLE_SCHEMA='${DB}'" in source
    # 口令单独传，不拼进 URL。
    assert "SCHEMA_VERIFY_PASSWORD=" in source and "SCHEMA_SHADOW_PASSWORD=" in source


def test_restore_verifies_schema_instead_of_migrating() -> None:
    source = RESTORE.read_text(encoding="utf-8")
    assert "agent-migrate" not in source
    assert "cli-schema.js" in source and " verify" in source


def test_schema_cli_is_exposed() -> None:
    scripts = json.loads((ROOT / "agent" / "package.json").read_text(encoding="utf-8"))["scripts"]
    for name in ("schema:manifest", "schema:sql", "schema:replay", "schema:verify"):
        assert name in scripts, name
