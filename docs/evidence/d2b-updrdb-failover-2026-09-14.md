# D2b 验证记录：UPDRDB 双 Proxy 故障切换 + 等待式 UTC 会话初始化

日期：2026-09-14。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §4.2 / §4.3 的 D2 阶段
接线部分（D2a 纯策略已在 `037fccf4` 提交）。DBPM 启动取密、假 DBPM 挡板属于 D2c，本轮未做。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`037fccf4` + 本次未提交改动（随本证据同一 commit） |
| 数据库 | `mysql:5.7.44`，新卷 `mysql57_dev_data`（空库，由 `agent-migrate` 迁移），全局时区 `SYSTEM` |
| 宿主端口 | MySQL 映射到 **3307**：本机 `127.0.0.1:3306` 被宿主机自带的 `mysqld` 占用，连 3306 实际连到的不是容器 |
| Redis | `redis:7.2`（6379 确认是容器端口转发） |
| 镜像（本轮重建，容器已确认换新） | `pi-enterprise-agent` `0f85674b67a6`（agent / agent-worker）、`enterprise-sandbox` `97bef26d8b23`（sandbox / sandbox-mcp）、`pi-enterprise-api` `cb5a4289d3a8` |
| 运行时 | 容器内 Node 22；**宿主 Node v23.11.0**（不是仓库钉的 22，也不是 D1 记录里的 v26.5.0）；uv Python 3.11.12 |
| Knex / mysql2 | 3.3.0 / 3.15.3 |

## 改了什么

- Agent Knex：`createMysqlKnex()` 改用 `createFailoverKnexClient()`——按实例继承 knex mysql2 方言、
  覆写 `acquireRawConnection()`，端点组装成局部 settings（不写共享的 `connectionSettings`，
  口令以不可枚举方式补回），建连 → 版本探测 → `SET SESSION time_zone` 全部完成才交付。
  移除 `pool.afterCreate`。
- Agent DSH 会话存储与 exec：每端点一个 mysql2 池，外包按端点故障切换的 acquire；
  交付连接前按底层连接做一次 UTC 初始化并等待完成。替换 D1 的「connection 事件里发出、失败销毁」。
- 新增可选配置 `UPDRDB_ENDPOINTS`（恰好两个 `host:port`），三处读取；未设置沿用 DSN 单端点，
  格式错误抛 `EndpointConfigError`（不会被 exec / DSH 当作「缺配」回退内存仓储）。
- exec 仓储类型从 mysql2 `Pool` 收窄为 `ExecDbPool`（无 `on`、`pool` 等绕开故障切换的入口）。
- Compose 为 agent / agent-worker / sandbox 透传 `UPDRDB_ENDPOINTS`（默认空）；
  `.env.example`、`deployment.md` 同步；旧 8.0 卷的「回退点」表述按用户决定改为作废。

## 离线测试（宿主机，仓库根）

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 104 passed |
| `npm test --prefix exec` | 357 tests / 356 pass / 1 skipped / 0 fail |
| `npm test --prefix contract` | 79 pass / 0 fail |
| `npm test --prefix agent` | 1269 tests / 1266 pass / 0 fail / **3 cancelled** |
| `npm test --prefix api-server` | 159 tests / 157 pass / 0 fail / **2 cancelled** |
| `npm test --prefix frontend` | 367 pass / 0 fail |
| `npm run build --prefix frontend` | built |

类型检查：`exec`、`contract`、`agent`（主程序 + `src/runtime` strict）、`api-server` 均通过。
`docker compose config -q` 通过。

**5 个 cancelled 不记为通过，也不是本次引入**：`agent/tests/runtime/remote-providers.test.ts`
三例、`api-server/tests/file-proxy-workspace-id.test.js` 两例，报错均为
`Promise resolution is still pending but the event loop has already resolved`。把 D2b 改动
`git stash -u` 后在 `037fccf4` 上单独重跑这两个文件，结果完全相同（11 pass / 3 cancelled，
1 pass / 2 cancelled）；恢复改动后再跑也相同。D1 在宿主 Node v26.5.0 上这两套为 0 失败，
差异很可能来自宿主 Node 版本，未进一步定位。Node 22 上的结果以 CI 为准。

