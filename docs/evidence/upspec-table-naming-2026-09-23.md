# UPspec 库表命名落标验证（2026-09-23）

对应 [ADR 0013](../adr/0013-upspec-table-naming.md)、迁移 `20260923000001_upspec_naming.js`。
代码版本：`refactor/updrdb-dbpm` @ `b589bfd6` + 未提交改动；Node 22.23.2（容器）、MySQL 5.7.44、Redis 5.0.14。

## 一、规范核对（改前）

来源 UPspec `参考文档/数据库设计规范.csv`（GB18030）。42 张表：无 `tbl_` 前缀 42；索引 181 个中 124 个超过 18 字节；
`varchar(16)` 8 列；无默认值的 NOT NULL 列 316。已合规：InnoDB + utf8mb4、单表索引 ≤10、自增主键 `bigint`。

## 二、语法探针（mysql:5.7 真机）

| 语句 | 结果 |
|---|---|
| `ALTER TABLE … RENAME INDEX <外键依附索引> TO …` | 通过；外键约束名不变 |
| `RENAME TABLE`（表上有触发器与被引用外键） | 通过；触发器与外键随表迁移 |
| `ALTER COLUMN … SET DEFAULT '1970-01-01 00:00:00.000'` | 通过 |
| `ALTER COLUMN … SET DEFAULT CURRENT_TIMESTAMP(3)` | **1064**，故时间列用字面量哨兵 |

## 三、迁移与清单

- 一次性库上 `migrate latest → rollback（整批 28 个）→ latest` 全部通过。
- 空影子库重新生成 `contract/schema/schema-manifest.json`：28 个迁移、42 张表、4 个触发器。
- 改后：表改名 40、索引改名 139、`char(16)` 8、补默认值 121；有意不设默认值的列见 ADR 0013 D3。
- `tests/test_schema_upspec_naming.py`：新清单 5/5 通过；放到改前清单上 4/5 失败（回归对照）。

## 四、离线测试（容器内，`TEST_MYSQL_URL` + `TEST_REDIS_URL` 指向隔离的 mysql:5.7 / redis:5.0.14）

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 224 passed |
| `npm test --prefix contract` | 118 / 118 |
| `npm test --prefix exec` | 415 pass / 5 fail / 5 skip；4 条是容器内无 bwrap 的环境失败，改前基线同样失败；另 1 条 schema-verify 要求库已迁移，迁移后重跑 2/2 通过 |
| `npm test --prefix agent` | 1432 pass / 0 fail / 27 cancelled。cancelled 是多个集成测试文件并发共用同一个库（rollback-all 与迁移互相干扰），改前基线同样如此；16 个集成 / release-gate 文件逐个串行运行全部通过 |
| `npm test --prefix api-server` | 165 / 165 |
| `npm test --prefix frontend` / `npm run build --prefix frontend` | 通过 / 通过 |
| 类型检查 | agent（主程序 + runtime strict）、exec、contract、api-server 全部通过 |

## 五、DBA 流程演练（开发库，存量数据 142 条 Run）

1. mysqldump 备份后停 `agent` / `agent-worker` / `sandbox`。
2. 空影子库导出增量发布包 `--from 20260912000001_claim_without_skip_locked.js`：1 段、41 条语句。
3. root 用 mysql 客户端执行（无 `--force`），耗时约 1.1 s；`knex_migrations` 末条为 `20260923000001_upspec_naming.js`。
4. 应用账号 `schema:verify`：`drifts: []`。

## 六、真实链路（重建镜像后）

`docker compose build agent agent-worker api-server sandbox sandbox-mcp`（sandbox 首次构建遇 Debian 镜像 502，重试成功）→
`up -d`，五个服务均为新容器并通过启动时的 schema 核对。经 BFF：

| 项 | 结果 |
|---|---|
| 登录、建会话、带工具 Run | Run `SUCCEEDED`；账本 `bash`×2、`job_output` 均 `SUCCEEDED`，`request_hash_version=1`、`execution_fence_token=1` |
| 后台进程 logs / SIGTERM | logs 读到 `tick …`；SIGTERM 后 `tbl_agsvc_exec_jobs.status=killed` |
| 跨租户 | runs、runs/tools、conversations、processes 四项 B=404、A=200 |

链路脚本第 6 项判定写成大写 `SUCCEEDED`，API 返回小写，因此计为失败（14/15）；账本行已在库里核实成功。

## 七、未覆盖

- 目标 UPDRDB 实例上未执行本迁移；只在 mysql:5.7 上验证。
- 首装发布包会先按旧名建表再改名（ADR 0013 D4），未另做合并基线。
- 字段落标（数据标准 / 词根）未做。
