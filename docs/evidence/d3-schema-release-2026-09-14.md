# D3 验证记录：手工 DDL 发布包 + 三进程启动 schema 核对 + 删除自动迁移

日期：2026-09-14。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §6 与 ADR 0011 D6。
用户决定：**开发 Compose 也去掉自动迁移**，与生产同一流程。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`0392d0e3` + 本次未提交改动（随本证据同一 commit） |
| 数据库 | `mysql:5.7.44`（卷 `mysql57_dev_data`，宿主端口 3307）；对照用临时 `mysql:8.0` 容器（tmpfs，端口 3308，未挂任何卷） |
| 镜像（最终重建，容器已确认换新） | `pi-enterprise-agent` `9305aecce457`（agent / agent-worker）、`enterprise-sandbox` `2ac763f6b49a`（sandbox / sandbox-mcp） |
| 运行栈 | 开发 compose + `scripts/dev/docker-compose.updrdb-sim.yml`（dbpm-fake + 双 Proxy） |
| 运行时 | 容器内 Node 22；宿主 Node v23.11.0；uv Python 3.11.12；Knex 3.3.0 / mysql2 3.15.3 |

## 改了什么

- `contract/src/schema-manifest.ts`：元数据查询 SQL、「元数据 → 清单」归一化、清单比对与 `SchemaDriftError`（纯函数，Agent / exec 共用）。
- `contract/schema/schema-manifest.json`：由 `schema:manifest` 在空影子库跑完 27 个迁移后从真实 `information_schema` 生成（42 表、4 触发器），**提交进仓库**作为随镜像分发的规范。
- Agent：`schema-verify.ts`（Knex 执行查询）、`schema-export.ts` / `schema-release-info.ts`（捕获迁移语句、按迁移分段写发布包、重放）、`cli-schema.ts`（`schema:manifest|sql|replay|verify`）。容器启动在 MySQL 连接后、Redis 之前核对；http / worker 入口不再读 `AGENT_MIGRATE_ON_START`。
- exec：`db/schema-verify.ts`；`ExecRuntime.verifySchema()`，入口在孤儿回收之前调用；`dispose()` 改用尽力而为的 `closeExecDbPool()`。
- Compose：开发与生产都删除 `agent-migrate` 服务、依赖与 `AGENT_MIGRATE_ON_START`；`scripts/dev/schema-apply.sh` 充当开发「DBA」。
- `scripts/restore.sh` 恢复后只读核对不迁移；`scripts/verify_compose_prod_config.py` 改为拒绝迁移服务回归、拒绝生产渲染出 `dbpm-fake`、要求真实 `DBPM_URL`、拒绝应用连接串夹口令。
- 文档：deployment（Schema 发布、变量）、development、README、部分迁移恢复 runbook、design §6 与 ADR D6 细化、CHANGELOG。

## 清单跨版本核对（5.7 生成 / 8.0 对照）

同一批迁移在 8.0 上建库后用 5.7 生成的清单核对，最初 78 条差异：77 条是外键动作表示（5.7 `RESTRICT` / 8.0 `NO ACTION`，InnoDB 语义相同），1 条是 `knex_migrations.migration_time`（5.7 `explicit_defaults_for_timestamp=OFF` 给首个 TIMESTAMP 列自动加默认值与 on update）。归一化 `NO ACTION`→`RESTRICT`，Knex 记账表只核对存在（业务表无 `timestamp` 列，全部为 `datetime(3)`）后：**8.0 零差异，5.7 运行中库零差异**。整数显示宽度与 `DEFAULT_GENERATED` 的差异由单测覆盖。

## 离线测试（宿主机，仓库根）

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 123 passed（新增 `test_schema_release_scripts.py`，更新端口安全 / 备份恢复 / DBPM compose 棘轮） |
| `npm test --prefix exec` | 369 tests / 368 pass / 1 skipped / 0 fail |
| `npm test --prefix contract` | 97 pass / 0 fail |
| `npm test --prefix agent` | 1290 tests / 1287 pass / 0 fail / **3 cancelled** |
| `npm test --prefix api-server` | 159 tests / 157 pass / 0 fail / **2 cancelled** |
| `npm test --prefix frontend` / build | 367 pass / built |

类型检查：exec、contract、agent（主程序 + strict runtime）、api-server 均通过。开发、双 Proxy 模拟、生产 overlay 渲染通过；生产渲染（CI 同款占位变量）经 `verify_compose_prod_config.py` 通过，渲染结果不含 `agent-migrate` / `dbpm-fake`。
5 个 cancelled 与 [D2b 证据](d2b-updrdb-failover-2026-09-14.md) 记录相同，未记为通过。

