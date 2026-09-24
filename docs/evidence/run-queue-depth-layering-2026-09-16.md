# Run 队列按子任务深度分层（2026-09-16）

对应 [审查 R3](../reviews/2026-09-16-agent-worker-sandbox/README.md) 与
[ADR 0012](../adr/0012-depth-layered-run-queues.md)。

## 验证对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，在 `dcc05625`（R1/R2/R4/R5/R6 的证据提交）之上 |
| runtime | 宿主 Node v22.23.2（`/opt/homebrew/opt/node@22/bin`）；容器内 v22.23.2 |
| 重建的镜像 | `pi-enterprise-agent`（agent + agent-worker 共享） |
| **未**重建 | `enterprise-sandbox` / `-mcp` / `pi-enterprise-api`（`exec/`、`api-server/` 本次未改） |
| 运行容器已换新 | 是。worker 启动日志打出了本次才有的分层计划行 |
| 替身边界 | 开发栈用 `dbpm-fake` 取密、MySQL 5.7 / Redis 5.0.14 容器。下面第一节的实验**不用**替身队列：真实 BullMQ、真实 Redis；只有「执行什么」是受控屏障（父作业前台等子作业），因为要验的是调度不是模型 |

## 一、先复现：真实 BullMQ 上的槽位饥饿

`agent/tests/redis/subagent-slot-starvation.integration.test.js`，
`TEST_REDIS_URL` 指向开发栈 Redis 的 db 3，每次实验用独立 hash-tag prefix
并在收尾 `obliterate`。**3 / 3 通过**：

| 用例 | 结果 |
|---|---|
| **基线（旧形态）**：父子同队列、总预算 2、两个前台等待的父作业 | 6 秒内 **0 个子作业被消费、0 个父作业完成**——饥饿如实复现。这是修复前的形态，不是修复后的回归 |
| **分层 + 保留槽**：同一个总预算 2，按 ADR 0012 分成 d0=1 / d1=1 | 两个子作业全部被消费、两个父作业全部完成，耗时 **188 ms**。没有扩容、没有取消父任务、没有等预算耗尽 |
| **逐层保留**：预算 3、最大深度 2 → 1 / 1 / 1，depth0 等 depth1、depth1 等 depth2 | 整条链自底向上排空，顺序 `root.c.c` → `root.c` → `root`，耗时 145 ms |

## 二、真机：分层消费者真的按计划起来了

`agent-worker` 启动日志（重建镜像并换容器后）：

```
[agent-worker] BullMQ consumers started budget=4 d0:agent-runsx2 d1:agent-runs-d1x1 d2:agent-runs-d2x1 recovery=ok
```

`/ready`（判定已收紧为「**每一层**消费者都在跑」）：

```
200 {"status":"ready","started":true,"shutting_down":false,"consumer":"running","mysql":"ok","redis":"ok"}
```

## 三、真机：子 Run 真的走了 d1 队列

经 BFF 的真实链路（真实模型），让模型用 `subagent` 工具派发一个子任务：

| 步骤 | 结果 |
|---|---|
| 建会话 | `conversation 01M2N16B31BHNFTGYK1S7CRP40` |
| 父 Run | `01M2N16B5QWZMWY427016A8B57` → `SUCCEEDED`，工具台账 `["subagent:succeeded"]`，12.2 秒 |

MySQL 里的两行（账本）：

```
run_id                      parent_run_id               depth  queue_name       status     source
01M2N16B5QWZMWY427016A8B57  NULL                        0      agent-runs       SUCCEEDED  api
01M2N16HBMJ4W9SSTHF68XVM4W  01M2N16B5QWZMWY427016A8B57  1      agent-runs-d1    SUCCEEDED  subagent
```

Redis 里的投递计数（BullMQ 每投递一个作业 `id` 计数器 +1，`removeOnComplete`
之后计数器仍在）——证明目的地不只是账本上写着，而是**真的投了**：

```
{bull}:agent-runs:id      = 30
{bull}:agent-runs-d1:id   = 1     ← 这一次子 Run
{bull}:agent-runs-d2:id   = (不存在，从未使用)
```

`agent-runs-d1` 的 `events` / `meta` / `stalled-check` key 都已建立，`agent-runs-d2`
只有消费者建的 `meta` / `stalled-check`（消费者在跑，但没收到过作业）。

## 四、真机：回滚闸门（含正对照）

往 `{bull}:agent-runs-d2:wait` 塞一个作业，再用 `AGENT_SUBAGENT_MAX_DEPTH=1`
起一个一次性 worker：

