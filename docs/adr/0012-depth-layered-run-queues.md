# ADR 0012: Run 队列按子任务深度分层，每层保留消费槽

| 字段 | 值 |
|---|---|
| 状态 | **Accepted / Implemented**（2026-09-16） |
| 日期 | 2026-09-16 |
| 决策所有者 | Agent runtime maintainers |
| 适用范围 | `agent/src/infrastructure/redis/run-queue-topology.ts`、`agent/src/bootstrap/container-run-queue.ts`、`agent/src/bootstrap/{container,worker-main}.ts`、`agent/src/application/subagent-spawn-service.ts` |
| 关联文档 | [审查报告 R3](../reviews/2026-09-16-agent-worker-sandbox/README.md)、[执行方案 PR 3](../reviews/2026-09-16-agent-worker-sandbox/implementation-plan.md) |

---

## 背景

2026-09-16 的审查（R3，P1）指出：**等待子 Run 的父 Run 可以耗尽同队列全部
消费槽**。

父子 Run 用同一个 BullMQ 队列（`agent-runs`）、同一批消费槽。`durable-subagent`
provider 的 `result` 是**前台等待**——父任务 `await` 子 Run 的结果，自己不让出
BullMQ 槽位（当前 manifest 配 `backgroundMode: 'one-shot'`，已安装的 DSH
subagent 工具默认就是前台等待）。于是：

1. N 个父 Run 先占满单 Worker 的 N 个槽；
2. 每个父 Run 各自发起一个子 Run；
3. 子 Run 进同一个队列，但槽全被父 Run 占着；
4. 父 Run 在等子 Run，子 Run 在等槽——**互相等**。

只能靠父任务取消/超时或临时加消费者打破。把并发从 4 提高到任意有限值都有
同样的饱和条件：这不是容量问题，是**调度里没有保证进展的性质**。

真实 BullMQ 上的复现见
`agent/tests/redis/subagent-slot-starvation.integration.test.js`
第一条用例：总预算 2、两个前台等待的父任务，6 秒内 0 个子任务被消费、
0 个父任务完成。

## 决策

**按 `subagent_depth` 分层：每个允许的深度一个队列，每层有专属的保留消费槽。**

- 队列名：深度 0 是 `agent-runs`（沿用历史名字），深度 n 是 `agent-runs-d{n}`。
- 槽位分配：`AGENT_WORKER_CONCURRENCY` 是**总预算**，每个深度 ≥ 1 的层恰好
  保留 1 个槽，剩余全部给深度 0。最大深度 2、预算 4 → **2 / 1 / 1**。
- 预算不足以给每层留一个槽（`totalConcurrency < maxDepth + 1`）时**拒绝启动**，
  不把某层降成 0 个消费者——那等于把饥饿从「父等子」换成「子永远没人消费」。
- 路由只看 **MySQL 里的权威 `subagent_depth`**。唯一的 enqueue 适配器
  （`ServiceContainer.createRunQueueAdapter()`）在投递前按主键读一次深度；
  调用方或模型提交的队列名、深度提示一律不采信。
- `runs.queue_name` 与实际目的地由**同一个函数**从同一个权威深度算出，
  账本记的和投递的不会分叉。
- 越界深度**拒绝投递**，不夹到最深那层——那会让一个本不该存在的 Run 挤占
  保留槽，还掩盖上游深度校验的漏洞。

## 为什么不是别的方案

**A. 等待子任务时持久化并让出消费槽（park / replay）。** 这是更彻底的解法，
也是长期方向。但当前 Run 状态机只有 `WAITING_APPROVAL` / `WAITING_INPUT`
两种停泊语义，两者都对外可见、都有产品含义（审批中 / 等用户输入）。
把「等子任务」塞进其中任何一个都会污染对外状态与前端展示；新增一种完整的
park/replay 则涉及状态迁移、持久化 continuation 与**模型侧重放**——那是一个
独立的设计，不该夹在一次缺陷修复里。

**B. 提高并发。** 无效。任何有限的 N 都有 N 个父任务同时等待的饱和条件。
审查报告对这一点有明确结论。

**C. 只拆「父队列 / 子队列」两层。** 不够。深度 1 的子任务也会发起深度 2 的
子任务并前台等待它；两层时深度 1 会把自己的槽占满等深度 2，饥饿只是下移了
一层。所以按**完整的有限深度**分层。

## 代价（必须写进部署文档）

**根任务的同时执行量下降。** 同一个 `AGENT_WORKER_CONCURRENCY=4`：

