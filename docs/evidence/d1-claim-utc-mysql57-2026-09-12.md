# D1 验证记录：抢占改造 + 会话 UTC + MySQL 5.7 开发基线

日期：2026-09-12。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §5 / §4.3 / §10 的 D1 阶段，
关闭 [复审](../reviews/2026-09-12-dbpm-topology-review/README.md) R3、R5 的实现侧要求（R5 的回退点验证见下方“遗留”）。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`57b9b6a1` + 本次未提交改动 |
| 数据库 | `mysql:5.7.44`（compose，`platform: linux/amd64`，Apple Silicon 上模拟运行），**新卷 `mysql57_dev_data`** |
| Redis | `redis:7.2`（UPRedis 降级属 D4，本轮不动） |
| 镜像 | `pi-enterprise-agent:latest` `ef85933938dd`、`enterprise-sandbox:latest` `6c7de8f559e7`（本轮重建）；`pi-enterprise-api:latest` `1345b6dd6862` 未变（api-server 无源码改动，构建命中缓存） |
| 运行时 | 容器内 Node 22（`runtime-versions.json`）；**宿主 Node v26.5.0**、Python 3.11.15 |
| Knex / mysql2 | 3.3.0 / 3.15.3（lockfile 实际锁定值） |

## 改了什么

- `domain_outbox`、`cron_jobs` 的批量抢占去掉 `SELECT … FOR UPDATE SKIP LOCKED`，
  改为「带 eligibility 的条件 `UPDATE` 打批次 token → 同事务按 token 回读」。
- 新迁移 `20260912000001_claim_without_skip_locked`：`cron_jobs.claim_token CHAR(26)` 可空列 +
  两张表的**非唯一** claim_token 回读索引。
- `CronJobService.claimDue()` 在同一事务内完成抢占、执行记录、调度推进、逐行清空 token，
  commit 前校验无残留；token 独占后仍出现相同 `(job, scheduled_at)` 视为数据不一致，回滚并诊断。
- 三个连接点统一 UTC 会话初始化：Agent knex 走 `pool.afterCreate`（knex `promisify` 等待回调，
  失败即建连失败）；Agent DSH 裸池与 exec 裸池在 mysql2 `connection` 事件里发 `SET SESSION`，
  **失败销毁连接**，不做只记日志的监听器。
- Compose 开发数据库切 `mysql:5.7` + 新卷；CI service、`.env.example`、`deployment.md`、
  `development.md`、卫生测试同步。

## 离线测试

六套（仓库根，宿主机执行）：

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 104 passed |
| `npm test --prefix exec` | 349 tests / 348 pass / 0 fail |
| `npm test --prefix contract` | 50 pass / 0 fail |
| `npm test --prefix agent` | 1259 pass / 0 fail |
| `npm test --prefix api-server` | 159 pass / 0 fail |
| `npm test --prefix frontend` | 367 pass / 0 fail |
| `npm run build --prefix frontend` | built |

类型检查：`exec`、`contract`、`api-server`、`agent`（主程序 + `src/runtime` strict）四项均无输出（通过）。
`docker compose config` 通过。

## 真机验证（MySQL 5.7.44）

Live 集成（`TEST_MYSQL_URL` + `TEST_REDIS_URL`，`--test-concurrency=1`）：**21 pass / 0 fail**，含
`mysql.integration`（全量 migrate down→up、外键、append-only 触发器、同键并发 CreateRun）、
`outbox.integration`、新增 `cron/cron-claim.integration`。

> 并发文件必须串行跑：`mysql.integration` 的 `before` 会 `migrateRollbackAll`，
> 与其它 live 文件并行会互相拆表。这是既有测试隔离问题，非本次改动引入。

重叠事务证据（新增用例，真两个连接）：

- Outbox：A 在事务内抢占后未提交，B 进入同一竞争区，500ms 内**未返回**（被行锁挡住）；
  A 提交后 B 拿到 0 行，`attempts` 只加一次。
- Cron：同上；A 回滚后 B 才抢到该行，且只产生一条执行记录。
- 锁等待超时可分类：B 设 `innodb_lock_wait_timeout=1` 时以 errno **1205** 失败，不是静默空批次。

**旧实现对照**（脚本对照，未进仓库）：同样场景下旧的
`SELECT … FOR UPDATE SKIP LOCKED` 让 B 在 **4ms** 内返回 0 行、完全不等锁 —— 新用例的
「A 未提交前 B 必须仍被挡住」断言在旧实现上必然失败。5.7 服务端直接以
`ERROR 1064` 拒绝 `SKIP LOCKED` 语法。

会话时区：本地 5.7 的 `@@global.time_zone` = `SYSTEM`；改动前连接的会话时区就是 `SYSTEM`，
改动后 `performance_schema` 显示运行中的 5 条 `sandbox` 连接全部为 `+00:00`。

真实链路（重建镜像后的容器栈，BFF `127.0.0.1:4000`）：

1. 注册 → `/api/auth/me` 返回该用户；
2. `POST /api/runs` 建会话与 Run → `SUCCEEDED`，工具台账 1 条 `bash` `succeeded`；
3. 第二个 Run 起长进程 → `GET /api/processes` 列出 `running`；游标读 logs 拿到 `tick-1…tick-24`；
   `POST …/signal` SIGTERM 后状态转 `cancelled`；
4. 跨租户：另一用户访问 A 的 run / conversation / tools / process 全部 **404**，
   A 自己同样四个入口中的 run、conversation 返回 200（拒绝有正对照）。
5. Worker 真实抢占结果：`domain_outbox` 2484 行全部 `PUBLISHED`，
   `claim_token IS NOT NULL` 的残留行 **0**；worker 日志无错误。

## 环境陷阱（撞到了，记录以免重复）

- **`.env` 里显式设过 `MYSQL_DATA_VOLUME=mysql_dev_data`会盖掉 compose 默认值**，
  于是 5.7 起在了 8.0 的数据目录上，直接崩在
  `InnoDB: Table flags are 0 in the data dictionary but the flags in file ./ibdata1 are 0x4800`。
  这正是 R5 预警的场景：换镜像必须同时核对**实际解析到的卷**，不能只看 compose 默认值。
- 该次失败启动在旧 8.0 卷里留下了 5.7 建的 `ib_logfile0` / `ib_logfile1`（各 48MB）。
  8.0 真正的 redo 在 `#innodb_redo/` 且仍在，但这两个残留文件**尚未清理**，见下方遗留。
- 官方 `mysql:5.7` 无 arm64 镜像，Apple Silicon 需 `platform: linux/amd64` 模拟；
  实测启动约 10s、live 集成 21 例约 37s，可用。

## 遗留

- **8.0 回退点未验证**：旧卷 `pi-enterprise-sandbox_mysql_dev_data` 里有 5.7 遗留的
  `ib_logfile0/1`，可能让 8.0 误判为 5.7→8.0 升级而拒绝启动。清理与回退演练未做
  （清理属破坏性操作，待确认后执行）。在此之前不应声称 R5 的“旧卷保留为可用回退点”已验证。
- 本轮未做：UPDRDB 双 Proxy / DBPM 取密（D2）、手工 DDL 导出与三进程 schema 校验（D3）、
  UPRedis 与队列 prefix（D4）。未连接任何目标内网组件；`innodb_lock_wait_timeout`
  生产取值待压测。
- 宿主机 Node 为 v26.5.0，六套测试在宿主机执行；容器内为 Node 22。
  Node 22 上的结果以 CI 为准，本记录不冒充 Node 22 验收。
