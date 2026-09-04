"""exec 生产装配里接的每一张 MySQL 表，都必须有 agent 侧的迁移。

`exec/` 拥有工作区字节与产物快照，但**共享 MySQL 的建表权威在 `agent/`**
（AGENTS.md §1、`docs/design/dsh-rebuild.md §6`）。这条边界有一个安静的失败
模式：仓储类和 DDL 常量写在 `exec/src/db/repositories/` 里，看起来"做完了"，
但只要没人写迁移、也没人在 `createExecAppFromEnv` 里把它接上，服务就会落回
构造函数默认的内存实现——单测全绿，容器一重启数据整片消失。

2026-09-04 就是这样：`MySqlArtifactStore` / `MySqlDatasetStore` 早就写好，
`exec_artifacts` / `exec_datasets` 却从来没有迁移，生产上 `ArtifactService`
一直跑在 `InMemoryArtifactStore` 上，`GET /api/artifacts` 在每次重启后返回空
列表。这条守卫把"接了就必须能建表"钉死：不跑 MySQL，只读源码。

注意方向：它只要求**已接线**的表有迁移。仓储层里还有几张只有 DDL、没有任何
消费者的表（`exec_workspaces` / `exec_executions` / `session_events` /
`workspace_quota_reservations`），那是尚未落地的设计，不在本守卫范围内——
它们一旦被接进 `createExecAppFromEnv`，这条测试就会立刻要求补迁移。
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXEC_WIRING = ROOT / "exec" / "src" / "http" / "app.ts"
EXEC_SRC = ROOT / "exec" / "src"
MIGRATIONS_DIR = ROOT / "agent" / "src" / "infrastructure" / "mysql" / "migrations"

WIRED_STORE_RE = re.compile(r"new\s+(MySql\w*Store)\s*\(")
CLASS_RE = "class\\s+{cls}\\b"
TABLE_DEFAULT_RE = re.compile(r"table\s*:\s*string\s*=\s*(?:'([a-z_][a-z0-9_]*)'|(\w+))")


def _exec_sources() -> list[Path]:
    return sorted(p for p in EXEC_SRC.rglob("*.ts") if "node_modules" not in p.parts)


def _default_table_for(store_class: str) -> str:
    """从仓储类的构造函数里取默认表名（字面量或同文件的常量）。"""
    pattern = re.compile(CLASS_RE.format(cls=re.escape(store_class)))
    for path in _exec_sources():
        text = path.read_text(encoding="utf-8")
        match = pattern.search(text)
        if match is None:
            continue
        tail = text[match.end() : match.end() + 1200]
        default = TABLE_DEFAULT_RE.search(tail)
        assert default is not None, f"{store_class} has no default table name in {path}"
        literal, identifier = default.group(1), default.group(2)
        if literal:
            return literal
        const = re.search(
            rf"{re.escape(identifier)}\s*=\s*'([a-z_][a-z0-9_]*)'", text
        )
        assert const is not None, (
            f"{store_class} default table {identifier} is not a string constant in {path}"
        )
        return const.group(1)
    raise AssertionError(f"cannot locate class {store_class} under exec/src")


def _migrated_tables() -> str:
    return "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted(MIGRATIONS_DIR.glob("*.js"))
    )


def test_wired_exec_stores_have_migrations() -> None:
    wiring = EXEC_WIRING.read_text(encoding="utf-8")
    stores = sorted(set(WIRED_STORE_RE.findall(wiring)))
    assert stores, "expected createExecAppFromEnv to wire at least one MySQL store"

    migrations = _migrated_tables()
    missing: list[str] = []
    for store_class in stores:
        table = _default_table_for(store_class)
        if not re.search(rf"['\"]{re.escape(table)}['\"]", migrations):
            missing.append(f"{store_class} -> {table}")

    assert not missing, (
        "exec wires MySQL stores whose tables have no agent migration: "
        + ", ".join(missing)
        + " — add one under agent/src/infrastructure/mysql/migrations/"
    )


def test_artifact_and_dataset_stores_stay_wired() -> None:
    """产物/数据集/配额是用户可见的那条线，退回内存实现不能再悄悄发生。"""
    wiring = EXEC_WIRING.read_text(encoding="utf-8")
    for store_class in (
        "MySqlArtifactStore",
        "MySqlDatasetStore",
        "MySqlJobStore",
        "MySqlQuotaStore",
    ):
        assert f"new {store_class}(" in wiring, (
            f"{store_class} is no longer wired in createExecAppFromEnv; "
            "the service would silently fall back to its in-memory default"
        )