## Live 集成（MySQL 5.7.44）

`TEST_MYSQL_URL` + `TEST_REDIS_URL`，`--test-concurrency=1`：

- Agent：`failover.integration` + `mysql.integration` + `outbox.integration` + `cron-claim.integration`
  **27 pass / 0 fail**。新增 5 例：
  - Knex 端点 `[127.0.0.1:1, 真库]`：4 条并发语句扩出 4 条不同 `CONNECTION_ID()`，会话时区全部 `+00:00`，
    `TIMESTAMPDIFF(UTC_TIMESTAMP(), NOW()) = 0`（本地全局是 `SYSTEM`，漏初始化时读到的是 `SYSTEM`）；
  - 两端点都拒绝：约 8ms 以 `all endpoints failed (#1=ECONNREFUSED, #2=ECONNREFUSED)` 失败，不等 Knex 默认 60s；
  - 错误口令：`ER_ACCESS_DENIED_ERROR` 原样抛出，不被当作 Proxy 故障，消息不含口令；
  - DSH 裸池：切换后在持有的连接上跑事务，`NOW(3) = UTC_TIMESTAMP(3)`；
  - `MysqlSessionStore` 从 `UPDRDB_ENDPOINTS` 取端点并经故障切换池连上真库。
- exec：`db-client` + `db-failover` **20 pass / 0 fail**，含 3 个真库用例（同上三种场景，3 条并发连接）。

假驱动单测另覆盖真库难以构造的分支：并发建连不串端点、共享 `connectionSettings` 不被改写、
口令不可枚举、会话初始化失败销毁连接且不换端点、握手挂死在预算内失败并销毁迟到连接、
语句发出后连接断开不在另一端点重发。

## 真实链路（重建后的容器栈，BFF `127.0.0.1:4000`）

1. 注册用户 A → `/api/auth/me` 200；`POST /api/sessions/ensure` 拿到 conversation 与 sandbox session；
2. 带工具 Run：202 → `SUCCEEDED`，工具台账 `bash:succeeded`；
3. 第二个 Run 后台启动 `for i in $(seq 1 300)…`：`GET /api/processes` 列出 `running`，logs 200
   读到 `TICK-1…TICK-6`；`POST …/signal` SIGTERM 200（`stopping`）→ 进程终态 `cancelled`；
   该 Run 终态 `SUCCEEDED`；
4. 跨租户：用户 B 访问 A 的 run / conversation / tools / process **全部 404**，
   A 自己访问同样四个入口**全部 200**（拒绝有正对照）。

数据库核对（链路结束后）：`domain_outbox` 270 行全部 `PUBLISHED`、`claim_token` 残留 0；
`cron_jobs` 0 行；`performance_schema` 中 9 条应用连接会话时区全部 `+00:00`；
Run 的 `created_at` 与 `UTC_TIMESTAMP()` 同基准（无 8 小时偏移）。agent / agent-worker 日志无错误。

## 观察到但未定位

- sandbox 日志在两个 Run 执行期间出现 48 行 `exec fs-error /internal/v1/fs/resolve|list INTERNAL_ERROR`
  （02:27–02:28 UTC）。`exec/src/http/internal-fs.ts` 与 `exec/src/fs/` 不引用数据库池，
  两个 Run 均成功，**静态判断**与本次数据库接线无关；未在 D2b 之前的镜像上对照复现，
  也未查明被映射成 `INTERNAL_ERROR` 的原始异常。留作后续排查，不记为验证通过项。

## 未做 / 边界

- 未连接任何目标 UPDRDB Proxy；「主 Proxy 故障」由本机拒绝连接的端口模拟，
  不覆盖黑洞地址（SYN 无响应）下 3s 握手超时的真机表现——该分支只有假驱动覆盖。
- 池内排队等待也计入 10s acquire 预算；排队超时会把当前端点按不可达拉黑。两个端点指向
  同一后端时影响有限，但压测时应观察。Knex 自身 `acquireConnectionTimeout` 仍为默认 60s。
- D2c（DBPM 启动取密、假 DBPM 默认启用、Redis 口令）、D3、D4 未开始。
- 旧 8.0 卷按用户 2026-09-14 决定作废，未删除，也未做回退演练。
