# ADR 0013: 共享 MySQL 库表按 UPspec《数据库设计规范》落标

| 字段 | 值 |
|---|---|
| 状态 | **Accepted / Implemented**（2026-09-23） |
| 日期 | 2026-09-23 |
| 决策所有者 | Agent runtime maintainers |
| 适用范围 | `agent/src/infrastructure/mysql/migrations/`、Agent 与 exec 的全部 SQL、`contract/schema/schema-manifest.json` |
| 关联文档 | [ADR 0011](0011-updrdb-upredis-dbpm-migration.md)（UPDRDB 迁移与手工 DDL 发布）、[部署说明「库表命名规范」](../deployment.md) |

---

## 背景

ADR 0011 D6 之后，生产 DDL 由 DBA 执行导出的发布包。目标环境的 UPSQL 有公司统一的
《数据库设计规范》（UPspec `参考文档/数据库设计规范.csv`），DBA 按它审查对象：

- 表 `tbl_<库缩写>_<业务名>`（≤128 字节），视图 `viw_…`；
- 索引 `ind_<库缩写>_<表名各词前几位>_(i|a)<序号>`（≤18 字节）；
- 字段一般 NOT NULL 且指定默认值；定长或 ≤16 的字符串用 `char`，更长的不定长用 `varchar`，小数用 `decimal`；
- 自增主键不作业务字段、默认 `bigint`；单表索引建议 ≤18 个。

2026-09-23 核对 42 张表（含 Knex 记账表）：表名均无前缀；181 个索引中 124 个超过 18 字节；
8 个 `varchar(16)` 状态/枚举列；316 个 NOT NULL 列没有默认值。字符集（utf8mb4 + InnoDB）、
单表索引数（最多 10）、自增主键（仅 `auth_credentials.id`，`bigint`）已符合。

## 决策

### D1 库缩写 `agsvc`，表名 `tbl_agsvc_<业务名>`

业务名保持原表名不变（已是简单英文单词），只加前缀，代码与文档仍可用业务名指代。

### D2 索引名 `ind_agsvc_<表缩写>_(a|i)<序号>`

表缩写取表名各词首字母（冲突或过短时取前几位，≤5 字符，全库唯一，映射见迁移文件
`INDEX_RENAMES`）。`a` 唯一、`i` 普通，按旧索引名字典序编号。外键依附的索引一并改名；
**外键约束名不改**——规范未约束，改名需逐个 DROP + ADD 外键。

### D3 字段约束

- `varchar(16)` 的状态/枚举列改 `char(16)`。
- NOT NULL 列补默认值：字符串 `''`、整数 `0`、时间 `'1970-01-01 00:00:00.000'`。
  UPSQL 5.7 的 `ALTER COLUMN … SET DEFAULT` 只接受字面量（`CURRENT_TIMESTAMP(3)` 真机报 1064），
  用 `SET DEFAULT` 只改元数据，不重建表。
- **以下列不设默认值，是有意的例外**：主键列；身份/租户/引用列（`*_id`、`*_subject`、`*_provider`）；
  操作者（`*_by`）；凭据与完整性（`*_hash`、`*_key`、`*_digest`、`sha256`、`checksum`、`username`）。
  给这些列默认 `''` 会让漏写的 `org_id` 或口令散列静默落库，违反 AGENTS.md §2 fail-closed；
  现在漏写时数据库以 strict 模式拒绝。JSON/TEXT 列 5.7 不允许默认值。
- 有业务语义的 NULL 保留（如 `expires_at IS NULL` 表示永不过期），不改为哨兵值。

### D4 前向迁移，不重写历史

新增 `20260923000001_upspec_naming.js`：一条原子 `RENAME TABLE` 改全部 40 张表，再每表一条
`ALTER TABLE`。历史迁移与针对它们的单测保持原样（它们描述的是当时建出的对象，孤儿闸门
`migrate-orphan-gate.ts` 也按这些旧名识别半途失败）。首装发布包因此会先建旧名再改名；
最终对象由 schema 清单与 `tests/test_schema_upspec_naming.py` 守住。

### D5 不改的对象

Knex 记账表 `knex_migrations` / `knex_migrations_lock`：由工具拥有，改名需同步 Knex 配置，
且已有库会被 Knex 视为从未迁移。触发器名：规范未约束，改名需 DROP + CREATE，其间 append-only 保护有空窗。

## 后果

- **破坏性升级**：新旧代码与新旧库互不兼容，已有库只能停写后执行增量发布包再部署，不能滚动发布。
- 字段落标（按大数据部「数据标准 / 词根」统一列名）本次未做：手头没有标准表，列名不变。
- 新表的 Knex 默认外键名（`<表>_<列>_foreign`）会带上前缀，注意 64 字符上限；新迁移应显式命名外键。
