# D2c 验证记录：启动经 DBPM 取密（无环境变量口令回退）+ 本地 Docker 模拟

日期：2026-09-14。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §7 与 ADR 0011 D10。
用户决定：DBPM **全部强制**（开发 Compose、CI smoke、release-gate、生产 overlay 都经 DBPM 取密），
开发环境默认启用假 DBPM。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`2fefd531` + 本次未提交改动（随本证据同一 commit） |
| 数据库 / Redis | `mysql:5.7.44`（卷 `mysql57_dev_data`，宿主端口 3307）、`redis:7.2` |
| 镜像（本轮重建，容器已确认换新） | `pi-enterprise-agent` `2321bab43727`（agent / agent-worker）、`enterprise-sandbox` `09fdaa359137`（sandbox / sandbox-mcp）；api-server 无源码改动 |
| 模拟组件 | `dbpm-fake`、`updrdb-proxy-a` / `updrdb-proxy-b`（均为 `node:22-slim` + 仓库内开发脚本） |
| 运行时 | 容器内 Node 22；宿主 Node v23.11.0；uv Python 3.11.12 |

## 改了什么

- `contract/src/dbpm-config.ts`：读 `DBPM_URL` 与角色条目、校验连接串不带口令、DSN 用户名与条目一致、按角色取密。
- Agent：容器启动先 `resolveAgentCredentials()` 再建连；口令传给 Knex（故障切换 client 的 settings）、
  ioredis / BullMQ（options，`duplicate()` 保留）、DSH 会话存储（`requireMysql` 路径没有口令即失败）。
- exec：入口先取 UPDRDB 口令再装配；`createExecAppFromEnv` 拒绝带口令配置或缺口令装配。
  sandbox-mcp：只取服务 Redis 口令。replay Redis 无代码消费方，不取密。
- 开发 Compose：新增 `dbpm-fake`（真协议、只挂 `backend_internal`、只读、无 capabilities）；
  应用连接串改为无口令，经 `AGENT_COMPOSE_*` / `SANDBOX_MCP_COMPOSE_REDIS_URL` 插值；
  清空 `env_file` 带进应用容器的服务端口令与其他服务连接串；`agent-migrate` 改读 `AGENT_MIGRATE_DATABASE_URL`。
- 生产 overlay：禁用 `dbpm-fake`（永不启用的 profile + 强制 production），`DBPM_*` 必填，四个应用服务
  `depends_on: !override`，连接串无口令。
- CI smoke / 两个 release-gate：测试内起假 DBPM，服务子进程用无口令连接串；CI 生产 overlay 校验补 `DBPM_*` 占位值。
- `scripts/dev/docker-compose.updrdb-sim.yml` + `tcp-proxy.mjs`：本地双 Proxy 演练 overlay。

## 离线测试（宿主机，仓库根）

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 111 passed（含新增 `test_dbpm_compose_config.py`） |
| `npm test --prefix exec` | 366 tests / 365 pass / 1 skipped / 0 fail |
| `npm test --prefix contract` | 87 pass / 0 fail |
| `npm test --prefix agent` | 1283 tests / 1280 pass / 0 fail / **3 cancelled** |
| `npm test --prefix api-server` | 159 tests / 157 pass / 0 fail / **2 cancelled** |
| `npm test --prefix frontend` / `npm run build --prefix frontend` | 367 pass / built |

类型检查：exec、contract、agent（主程序 + strict runtime）、api-server 均通过。开发 compose、
双 Proxy 模拟 overlay、生产 overlay（CI 同款占位变量）均渲染通过，`scripts/verify_compose_prod_config.py` 通过；
渲染结果中 `dbpm-fake` 不在默认服务、四个应用服务连接串无口令、`DBPM_URL` 为配置值。

5 个 cancelled 与 [D2b 证据](d2b-updrdb-failover-2026-09-14.md) 记录的完全相同（在不含本分支改动的
`037fccf4` 上可复现），不记为通过。