```
[agent-worker] fatal: refusing to start: these Run queues still hold jobs but no
configured layer consumes them: agent-runs-d2=1. Drain them (or restore the
matching AGENT_SUBAGENT_MAX_DEPTH) first.
```

**正对照**：删掉那个 key（排空）后，同一配置正常启动，并按新的 maxDepth 重新
分配预算（4 → 3 / 1）：

```
[agent-worker] BullMQ consumers started budget=4 d0:agent-runsx3 d1:agent-runs-d1x1 recovery=ok
```

## 五、真机：fail-closed 的预算校验抓到了一个真实的部署问题

第一次重建后 `agent` HTTP 容器**拒绝启动**：

```
[agent-server] fatal: AGENT_WORKER_CONCURRENCY must be at least 3 so every
subagent depth 0..2 keeps a reserved consumer slot; got 1.
```

两件事：

1. **本机 `.env` 里 `AGENT_WORKER_CONCURRENCY=1`。** 在旧代码下这意味着
   「文档承诺的 depth-2 子任务链在这台开发栈上从来不可能跑通」——唯一的槽被
   前台等待的父 Run 占住就是死锁。闸门把这个长期存在、但一直没人发现的配置
   问题变成了一条启动错误。已把本机 `.env` 改为 `4`（该文件 gitignored，属于
   运维侧配置，不进仓库）。
2. **同时暴露了我自己的一个设计错误并已修正**：第一版把「槽位预算校验」放在
   投递方与消费方共用的路径上，于是只投递、不消费的 HTTP 进程也被一个它用不上的
   变量卡住。现在拆成两步——`planRunQueueTopology()` 只算路由（有哪些层、叫什么），
   `allocateReservedSlots()` 才做槽位分配与预算校验，只有 `agent-worker` 调用它。

## 六、完整真实链路（经 BFF）

| 步骤 | 结果 |
|---|---|
| 登录 / 建会话 | 200 |
| 一轮带工具的 Run | `SUCCEEDED`，工具台账 `["bash:succeeded"]` |
| 后台进程 | `bash-66b462fdf8eb4f648cde8ef4bbe76802`，logs 含 `TICK-1…TICK-5` |
| `SIGTERM` | 200 → `killed: SIGTERM` → 终态 `cancelled` |
| 跨租户 404 | run / conversation / tools / process 四项 B 均 404，**A 本人同一入口均 200** |

## 七、离线测试与类型检查

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 206 passed |
| `npm test --prefix contract` | 118 pass / 0 fail |
| `npm test --prefix exec` | 411 pass / 0 fail / 2 skipped |
| `npm test --prefix agent` | 1357 pass / 0 fail / 0 cancelled |
| `npm test --prefix api-server` | 160 pass / 0 fail / 0 cancelled（连跑三次稳定） |
| `npm test --prefix frontend` | 367 pass / 0 fail |
| `npm run build --prefix frontend` | 通过 |
| 类型检查 | contract / exec / api-server / agent（主程序 + `src/runtime` strict）全部通过 |
| `docker compose config -q` | 通过 |

## 八、未覆盖与已知限制

- **本次没有实现通用的子任务 park/replay。** 父任务等待子任务期间仍然占着
  它那一层的槽，只是拿不到别的层的槽了。深度 0 的槽被 N 个互相无关的父任务
  占满时，第 N+1 个根任务仍然排队——那是正常的容量排队，不是死锁。理由与
  取舍见 ADR 0012。
- **「某一层消费者挂掉 → `/ready` 不就绪」只有单元级证据**（`consumerRunning`
  要求 `every()`）。没有在真机上杀掉单独一层的消费者做验证——BullMQ 的
  Worker 在同一进程内，单独打掉一层需要额外的注入面，本次没做。
- **Worker 重启 release gate 未按分层拓扑重跑**（`agent-worker-restart.release-gate.test.js`
  等，需要隔离的 MySQL/Redis）。STATUS G2 的状态不变。
- **依赖守卫的暂停 / 恢复对全部层生效**只有代码与单测层面的保证，没有在真机上
  拔依赖验证逐层 pause。
- 本次真机是单 Worker 进程。多 Worker 副本下各自持有一份 2/1/1，总容量是副本数
  的倍数——这一点在 deployment.md 里没有单独展开，横向扩缩容的容量规划未验证。
- 目标环境（真实 UPDRDB / UPRedis / DBPM / 双集群 / 麒麟 VM）验收仍未做。
