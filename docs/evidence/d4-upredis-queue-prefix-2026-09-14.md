# D4 验证记录：BullMQ `{bull}` prefix + Redis 5.0.14 基线 + UPRedis 路由模拟

日期：2026-09-14。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §8 与 ADR 0011 D9。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`a7ae4e8a` + 本次未提交改动（随本证据同一 commit） |
| Redis | `redis:5.0.14`（开发栈新卷 `redis5_dev_data` / `sandbox_replay_redis5_dev_data`；放行测试用临时容器 `pi-release-gate-redis-d4`，`noeviction` + AOF） |
| 镜像（重建，容器已确认换新） | `pi-enterprise-agent` `041ae7f28315`（agent / agent-worker）；sandbox 镜像未改动，sandbox-mcp 容器按新 overlay 重建 |
| 运行栈 | 开发 compose + `docker-compose.updrdb-sim.yml`（dbpm-fake + 双 Proxy）+ `docker-compose.upredis-sim.yml`（UPRedis 路由模拟代理） |
| 运行时 | 容器内 Node 22；宿主 Node v23.11.0；bullmq 5.80.7；ioredis 5 |

## 改了什么

- `run-queue.ts`：`resolveRunQueuePrefix()`，默认 `{bull}`，要求非空 hash tag（printable ASCII，3–64）；`createRunQueue` / `createRunWorker` 在加载 bullmq 前校验并总是显式传 `prefix`。
- 容器（HTTP 投递）与 `worker-main`（消费）读 `AGENT_RUN_QUEUE_PREFIX`；两份 Compose 的 agent / agent-worker 注入同名变量（空值交给应用取默认，Compose 默认值写不了 `}`）。当前代码无 QueueEvents / 独立清理消费者。
- Compose：`redis` 与 `sandbox-replay-redis` 改 `redis:5.0.14` + `--maxmemory-policy noeviction`，换新卷（旧卷保留不挂载）；CI 服务 Redis 同步。
- `scripts/dev/upredis-sim-proxy.mjs` + overlay：RESP 代理，模拟真机探针确认的两条限制——零 key `EVAL`/`EVALSHA` 被拒；同一命令或同一 MULTI 内 key 不在同一 slot 被拒（按 CRC16 slot 判，比真实按节点路由更严）；应答保序；生产拒绝运行。
- 放行测试 `agent/tests/redis/upredis-queue.integration.test.js`；三个 release gate 的镜像断言改 5.0.14、prefix 改带 tag。
- 文档：deployment / development / architecture / README / `.env.example`、runbook `run-queue-prefix-switch.md`、design §7 表、ADR D9 实施细化、CHANGELOG。

## 关键事实：LPOS 不是阻塞项

探针把「Redis 5.0 无 `LPOS`」列为 BLOCKER。核对 bullmq 5.80.7 源码：`Scripts.isJobInList` 与 `getState` 在 `INFO` 报告的版本低于 6.0.6 时改用 Lua 实现（`isJobInList` / `getState` 脚本），不发 `LPOS`；只有未被调用的 `removeOrphanedJobs` 与 `getStateV2` 含 `LPOS`。下面的放行测试在 5.0.14 上覆盖了状态查询。前提：真实代理放行 `INFO`（放行测试第一例会记录版本）。BullMQ 会打印「recommended minimum 6.2.0」提示，属预期。

## 离线测试（宿主机，仓库根）

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 123 passed（Redis 拓扑棘轮：5.0.14、`noeviction`、新卷名、prefix 注入） |
| `npm test --prefix exec` | 369 / 368 pass / 1 skipped / 0 fail |
| `npm test --prefix contract` | 97 pass |
| `npm test --prefix agent` | 1300 / 1297 pass / 0 fail / **3 cancelled** |
| `npm test --prefix api-server` | 159 / 157 pass / 0 fail / **2 cancelled** |
| `npm test --prefix frontend` / build | 367 pass / built |

类型检查：exec、contract、agent（主程序 + strict runtime）、api-server 通过。5 个 cancelled 与 D2b / D3 证据相同，未记为通过。
新增单测：prefix 正负对照（`bull`、`{}`、`{bull`、空格、超长被拒，工厂在碰 Redis 前拒绝）；容器 / worker 透传；模拟代理（已知 slot 值 foo=12182、bar=5061，key 提取，保序，MULTI 跨节点 EXECABORT，生产拒绝运行）。