Live 集成（独立库 `pi_d2c_it`，避免 `migrateRollbackAll` 拆掉运行中栈的表）：agent failover / mysql /
outbox / cron **27 pass**；exec db-client / db-failover / startup-credentials **29 pass**。
新 release-gate 改动只做了语法检查：两个 gate 需要专用 Redis / Sandbox 容器，本机未搭，**未运行**。

## Docker 模拟栈上的真实链路与故障演练

启动：`docker compose -f docker-compose.yml -f scripts/dev/docker-compose.updrdb-sim.yml up -d`。
agent / sandbox / sandbox-mcp 均 healthy——连接串无口令，取不到口令进程会退出，所以 healthy 即证明取密成功。
应用容器环境核对：agent、agent-worker、sandbox-mcp 无任何非空 `*PASSWORD`、无带口令 URL；sandbox 仅剩
无消费方的 `SANDBOX_INTERNAL_REDIS_URL/PASSWORD`（见遗留）。

| 场景 | 结果 |
|---|---|
| 正常 | 真实链路通过：登录 → 建会话 → 带工具 Run `SUCCEEDED`（`bash:succeeded`）→ 后台进程 logs `TICK-1…5`、SIGTERM → `cancelled` → B 访问 A 的 run / conversation / tools / process 全 404，A 全 200。MySQL 侧应用连接全部来自 `updrdb-proxy-a` IP，会话时区 `+00:00` |
| 主 Proxy 故障 | 停 `updrdb-proxy-a` 后重启 agent / worker / sandbox：全部 healthy，连接全部改从 `updrdb-proxy-b` 进入（`+00:00`）；真实链路再次全通过（同上各项）。停机瞬间 worker 记录一条 `Connection lost`（池内旧连接被断，未重放语句） |
| 主 DBPM 故障 | `FAKE_DBPM_FAIL_PORTS=7000` 重建 `dbpm-fake` 并重启四个应用服务：全部 healthy。假服务端日志：`sandbox/sandbox` 与 `redis/default` 各 3 次「#1 injected failure → #2 len=…」，恰为 agent / worker / sandbox 与 agent / worker / sandbox-mcp |
| 两台 DBPM 都故障 | 停 `dbpm-fake` 后重启 agent：进程反复退出（RestartCount 7，exit 1），日志 `DBPM credential fetch failed for agent-updrdb: ALL_ENDPOINTS_FAILED (#1=CONNECT_FAILED, #2=CONNECT_FAILED)` |
| 连接串带口令 | `compose run --rm --no-deps` 分别给 agent / sandbox / sandbox-mcp 塞带口令的 URL：三者均 exit 1，报「… must not embed a password; credentials come from DBPM」，输出中口令出现 0 次 |
| 口令泄漏检查 | 演练后 agent / agent-worker / sandbox / sandbox-mcp / dbpm-fake 日志中 `.env` 的 MySQL、Redis 口令出现次数均为 0 |
| 恢复 | 恢复 `dbpm-fake`、启动 `proxy-a`、重启应用后全部 healthy（api-server 在 agent 重启期间短暂 unhealthy，随后恢复 healthy） |

## 遗留 / 边界

- replay Redis（`sandbox-replay-redis` 服务、`SANDBOX_INTERNAL_REDIS_*` 配置、相关卫生测试断言）无代码消费方，
  本轮不取密也不删除，另开清理事项。
- 两个 release-gate 未实跑（环境依赖），CI smoke 未在本机跑（`smoke-cross-service.mjs` 在宿主机起进程，
  macOS 无 bwrap 所需 user namespace，按 AGENTS.md 属预期），以 CI 为准。
- 未连接真实 DBPM / UPDRDB / UPRedis；双口令重叠窗口、口令轮换重启顺序未演练。
- 宿主 `.env` 中旧的带口令 `AGENT_DATABASE_URL` 等仍在：不再经 Compose 进入容器，但宿主机直接起服务进程会被拒绝。
- 未新增 ADR 所述 `dbpm_egress` 窄网络；开发 `dbpm-fake` 只挂 `backend_internal`。