| | 分层前 | 分层后（maxDepth=2） |
|---|---|---|
| 根任务并发 | 4 | **2** |
| 深度 1 并发 | 与根任务抢 | 1（专属） |
| 深度 2 并发 | 与根任务抢 | 1（专属） |

要恢复原来的根任务**槽数**，把 `AGENT_WORKER_CONCURRENCY` 提到 `6`（→ 4 / 1 / 1；
槽数相同不等于已证明吞吐相同），
或者降低 `AGENT_SUBAGENT_MAX_DEPTH`。**不要**指望默认值同时给出旧的根吞吐和
新的进展保证——预算是显式的，不按层翻倍。

## 迁移与回滚

**升级不需要排空。** 深度 0 沿用 `agent-runs`：升级前按旧规则投进该队列的子
Run 仍由深度 0 的消费者处理（处理器与深度无关），不会有作业被落下。

> **2026-09-16 修订**（修复后复核 F2/F3）：下面的闸门描述与步骤 1 已不准确，以文末
> 「修订记录」与 [deployment.md](../deployment.md) 为准——闸门同时查 MySQL 账本、读失败即拒启，
> 且旧镜像没有闸门。

**回滚必须先排空。** 换回旧镜像或调小 `AGENT_SUBAGENT_MAX_DEPTH` 之后，没有人
消费 `agent-runs-d1` / `-d2`。为此 Worker 在启动时反向检查一遍：**本配置不服务
的层里还有存量作业就拒绝启动**，并在错误里点名队列与条数。所以回滚步骤是：

1. 停止投递新的子任务（暂停接新 Run，或把 `AGENT_SUBAGENT_MAX_DEPTH` 降到 0
   使新的 spawn 被拒）；
2. 等分层队列排空（可用启动闸门的报错反过来确认：还有存量时它会拒绝）；
3. 再换回旧镜像。

**禁止新旧消费者同时搬运**：不要为了「过渡」让旧镜像和新镜像同时在跑，那会让
同一个子 Run 出现在两套路由规则下。

## 不变量

- 每个允许的深度至少有一个专属消费槽；根任务拿不到深层的保留槽。
- 并发总预算是一个显式数字，各层之和恒等于它。
- 路由权威只有 MySQL 的 `subagent_depth`。
- 任何一个必需层的消费者不在跑 → `/ready` 不就绪（`consumerRunning` 要求
  **每一层**都在跑）；依赖守卫的 pause / resume 对**全部层**生效。
- runId / resume 专用 jobId 的幂等约定、lease / fence / cancel 语义不变——
  分层只改「投到哪个队列」，不改作业标识与状态机。

## 仍然开放

- 这条决策**没有**实现通用的子任务 park/replay。父任务等待子任务期间仍然占着
  它那一层的槽，只是拿不到别的层的槽了。深度 0 的槽被 N 个互相无关的父任务
  占满时，第 N+1 个根任务仍然要排队——那是正常的容量排队，不是死锁。
- 若将来把 subagent 改成后台形态（父任务不再前台等待），本 ADR 的分层可以保留
  也可以退役；退役时按上面的回滚步骤走。

## 修订记录

**2026-09-16，修复后复核 F2 / F3**（[复核](../reviews/2026-09-16-agent-worker-sandbox/follow-up-review.md)）。
决策（分层 + 保留槽）不变，迁移闸门的实现与步骤修正如下：

- **读失败不再当作空。** 第一版把 Redis 异常按 0 处理，理由是「额外保护不该成为新
  故障点」。但闸门只在启动时跑一次，跳过后没有任何东西重做检查。现在只有 key 不存在
  才算 0；读异常、不认识的 key 类型、查库失败都拒启。
- **闸门同时查 MySQL 权威账本**：`runs` 里超出目标深度的非终态 Run。等待审批 / 输入
  的子 Run 在队列里没有作业，只查 Redis 会放行，恢复入队时再被越界拒绝。
- **闸门先于恢复扫描、cron、outbox 与消费者**，拒启时没有副作用。实现在
  `agent/src/bootstrap/worker-drain-gate.ts`。
- **步骤 1 更正**：`AGENT_SUBAGENT_MAX_DEPTH` 同时决定消费拓扑，不能用「先降到 0」
  来停止 spawn；应暂停接新 Run 或用 AgentVersion `configJson.subagent` 收紧。
- **旧镜像没有这道闸门**。换回分层前的镜像必须在外部确认分层队列为空，不能以
  「旧镜像启动不报错」代替；具体命令见 deployment.md。