开发 + 双模拟 overlay、生产 overlay 渲染通过；生产渲染（CI 同款占位变量）经 `verify_compose_prod_config.py` 通过，渲染结果 redis / replay 为 5.0.14 + `noeviction` + `redis5_data` / `sandbox_replay_redis5_data`，不含 `upredis-proxy`、`dbpm-fake`。

## 放行测试（真实 Redis 5.0.14，生产 prefix `{bull}`）

| 目标 | 结果 |
|---|---|
| 直连 `redis:5.0.14`（`TEST_UPREDIS_REQUIRE_NOEVICTION=1`） | 6 pass / 1 skip（负对照仅代理目标运行）；`maxmemory-policy=noeviction` |
| 经宿主机模拟代理（`TEST_UPREDIS_EXPECT_ROUTING=1`） | **7 pass**：零 key EVAL 被拒 / 1 key 放行；绕过工厂用 `bull` 前缀建 Queue，`add` 被 `keys must route to same node` 拒绝；立即任务、延迟任务（≥1s 才执行，状态 delayed→completed）、失败重试（attemptsMade=2）、stalled 恢复（A 强制关闭后 B 收到 `stalled` 并完成）、取消（delayed 作业 remove 后查不到、计数归零）、Run lease / 会话锁 / 取消信号单 key CAS |
| 清理核对 | 每个队列 `obliterate` 后逐个单 key `EXISTS`（20 个队列级后缀 + 各作业 key/lock/logs）无遗留；测试后 `DBSIZE=0` |

中途发现：负对照首轮失败——脚本被代理拒之前，BullMQ 已用单 key 命令写入 `bull:<queue>:meta`。测试改为按单 key 删除并断言恰好删 1 个；首轮遗留的那个 key 已手工删除。

## Docker 演练（真实容器栈）

| 步骤 | 结果 |
|---|---|
| 切换前盘点（runbook 第 2 步） | 旧 7.2 实例 `bull:agent-runs:*` 只有 `meta` / `id` / `events` / `stalled-check`，wait/active/delayed/prioritized/paused/failed 均不存在；MySQL `runs` 共 6 条、非终态 0 |
| 停 agent / agent-worker → 叠三层 overlay `up -d` | redis / replay 重建为 5.0.14（新卷），`upredis-proxy` healthy；agent healthy；worker `recovery scan complete actions=0`、`BullMQ consumer started`；agent / worker / sandbox-mcp 的 Redis URL 均为 `redis://upredis-proxy:6379/0` |
| Redis 侧 | `redis_version:5.0.14`，两套 Redis `maxmemory-policy noeviction`；新 key 只在 `{bull}:agent-runs:*` |
| 真实链路 | 登录 → 建会话 → 带工具 Run `SUCCEEDED`（`bash:SUCCEEDED`，共 2 个 Run）→ 后台进程 SIGTERM → B 访问 A 的 run / conversation / tools / process 全 404、A 全 200；代理日志无拒绝；链路后 key 为 `{bull}:agent-runs:{events,id,meta,stalled-check}` 与 2 个 `run:stream:*` |
| 负对照 | `AGENT_RUN_QUEUE_PREFIX=bull` 重建 worker：`fatal: AGENT_RUN_QUEUE_PREFIX must contain a non-empty Redis hash tag …` 反复重启；恢复空值后 consumer started，实例内无 `bull:*` key |

## 未做 / 边界

- 真实 UPRedis Proxy 上的放行测试未跑（需要目标环境与 DBPM 条目）；本地代理按 slot 判定比真实按节点更严，通过不代表真机通过。真机需确认代理放行 `INFO`、BullMQ Worker 的 `BZPOPMIN` 阻塞读与 `MULTI`（BullMQ 状态查询会用）。
- 真实 UPRedis 各后端节点的 `noeviction` 持久化需 Redis 运维核验（代理未必放行 `CONFIG GET`）。
- release gate（Redis / BullMQ / Worker 进程重启）与 CI smoke 未在本机实跑，仅更新断言。
- replay Redis 仍无代码消费方，本阶段只同步版本与 `noeviction`，未做 replay 校验；清理另行处理。
- 未做压测；不据此推断性能。
- 旧卷 `redis_dev_data`、`pi-enterprise-sandbox_redis_dev_data`、`pi-enterprise-sandbox_sandbox_replay_redis_dev_data` 保留未删。本地 `.env` 仍写旧 Redis 卷名，起栈需覆盖 `REDIS_DATA_VOLUME` / `SANDBOX_REPLAY_REDIS_DATA_VOLUME`。
