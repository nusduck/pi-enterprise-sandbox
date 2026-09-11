# ADR 0011: 持久化与协调拓扑迁移至 UPDRDB / UPRedis，口令改由 DBPM 下发

| 字段 | 值 |
|---|---|
| 状态 | **Accepted / Not yet implemented**（2026-09-08 决策锁定，实施未开始） |
| 日期 | 2026-09-08 |
| 决策所有者 | Agent runtime maintainers |
| 适用范围 | `agent/src/infrastructure/mysql/`、`agent/src/infrastructure/redis/`、`agent/src/runtime/providers/mysql-session-store.ts`、`exec/src/db/`、`contract/`、`docker-compose*.yml` |
| 关联文档 | [改造方案与实测证据](../reviews/2026-09-07-updrdb-dbpm/migration-plan.md)、[探针工具](../reviews/2026-09-07-updrdb-dbpm/probe/) |
| 上游参照 | 中国银联 UPDRDB 2.4.0 手册与 DBPM 样例（本地副本置于 `docs/ref/`，**已 gitignore，不随本仓库分发**） |

---

## 背景

`docs/architecture.md` §4 将 **MySQL 8 + Redis 7** 定为唯一正式持久化／协调拓扑。
公司内部环境不提供这两者，只提供：

- **UPDRDB**（银联自研分布式关系数据库，内核 UPSQL 是 MySQL 5.7 的定制版）
- **UPRedis**（Redis 5.0.14 + 前置代理）
- **DBPM**（口令管理服务，要求口令不落配置文件）

本 ADR 锁定迁移到这三者的架构决策。**所有结论均有真机探针证据**，
证据与推导过程见改造方案 §9。

---

## 决策

### D1 UPDRDB 用透传模式，不分库

`指引手册` L45 建议 500GB 以下用透传模式。分库模式会让 43 处外键失效、
让 `idempotency_key` 等唯一索引从"全局唯一"退化为"分片内唯一"（**正确性问题**），
并要求 22 个 knex migration 全部重写为带 `ENGINE=lamost` 三元组的 `raw()` DDL。

**未来若必须分库，需另开 ADR**，不在本决策范围内。

### D2 语法基线是 MySQL 5.7，开发／CI 基线同步下调

UPSQL 是 MySQL 5.7 的定制版（`README-2.4.0.md` 的 License 指向 mysqld-5.7）。
即便透传模式行为"等同单机 upsql"，**MySQL 8.0 独有语法一律不可用**。

因此 `docker-compose.yml` 的开发／CI 基线同步下调为 **`mysql:5.7` + `redis:5.0.14`**，
并给 mysql 加 `--default-time-zone=+08:00` 对齐目标实例。

理由：让测试套件成为约束而非事后核对。已验证 —— 降基线后 outbox 集成测试
立即报 `errno 1064 … near 'SKIP LOCKED'` 并指向确切 SQL（方案 §9.2）。

> **配套前提**：CI 必须同时设 `TEST_MYSQL_URL` 与 `TEST_REDIS_URL`。
> 只设其一时 outbox 集成测试**静默跳过并报绿**（方案 §9.2 的陷阱）。

### D3 行锁抢占改用 claim-then-read

5.7 无 `FOR UPDATE SKIP LOCKED`（真机 1064）。命中两处：
`outbox-repository.ts:256`、`cron-job-repository.ts:268`。

改为单条 `UPDATE … SET claim_token=? WHERE … ORDER BY … LIMIT ?` 抢占后按
`claim_token` 回读。**互斥语义已真机验证**：两连接同抢一行，A 得 1 行、B 得 0 行。

**不采用**"保留 SKIP LOCKED 并按能力探测降级" —— 两条代码路径都要真机验证，
成本高于直接改。

### D4 append-only 触发器原样保留

厂商文档口径矛盾（`SQL支持列表` 标不支持，但 `指引手册` L208/L235 的"不支持"
**明确限定在分库模式**，且 L2237 记载 UPDRDB 为 `CREATE TRIGGER` 增加了
`OR DISPLACE` 扩展）。**真机四步实测全过**：建 / 真拦住 UPDATE / 删 / `SHOW TRIGGERS`。

