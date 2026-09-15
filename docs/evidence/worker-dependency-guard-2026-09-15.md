# 验证记录：Agent Worker 依赖不可用时暂停取任务

日期：2026-09-15。用户决定：Worker 未就绪时暂停从 BullMQ 取任务。对应
[统一 design](../design/updrdb-dbpm-deployment.md) §9.2（「readiness=false 本身不会停止 BullMQ，应用还必须暂停取得新任务」）。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`ea14af14` + 本次未提交改动（随本证据同一 commit） |
| 依赖 | bullmq 5.80.7（agent lockfile） |
| 单测运行时 | **宿主 Node v23.11.0**；`uv run pytest` Python 3.11 |
| 运行栈 | 开发 Compose + `updrdb-sim` + `upredis-sim`；MySQL 故障以停止两个 UPDRDB Proxy 模拟 |
| 镜像 | `pi-enterprise-agent` `e5f39df6af13`（agent / agent-worker 均换新） |

## 实施过程中的发现

第一版只在依赖连续失败时调用 `worker.pause(true)`。开发栈实测暂停与恢复本身正确，但**暂停期间入队的作业仍被执行**：

| 场景（第一版） | 结果 |
|---|---|
| 停双 Proxy | 约 11s 后日志 `dependencies unavailable (mysql); paused BullMQ consumer`，`/ready` 503 `consumer: paused` |
| 暂停中入队一个作业 | 立即被处理并失败：`Run … needs reconciliation (status=UNKNOWN): agent-knex: all endp…`（MySQL 不可用时执行） |
| 恢复 Proxy | 约 8s 后 `resumed BullMQ consumer`，`/ready` 200 |

（同一轮之前还有一次入队脚本本身失败：测试用 ULID 含 `U` / `O`，不是合法 Crockford ULID，作业没有入队；该轮的「作业已不存在」结论作废。）

根因（阅读 `node_modules/bullmq/dist/esm/classes/worker.js`）：主循环 `await fetchedJob` 等待已发出的阻塞取任务（bzpopmin）；
`pause(true)` 只置 `paused` 标志、停止 stalled 检查，不打断在途的取任务，取回的作业随后照常 `processJob`。只有不带参数的
`pause()` 会经 `whenCurrentJobsFinished` 断开阻塞连接，但它同时等待全部在跑任务结束（可能数分钟），且 Redis 不可达时的重连行为不确定，未采用。

修复：保留 `pause(true)` 停止取任务循环；作业处理外壳在执行前检查 `worker.isPaused()`，暂停中调用 `job.moveToDelayed(now + 探测间隔, token)`
并抛 `DelayedError`（BullMQ 视为非失败，不消耗 attempts），恢复后再执行。

## 改动要点

- `agent/src/bootstrap/worker-dependency-guard.ts`：探测间隔 `AGENT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS`（默认 5000，500–600000，非法拒启）；
  串行探测；连续 2 次失败暂停、连续 2 次成功恢复，只恢复自己造成的暂停；暂停调用失败下一轮重试；`stop()` 不恢复。
- `worker-probe.ts`：`pingDependencies` 供 `/ready` 与守卫共用；`/ready` 报 `consumer: running | paused | stopped`，暂停时 503。
- `run-queue.ts`：抽出 `createRunJobHandler`（校验引用 → 暂停中延后 → 追踪 → 处理器），`createRunWorker` 新增 `shouldDefer` / `deferDelayMs`。
- `worker-main.ts`：启动前校验间隔；消费者启动后启动守卫；`shouldDefer` 接 `worker.isPaused()`；关停时先停守卫。
- 文档：`deployment.md`（探针表、守卫与延后说明、变量表）、`.env.example`、design §9.2、CHANGELOG。

## 验证结果

| 项 | 环境 / 命令 | 结果 |
|---|---|---|
| 守卫 / 处理外壳 / 探针 / worker-main 单测 | 宿主 `npx tsx --test` 5 个文件 | 30/30：一次失败不暂停、连续两次暂停；抖动恢复不恢复、连续两次恢复；不恢复非自己造成的暂停；探测抛错按不可用；暂停失败重试；探测不重叠、`stop` 不恢复；间隔解析；暂停中作业 `moveToDelayed(now+延迟, token)` 并抛 `DelayedError` 且不调用处理器；未暂停照常执行；非法引用先拒绝；放回失败时不执行；`/ready` 区分 paused / stopped；worker-main 传入 `shouldDefer` 与默认 5000 |
| agent | 宿主 `npm test` + `npm run typecheck` | 1328 / 1325 pass / 0 fail / **3 cancelled**（remote-shell / exec-rpc 已知组，不记为通过）；typecheck 退出码 0 |
| 仓库卫生 | 宿主 `uv run pytest -q` | 171 passed |

回归用例与修复同批编写；修复前的失败证据是上表第一版在运行栈上的实测。

## 运行栈（修复后镜像）

| 场景 | 结果 |
|---|---|
| 基线 | Worker `/ready` 200，`consumer: running` |
| 停双 UPDRDB Proxy | 约 11s 后 `/ready` 503，`consumer: paused`，`mysql: unavailable` |
| 暂停中入队作业 `01JQ5RBE789455741000000000` | 入队瞬间为 `active`（在途取任务拿到，即上述根因）；随后 5s / 10s / 15s / 20s 采样均为 `delayed`，未执行、未失败 |
| 恢复 Proxy | 约 7s 后 `dependencies recovered; resumed BullMQ consumer`，`/ready` 200、`consumer: running` |
| 恢复后作业 | 被执行，失败原因为 `Run not found`（数据库可达，作业引用的 Run 是虚构的）；对照修复前 `agent-knex: all endp…` |

## 真实链路（修复后镜像，经 `api-server:4000`）

| 步骤 | 结果 |
|---|---|
| 注册 / 登录 | 200 / 200 |
| 带工具 Run | `SUCCEEDED`，`bash:succeeded` |
| 后台进程 | logs 200，`TICK-1…TICK-5`；`SIGTERM` 200，最终 `cancelled` |
| 跨租户 | B 访问 A 的 run / conversation / tools / process 全 404；A 全 200 |

## 未做 / 边界

- 只模拟了 MySQL 不可用；Redis 不可用时的暂停（此时取任务本身也不可达）与 `moveToDelayed` 失败路径只有单测覆盖。
- 暂停期间在跑的 Run 不被打断，仍由既有 lease / fence 兜底，未在本次演练中构造在跑任务。
- 虚构 Run 的作业恢复后以 `Run not found` 失败并保留在 failed 集合（`removeOnFail: 100`），开发队列中残留该条记录。
- Cron 调度、outbox 发布与恢复扫描不暂停，按设计各自单轮失败、下一轮重试。
- 单测在宿主 Node v23.11.0 上运行，未在容器内复跑；api-server、contract、exec、frontend 本次无改动，未重跑。