中途发现并修正：`agent/src` 的 Map 白名单棘轮拦下导出器里的 `new Map`（改为数组）；exec 测试 `dispose()` 关池时把未建成连接的错误再抛一次（改用 `closeExecDbPool` + 核对查询改为逐条执行）；`schema-apply.sh` 缺可执行位（补上并加棘轮）；`cli-schema` 默认清单路径在 dist 下多一层（改为经 contract 包定位）。

## Live 集成（MySQL 5.7.44，专用库）

- Agent **37 pass**（`pi_d2c_it` + `pi_schema_shadow` / `pi_schema_replay`）：failover / mysql / outbox / cron / **schema-manifest**（新迁移库与清单完全一致；删 append-only 触发器、删后加列与索引、多出未知表、少一条迁移记录都被报出）/ **schema-export**（首装导出→空库重放零差异；从倒数第二个迁移增量导出→基线库重放零差异；中途插入坏语句时首个错误即停、失败段与后续段都不记账；影子库非空拒绝导出）。
- exec **31 pass**：含 schema 核对（元数据视图为空=漂移不是通过；真库上多出 `exec_jobs` 列被点名报出）。

## Docker 演练（真实容器栈）

新建空库 `pi_d3_app`，把 agent / agent-worker / sandbox 的 DSN 临时指过去（不动 `sandbox` 库）：

| 场景 | 结果 |
|---|---|
| 空库直接 up | sandbox 反复重启，`exec schema verification failed, refusing to start: … migrations knex_migrations, missing_table a2a_api_credentials, …`；agent / worker / mcp 因依赖 sandbox healthy 停在 created |
| `scripts/dev/schema-apply.sh pi_d3_app` | 用 agent 镜像在 `pi_schema_shadow` 导出 27 段 + 记账段；mysql 客户端逐段执行 28 个文件全部成功；只读核对 `{"ok": true, "drifts": []}` |
| 建表后 | sandbox 下一次重启通过核对变 healthy；再 `up -d` 后 agent healthy、worker `BullMQ consumer started`、mcp healthy |
| 真实链路 | 登录 → 建会话 → 带工具 Run `SUCCEEDED`（`bash:succeeded`）→ 进程 logs / SIGTERM → B 访问 A 的 run / conversation / tools / process 全 404、A 全 200 |
| append-only | 应用账号 `UPDATE messages` 与 `DELETE FROM messages` 均 `ERROR 1644: messages is append-only: … is forbidden`（15 行消息） |
| 删 `trg_messages_forbid_delete` 后重启三进程 | **三者都拒绝启动**：`agent-http: … missing_trigger trg_messages_forbid_delete`、`agent-worker: …` 同、`exec: …` 同（各重启 9–10 次） |
| 恢复触发器后重启 | 三进程恢复（agent healthy、worker consumer started），`schema:verify` 零差异，DELETE 再次被触发器拒绝 |
| 最终镜像复验 | 重建 agent 镜像后在新空库 `pi_d3_app2` 重跑 `schema-apply.sh`：27 段 + 记账段执行成功、零差异；agent / worker 换新镜像后在 `sandbox` 库上 healthy |
| 收尾 | 栈切回 `sandbox` 库，全部服务 healthy |

## 观察到但未定位

- 演练链路中后台进程 SIGTERM 后 3 秒检查时状态为 `cancel_requested`，稍后收敛为 `killed`；此前几次链路检查时已是 `cancelled`。与 schema 改动无关，未深究状态命名差异。
- 空库上 `docker compose up` 会因 agent 依赖 sandbox healthy 而整体返回非零；建表后需再执行一次 `up -d`（开发文档与脚本提示已写明）。

## 未做 / 边界

- 生产最小权限账号能否读 `information_schema.TRIGGERS` 正文未验证（本地应用账号是库级 ALL）；读不到会拒启，需 DBA 确认或提供只读视图。
- DBA 真实环境（UPDRDB）上执行发布包、`log_bin_trust_function_creators` 等实例参数未验证。
- 发布包 SQL 本身不提交；增量导出只适用于声明的基线（迁移里 `auth_credentials` 的 `hasTable` 按状态分支）。
- 两个 release-gate、CI smoke 未在本机实跑（环境依赖，同 D2c）。
- 本地演练留下的测试库 `pi_d3_app`、`pi_d3_app2`、`pi_schema_shadow`、`pi_schema_replay`、`pi_d2c_it` 与临时 8.0 容器 `pi-d3-mysql80` 未清理。