因此 4 个 append-only 触发器保留，**不引入"应用层 + 表级 REVOKE"的降级路径**，
AGENTS.md §2 的安全不变量不降级。

### D5 两个 Proxy 的故障切换在应用侧自研

DBAAS 给 2 个 proxy 地址且不提供 VIP（`指引手册` §客户端负载均衡 明确
"DBAAS 实例客户端需自行配置"）；Node 侧无 JDBC `loadbalance://` 的等价物；
**不允许新增服务**，故 K8s Service / haproxy sidecar 方案排除。

实现放 `contract/`，策略为**粘住主用、失败拉黑 180s、不自动回切、全黑清表重试一轮**，
不做轮询。三个接入点：knex 函数式 `connection`（`client.js:87` 的
`connectionConfigProvider`）、agent 裸池、exec 裸池。

**边界（必须写进实现 PR）**：只在建连时切换，**不重试已发出的语句** ——
连接中途断掉的写语句可能已在服务端提交，重试等于重复执行。
这类错误冒泡给调用方，由 `claim_token` / `idempotency_key` 兜底。

### D6 移除 `agent-migrate`，生产 DDL 手工执行 + 启动校验

生产与测试环境均无 DDL 权限（`INSERT` 有）。现有编排把
`agent` / `agent-worker` / `sandbox` 都设为 `depends_on: agent-migrate:
service_completed_successfully`，没有 DDL 权限会导致**全栈无法启动**。

- 删除 `agent-migrate` 服务与三处 `depends_on`；`cli-migrate.ts` 保留供开发／测试
- 新增 `migrate:sql`：挂 `knex.on('query')` 在影子库上跑一遍迁移，捕获真实 DDL 导出脚本
- 新增 `migrate:verify`：**接进 `agent` 自身启动路径**（不是新增服务），
  schema 与代码期望不符则 fail-closed 拒绝启动
- 导出脚本自带 `INSERT INTO knex_migrations`（DML，生产有权限）

**knex migrations 仍是 schema 的唯一权威**；本地 Docker MySQL 容器是它的执行场所。

副作用：`migrate-trigger-preflight.ts` 针对的"非 SUPER 建不了触发器"问题
因 DDL 改由 DBA 执行而消失。

### D7 时区统一为 UTC，用会话级 `SET time_zone`

目标实例 `@@time_zone = +08:00`；应用侧 `toMysqlDateTime()`（`row-mappers.ts:316`）
走 `toISOString()`，**硬编码 UTC**。3 个迁移的 7 个列用服务端 `CURRENT_TIMESTAMP(3)`
填值，导致**同一张表两套时间基准，真机实测偏差 +8.00h**。

**在三处连接工厂建连时发 `SET time_zone = '+00:00'`**：
knex 走 `pool.afterCreate`，两处裸 mysql2 池走 `pool.pool.on('connection', …)`。
已实测偏差 8.00h → 0.00h，且池扩容出的新连接同样带上。

**不采用**：改服务端全局 `time_zone`（影响共享托管实例上的其他应用）、
去掉 DSN 的 `timezone=Z`（治不了本，应用写入恒为 UTC）。

### D8 UPRedis 5.0.14 够用，不升级

`bullmq@5.80.7` 的 6 处版本门槛逐条核对后无一失败：`minimumVersion = 5.0.0` 通过；
两处 LPOS 相关能力（`getState`、`isJobInList`）BullMQ **自动降级**到 Lua/LRANGE 实现。

真实场景实测（5.0.14 vs 6.2 对照）：端到端投递、吞吐、作业状态机、
**stalled 恢复（2022ms vs 2023ms）全部无差异**；唯一代价是亚秒级定时器
向上取整到整秒，最坏每跳多约 1 秒 —— 而用到延迟任务的只有 cron 触发的 Run
（分钟级）和重试退避（秒级）。

**升级换不来任何东西**：两个真 BLOCKER 与版本无关。

