"""共享 MySQL 的最终结构必须符合 UPspec《数据库设计规范》（库缩写 `agsvc`）。

依据是提交进仓库、由真实迁移生成的 `contract/schema/schema-manifest.json`
（Agent / Worker / exec 启动时按它核对目标库），不是迁移源码：规范约束的是 DBA
最终看到的对象。新增迁移若建出不合规的表、索引或列，重新生成清单后这里就会失败。

规则（`docs/deployment.md`「库表命名规范」一节有完整说明与例外理由）：

- 表名 `tbl_agsvc_<业务名>`，≤128 字节；Knex 自己的记账表除外。
- 索引名 `ind_agsvc_<表缩写>_(a|i)<序号>`，≤18 字节；`a` 必须是唯一索引、`i` 必须是
  普通索引；同一张表共用一个缩写，缩写全库不重复；单表索引 ≤18 个。
- 长度 ≤16 的字符串列用 `char`，不用 `varchar`。
- NOT NULL 列要有默认值。例外（漏写时由数据库拒绝，AGENTS.md §2 fail-closed）：主键列、
  身份/租户/引用列、操作者列、凭据与完整性列，以及 5.7 不允许默认值的 JSON/TEXT 列。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "contract" / "schema" / "schema-manifest.json"

TOOL_TABLES = frozenset({"knex_migrations", "knex_migrations_lock"})
TABLE_RE = re.compile(r"^tbl_agsvc_[a-z0-9_]+$")
INDEX_RE = re.compile(r"^ind_agsvc_(?P<abbr>[a-z0-9]{1,5})_(?P<kind>[ai])(?P<seq>[1-9][0-9]*)$")
NO_DEFAULT_OK = re.compile(
    r"(_id|_by|_hash|_key|_digest|_subject|_provider)$|^(sha256|checksum|username)$"
)
LOB_TYPES = ("json", "text", "mediumtext", "longtext", "blob", "longblob")


def _tables() -> dict[str, dict]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    return {name: t for name, t in manifest["tables"].items() if name not in TOOL_TABLES}


def test_table_names_follow_upspec() -> None:
    bad = [n for n in _tables() if not TABLE_RE.match(n) or len(n.encode()) > 128]
    assert not bad, f"table names must be tbl_agsvc_<name> (≤128 bytes): {bad}"


def test_index_names_follow_upspec() -> None:
    problems: list[str] = []
    owner_of_abbr: dict[str, str] = {}
    for table, spec in _tables().items():
        indexes = {k: v for k, v in spec["indexes"].items() if k != "PRIMARY"}
        if len(indexes) > 18:
            problems.append(f"{table}: {len(indexes)} indexes (>18)")
        abbrs: set[str] = set()
        for name, index in indexes.items():
            match = INDEX_RE.match(name)
            if match is None or len(name.encode()) > 18:
                problems.append(f"{table}.{name}: not ind_agsvc_<abbr>_(a|i)<n> within 18 bytes")
                continue
            if (match["kind"] == "a") != bool(index["unique"]):
                problems.append(f"{table}.{name}: 'a' marks unique and 'i' non-unique indexes")
            abbrs.add(match["abbr"])
        if len(abbrs) > 1:
            problems.append(f"{table}: mixed index abbreviations {sorted(abbrs)}")
        for abbr in abbrs:
            other = owner_of_abbr.setdefault(abbr, table)
            if other != table:
                problems.append(f"abbreviation {abbr!r} used by both {other} and {table}")
    assert not problems, "\n".join(problems)


def test_short_strings_use_char() -> None:
    bad = []
    for table, spec in _tables().items():
        for column, col in spec["columns"].items():
            match = re.fullmatch(r"varchar\((\d+)\)", col["type"])
            if match and int(match.group(1)) <= 16:
                bad.append(f"{table}.{column} {col['type']}")
    assert not bad, f"strings of length ≤16 must be char(n): {bad}"


def test_not_null_columns_have_defaults_or_a_documented_exemption() -> None:
    bad = []
    for table, spec in _tables().items():
        primary = set(spec["indexes"].get("PRIMARY", {}).get("columns", []))
        for column, col in spec["columns"].items():
            if col["nullable"] or col["default"] is not None:
                continue
            if column in primary or col["generation"] is not None:
                continue
            if "auto_increment" in col["extra"] or NO_DEFAULT_OK.search(column):
                continue
            if re.sub(r"\(.*", "", col["type"]) in LOB_TYPES:
                continue
            bad.append(f"{table}.{column} {col['type']}")
    assert not bad, f"NOT NULL columns need a DEFAULT (or an exemption documented here): {bad}"


def test_innodb_utf8mb4() -> None:
    bad = [
        n
        for n, t in _tables().items()
        if t["engine"] != "InnoDB" or not t["collation"].startswith("utf8mb4_")
    ]
    assert not bad, f"tables must be InnoDB + utf8mb4: {bad}"
