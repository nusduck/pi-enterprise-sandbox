# K8s 本地运行、Agent `/ready` 探活与默认 Agent 并发竞争（2026-09-18 第二轮）

接续[第一轮多副本演练](k8s-sim-multi-replica-2026-09-18.md)。本轮：① Agent HTTP `/ready` 改为真正 ping
MySQL / Redis；② 复现「新组织首次并发建会话 409」；③ 本地运行以 OrbStack K8s 为主（`scripts/dev/k8s/up.sh dev`），
多副本演练并入同一套清单（`up.sh sim`）。

## 一、对象与环境

| 项 | 值 |
|---|---|
| 代码 | `0c3bd3d7` + 本次未提交改动（`agent/src/bootstrap/{worker-probe,http-main}.ts`、`scripts/dev/k8s/`、文档） |
| 镜像 | agent 按工作树重建 `sha256:39b3e849…`（2026-09-18 11:38）；其余沿用第一轮（HEAD 内容） |
| K8s | OrbStack 2.2.3 单节点 `v1.35.6+orb1`，运行时 docker |
| Node | 测试与驱动用 `/opt/homebrew/opt/node@22`（runtime-versions.json 主版本 22） |

## 二、Agent HTTP `/ready` 探活

**缺陷**：`isDataPlaneReady()` 只看客户端对象是否已建。第一轮在 Redis 暂停时两个 Agent HTTP 副本一直 Ready
（tag `mu6duh8m`，`agent_http_unready_during_outage` FAIL），与 deployment.md「data plane 不可用即 503」不一致。

**修复**：新增 `isDataPlaneReachable(container)`（`worker-probe.ts`），复用 Worker 的 `pingDependencies`
（`SELECT 1` / `PING` 各 2s 超时）；`http-main.ts` 的 `dataPlaneReady` 改接它。`container.ts` 行数预算已满，未改。

| 验证 | 结果 |
|---|---|
| `agent/tests/bootstrap/agent-http-readiness.unit.test.js` 修复前 | 失败（`does not provide an export named 'isDataPlaneReachable'`） |
| 同上 + `worker-probe.unit.test.js` 修复后 | 13/13 |
| sim 模式真机：`docker pause` 专用 Redis | 两个 Worker、两个 Agent HTTP 副本都转 NotReady；恢复后全部 Ready，新 Run SUCCEEDED（tag `mu6f6g3i`，4/4） |

第一次重跑（tag `mu6f2d2h`）场景只在 Worker 摘除后再等 12s，另一个 Agent 副本尚未摘除即判失败；手工观察 Redis 暂停
23s 后两个 Agent Pod 均 0/1。场景改为「等到全部摘除或 60s 超时」后通过。修复前后同一断言的对照即第一轮 FAIL 与本轮 PASS。

## 三、新组织首次并发建会话 409（复现，未修）

`agent/tests/mysql/default-agent-race.integration.test.js`（未提交），在 release-gate 运行器里对专用库执行：
组织、组织外部引用、8 个用户与成员关系已就位、默认 Agent 未建时，8 个并发 `ConversationService.create`
**7 个失败**，均为 `ConflictError: CONFLICT: Agent definition name conflict`（HTTP 映射 409，非可重试）。
对照组：默认 Agent 已存在后 8/8 成功。根因：`ensureTenantDefaultAgent` 撞 `uk_agent_definitions_org_name`
后在同一事务里重读，REPEATABLE READ 快照（事务内首次普通读已建立）看不到对方已提交的行，于是抛出原错误。

## 四、K8s 本地运行（dev 模式）

`scripts/dev/k8s/up.sh dev`：Compose 只留 mysql / redis / dbpm-fake / sandbox（exec，代替 VM），停掉 Compose 的
agent / agent-worker / api-server / frontend / sandbox-mcp；命名空间 `pi-dev` 各 1 副本；环境变量取自
`docker compose config`；LoadBalancer 映射 127.0.0.1:3000 / 4000 / 4100 / 8082；已启用 Skill 挂 Compose 命名卷
的节点路径。

| 验证 | 结果 |
|---|---|
| 首次 `up.sh dev` | 5 个 Deployment 全部 rollout 成功 |
| 真实链路（宿主 Node 22 → `127.0.0.1:4000`，真实模型） | 11/11：注册登录、建会话、带工具 Run `SUCCEEDED`（两条 bash）、后台进程 logs、SIGTERM → `cancelled`、四项跨租户 404 含本人 200 对照 |
| 前端 / facade | `127.0.0.1:3000` 200，经前端 `/api/auth/me` 401（未登录，代理通）；`127.0.0.1:8082/health` 200 |
| 再次执行 `up.sh dev`（命名空间已存在） | 滚动重启后全部 Running；单副本交接期间 `/health/ready` 出现一次 503，约 15s 后 200 |

## 五、清单层面的新发现

- **Service 链接变量覆盖应用配置**：K8s 默认给 Pod 注入 `<SERVICE>_PORT=tcp://…`。名为 `sandbox-mcp` 的 Service
  注入 `SANDBOX_MCP_PORT`，覆盖镜像里的 `8082`，facade 报 `options.port … Received type number (NaN)` 进入
  CrashLoopBackOff。清单给所有 Pod 设 `enableServiceLinks: false` 后正常。目标环境清单同样需要（或避开这些 Service 名）。
- 第一轮的 `runAsUser` 数字化要求仍成立。

## 六、sim 模式回归（新清单 + 新 agent 镜像，缩短时长）

tag `mu6f2d2h`：16/18。exactly-once 4/4、capacity 2/2、kill-takeover 2/2（13.8s 接管，fence2）、freeze-fence 2/2、
cancel 2/2、rolling-restart 1/1、redis-outage 3/4（观察窗口问题，见第二节，改后 4/4）、same-session 0/1
（follow-up 直接 `FAILED / session lock busy`，已知缺陷，未修）。

## 七、离线测试与类型检查（Node 22）

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 207 passed |
| `npm test --prefix exec` | 421 项：419 pass / 0 fail（2 项跳过） |
| `npm test --prefix contract` | 118 / 118 |
| `npm test --prefix agent` | 1385 / 1385，0 cancelled |
| `npm test --prefix api-server` | 160 / 160 |
| `npm test --prefix frontend` | 367 / 367 |
| `npm run build --prefix frontend` | 通过 |
| 类型检查 | exec / contract / api-server / agent（主程序 + `src/runtime` strict）全部通过 |

## 八、未覆盖

- up_docker（1000:1000）镜像用户改造未落地：sandbox-mcp 从 10001 改为 1000 触及 AGENTS.md §2 的安全不变量，待确认。
- 共享 Skill 跨 Pod 发布一致性、`EXEC_INTERNAL_ALLOW_CIDR` 在 Pod 源地址下的正负对照仍未测。
- 双集群、真实共享存储、真实 UPDRDB / UPRedis / DBPM / 麒麟 VM 仍需目标环境。
