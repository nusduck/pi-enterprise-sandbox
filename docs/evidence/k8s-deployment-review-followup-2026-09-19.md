# K8s 部署评审跟进：K4 关停总期限与 K2/K4/K5 专项验收（2026-09-19）

承接 [首轮修复证据](k8s-deployment-review-fixes-2026-09-19.md)（保留不改）。本轮回应评审复核意见：K4 关停期限没有覆盖
整个关停流程，K2 / K4 / K5 缺专项验收，CI 未核对。不关闭任何 STATUS 行；生产目标环境验收仍未进行。

## 验证对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm` / `480bf65d` + 未提交改动（首轮与本轮） |
| runtime | 容器内 Node 22.23.2（测试运行器、sim 驱动、客户端）；Python 3.11.15；kubectl client 1.33.4（驱动镜像）/ server 1.35.6+orb1 |
| 镜像 | `pi-enterprise-agent` = `076aa967c6d7`（含本轮全部 agent 改动）；api / sandbox-mcp / frontend 未变（`75a4b34fbfb4` / `515606a4ee0e` / `3b1e2ce001ae`） |
| 运行对象 | `pi-sim`（`up.sh sim`：2 副本、fake-llm、专用 Redis / exec / 库 `pi_k8s_sim`，默认 150s 排空 / 180s 宽限）；收尾后 `pi-dev` 全部 Pod imageID 已核对为上述镜像 |
| 驱动 | 宿主无 Node 22，`scripts/dev/k8s/scenarios.mjs` 在 `node:22-slim` + kubectl + docker CLI 容器中运行（`--network host`） |

## 一、K4 实现缺口：期限没有覆盖整个关停

**复现**：`agent/tests/bootstrap/worker-main.unit.test.js`「SIGTERM stops intake at once …」用真实 `startWorkerMain` + 替身容器，
outbox 第二次 `publishOnce()` 起挂住（模拟 MySQL 挂起）。对 HEAD 版 `worker-main.ts`：5s 内关闭的消费者数 `expected 2, actual 0`
——信号处理先 await outbox，消费者从未关闭、仍在取任务，期限计时器也没有启动。

**修复**：`agent/src/bootstrap/worker-drain.ts` 的 `runWorkerShutdown`：收到信号即置未就绪，**同时**发起关消费者
（`worker.close()` 立即停止取新作业）与停后台循环（依赖守卫、cron、恢复定时器、outbox）；两者合起来受
`AGENT_WORKER_DRAIN_TIMEOUT_MS` 约束，**从信号起算**；到期不清理直接退出（码 1）；清理另有 15s 上限；关停中守卫不再
resume 消费者。修复后该用例与 `worker-drain.unit.test.js` 共 14/14。`tests/test_k8s_dev_manifests.py` 改为校验
宽限 > 排空期限 + 清理上限 + 关探针。

## 二、K4 sim 专项（默认 150s / 180s，2 副本）

每个场景对承载 Run 的 Worker Pod `kubectl delete pod`（SIGTERM），用 `kubectl get -w` 取容器退出码与时刻，排空期间另投
两个探针 Run，核对 fake-llm 记录的领取副本、账本（`runs` / `tool_executions`）与执行面工作区里的副作用行数。
最终整轮 tag `mu7udj6s` 16/17，MySQL 场景修正断言后重跑 tag `mu7uusxw` 3/3。