> 记录：Redis 5.0 已停止维护（5.0.14 发布于 2021-10）。服务在内网、有密码、
> 不对外暴露。**若安全侧将来要求 ACL，需要 6.0+**，届时重新评估。

### D9 BullMQ 队列 prefix 改为带 hash tag 的 `{bull}`

探针实测 UPRedis 代理**按 key 路由**（14-KEY 脚本报 `keys must route to same node`，
`EVAL` 不带 key 被拒）。BullMQ 单条脚本最多 14 个 KEY 且不带 hash tag。

`prefix` 改成 `{bull}` 后所有 key 落同一 slot，端到端 16ms 通过。
`run-queue.ts:154,283` 已支持传 `prefix`，**改配置不动逻辑**。

**此改动会改变既有队列的 key 空间，必须在切换时一次做完，事后补不了。**

我们自己的 3 个锁模块全是 `numkeys=1`，不受影响。

### D10 DBPM 只在启动取一次口令，开发用假服务端挡板

- **进程启动时取一次，运行期不轮换、不重取**；口令变更通过滚动重启生效。
  不实现认证失败重取／定时预取／池热重建，也不留半成品钩子。
- **口令在容器内由应用进程自己取**。不做宿主机预取、不经 compose `environment:` 传 ——
  那会让明文口令出现在 `docker inspect` 和进程环境里。
- 共取 **3 组**凭据：UPDRDB、Agent 协调 Redis、sandbox-replay Redis。
- **开发挡板用假服务端而非应用内 stub 分支**。任何
  `if (!DBPM_URL) 用环境变量口令` 的写法都是"回退到默认可用"，违反 AGENTS.md §2；
  假服务端让生产代码只保留一条取密路径，环境差异只在地址。
- 新增 `dbpm_egress` 窄网络挂给需要取口令的服务。
  **不给 `sandbox-mcp` 通用 `service_egress`** —— 它是对外 MCP facade，
  AGENTS.md §1 要求其凭据面最窄。

### D11 Redis 保持两套独立实例

`docker-compose.yml:151` 的现有设计要求 Agent 协调 Redis 与 sandbox-replay Redis
是两个**独立凭据**的实例（"DB index is not isolation"）。
运维确认可提供 2 套，**该隔离设计原样保留，不降级为共享实例 + DB index**。

---

## 降级与不做的事

| 项 | 决定 |
|---|---|
| 45 处 `.execute()` → `.query()` | **降为技术债**。真机接受 `COM_STMT_PREPARE`，可照常工作。转入 `review-deferred-items.md` |
| DBPM 口令热轮换 | **不做**。当前需求不需要，不作为债务登记 |
| 分库／分片改造 | 不在范围，需另开 ADR |
| 存量数据迁移 | 不在范围（当前无生产数据） |

---

## 后果

**正面**

- 触发器保留意味着 append-only 安全不变量无需降级（D4）
- 基线下调让 5.7 不兼容项在 CI 暴露，而非上线后暴露（D2）
- 会话级时区修复只影响我们自己的连接，不碰共享实例（D7）

**负面 / 需长期承担**

- **schema 变更需人工环节**：每次 DDL 要把导出脚本发 DBA 执行。
  减轻手段是脚本零手写、优先加列而非加表 —— 后者**会影响功能设计取向**（D6）
- **多一层自研连接层**：proxy 选择器是我们自己维护的代码，
  故障时排查面比 VIP 方案大（D5）
- **Redis 停留在 EOL 版本**，安全补丁窗口关闭（D8）
- **亚秒级定时精度下降**约 1 秒（D8）

---

## 验证要求

实施时按改造方案 §10 执行。**六套测试全绿不等于验证充分** ——
必须确认集成测试真的执行了（`TEST_MYSQL_URL` + `TEST_REDIS_URL` 都设、看用例数），
且最终交付按 AGENTS.md §4 重建容器跑真实链路。

`probe/` 下的四个探针脚本是本 ADR 结论的证据来源，切换前后应重跑并将输出存入
`docs/evidence/`。