| 场景 | 退出 | 排空期间领取 | 账本与副作用 |
|---|---|---|---|
| `drain-clean`（2 段 20s 工具） | 46.9s，码 0，无 deadline 日志 | 2 个探针都在其他副本 | Run SUCCEEDED、attempt 1、首轮模型调用 1 次、全部轮次在原副本；工具 2 行 SUCCEEDED；副作用 2 行 |
| `drain-deadline`（3 段 70s） | 149.1s，码 1，`drain deadline 150000ms reached` | 2 个探针都在其他副本 | 前两段 SUCCEEDED，第 3 段 RUNNING；退出后 0 次新模型调用、attempt 1，恢复扫描不重放；副作用恰为 2 行——第 3 段前台命令随连接断开被执行面中止（`exec/src/http/node-listener.ts` 的 `res` close → abort），账本仍是 RUNNING（结果未知）。人工 `cancel` 后恢复扫描落 CANCELLED |
| `drain-subrun`（前台子 Run，子 Run 60s 工具） | 66.8s，码 0 | 2 个探针都在其他副本 | 父子 Run 都 SUCCEEDED、attempt 1、各自首轮 1 次；子 Run 副作用 1 行。本轮父子在同一副本；首跑（tag `mu7t9o2m`）子 Run 落在另一副本时同样通过 |
| `drain-redis-outage`（SIGTERM 后 2s 暂停专用 Redis，退出后恢复） | 149.7s，码 1，deadline 日志 | —（Redis 停，未投探针） | Redis 恢复后恢复扫描判定工具账本全为终态，重放后 SUCCEEDED（本轮 attempt 3，上一轮 attempt 2）；工具 1 行、副作用 1 行，重放只补模型轮次，不重跑工具 |
| `drain-mysql-outage`（SIGTERM 后 2s：EndpointSlice 指向黑洞并断开 `pi_k8s_sim` 上应用层连接） | 18.7s，码 0，未崩溃 | — | 续租写不进 MySQL，执行器按 fencing 中止 Run，前台命令随之中止：副作用 0 行、工具 RUNNING、Run RUNNING、无重放；人工 `cancel` 后 CANCELLED |

**演练中新发现的缺陷（已修）**：MySQL 场景首跑时 draining 副本在 4.8s 以码 1 退出，没有 deadline 日志。给 sim Worker
挂 `async_hooks` 诊断钩子（记录 Promise 创建栈）后定位到 `createSerialTimeoutLoop`：cancel 轮询 tick 读库失败时，
`tickPromise.finally(...)` 成为只由 `stop()` await 的 rejected Promise → 未处理 rejection → 进程崩溃。**与关停无关**：
Run 执行期间任何一次 MySQL 故障都会让承载 Run 的 Worker 崩溃。修复：循环接住 tick 错误、记日志并按间隔继续（抽到
`agent/src/application/serial-timeout-loop.ts`）；回归用例修复前触发 `unhandledRejection`，修复后通过。修复后重跑见上表。

## 三、K2 真实 MCP 故障恢复

真插件树（出厂 `dsh-mcp-client`）+ 真 MCP 服务器（官方 SDK 的 streamable-http 与 stdio），在 agent 镜像容器内运行，Agent
进程全程不重启（驱动与 fixture 在会话临时目录，未入库）：

| 情形 | 结果 |
|---|---|
| A. HTTP Server 启动时不可达，5s 后起来 | 按退避重连，约 3s 内 `connected`，`/ready` 投影恢复 true，调用成功 |
| B. HTTP Server 运行中断开 13s 再恢复 | 断开期间调用 `fetch failed`，**投影仍报 connected**（出厂保留上一代工具）；恢复后调用成功 |
| C. stdio 子进程崩溃、20s 内起不来，之后可起 | 期间调用 `Not connected`，投影仍报 connected；约 12s 后重连成功、调用成功 |
| D. stdio 崩溃后一直起不来（出厂预算） | 约 125s 后放弃并注销工具，`ready:false`；之后即使服务器可启动，45s 内**不再重连**——只有重启进程才恢复 |

D 与「任一启用 MCP 不可用即 `/ready` 503」叠加，意味着一台 MCP 故障超过约两分钟 Agent 就永久未就绪（liveness 不会重启它，
BFF 随之 503）。**修复**：`mcp-entries.ts` 生成条目时默认 `reconnect.maxAttempts = Number.MAX_SAFE_INTEGER`（退避仍封顶
30s），`MCP_SERVERS_JSON` 条目可用 `reconnect` 覆盖，非法键/值启动即拒。复测：默认配置故障持续 160s（超过旧预算）后服务器
可启动，约 24s 自动恢复；显式 `{"maxAttempts":2}` 的服务器按出厂语义放弃并保持 unavailable。

仍存在的盲区（出厂行为，已写入 deployment.md）：B / C 期间 `/ready` 仍报 connected 而调用失败。集群内只验证了「不可达 →
unavailable、Pod 不就绪不重启」（首轮证据），恢复链路以上述容器内真插件树为证。

## 四、K5 慢启动保护（pi-sim，不挂 Service 的独立 Deployment）

慢 MCP（streamable-http，每个来源 IP 的第一次 `initialize` 延迟 50s，低于 SDK 60s 超时）使 Agent 启动约 55s 才 listen：

| 变体 | 结果 |
|---|---|
| 新清单：startupProbe `/health` 5s × 36 | 0 次重启；约 55s 后就绪，`/ready` 200，slow Server connected |
| 旧清单：只有 liveness 10s × 3（1s 超时） | 第 30s `failed liveness probe, will be restarted`，exit 137——复现 K5 |
| 超预算：startupProbe 压到 5s × 6（30s） | 第 30s `failed startup probe, will be restarted`，exit 137——超预算按预期失败 |

边界：fixture 对同一 IP 只延迟一次，所以旧清单与超预算变体在第一次重启后就能启动成功；真实环境里若依赖持续慢，这两种
情况会进入 CrashLoopBackOff。未注入超过 180s 的真实启动延迟（SDK 60s 超时封顶了 MCP 这一段），超预算行为以压缩预算的
变体为证。

## 五、CI 与分支保护（2026-09-19 查询 GitHub API）

- `main` 保护：必需检查 `Python (pytest)`、`Node Agent (tests + smoke)`、`Node BFF (tests + smoke)`、`Frontend (test + build)`、
  `Compose config`、`Cross-service smoke (no real LLM key)`；strict、线性历史、对管理员生效、禁止强推。
- `RPC contract (test + typecheck)` 与 `TypeScript exec (test + typecheck)` 在工作流里，但**不是必需检查**。
- 本分支工作流里 BFF job 名为 `Node BFF (tests + typecheck)`（2026-09-03 `76c006db` 改名），与必需的 `Node BFF (tests + smoke)`
  不一致：从本分支开 PR 时该必需检查不会上报，合并会一直等待。
- `main` 最新提交 `4dda7a9b` 的 6 个必需检查均 success（旧工作流，无 contract / exec job）。
- 本分支远端 = `480bf65d`，领先 main 137 个提交，没有 PR；工作流只在 push main 与 PR 时触发，**本分支没有任何远端 CI 结果**，
  本文与首轮证据中的全部测试结果都是本地容器结果，不能代替远端检查。未改动远端设置，未推送，未开 PR。

## 六、本轮测试与真实链路

| 项 | 结果 |
|---|---|
| agent：typecheck（宽松 + runtime strict）+ 全量测试 | 1413/1413 |
| pytest | 219 passed |
| 其余套件 | api-server / contract / exec / frontend 源码本轮未改，沿用首轮结果（165 / 118 / 420+1 skipped / 367 + build） |
| 脚本 | `node --check` scenarios.mjs、fake-llm.mjs；`bash -n up.sh` |
| `pi-dev` 真实链路（新镜像） | BFF / Agent 就绪 200；注册登录 → 建会话 → Run SUCCEEDED（bash×2、job_kill）→ 进程 logs / signal 200 → 跨租户 4 项 404 |

## 七、仍未覆盖

- 生产清单、资源与临时盘限制、网络边界、双集群与 VM 共享存储、UPDRDB / UPRedis / DBPM 故障切换、单 VM 备份恢复——
  均无目标环境材料，生产部署验收未完成。
- 远端 CI 未跑本分支；必需检查名不一致待处理。
- K4 只在本地 sim（OrbStack 单节点、Compose 依赖、fake-llm）验证；排空到期或依赖故障时仍在执行的工具，其 Run 需人工核对后取消，
  这是既有恢复规则，未改变。
