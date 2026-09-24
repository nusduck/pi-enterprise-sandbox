# 分层拓扑下的 Worker 重启 gate、C7 前台截止复验与插件树测试（2026-09-17）

补 [F1–F3 证据](follow-up-f1-f3-2026-09-16.md) §五与 STATUS C7 列为「未跑」的三件事：
分层队列（[ADR 0012](../adr/0012-depth-layered-run-queues.md)）下的 Agent Worker 重启 release gate、
执行编排收进 `guarded-execution.ts` 之后的内部 Shell 截止 / 取消复验、上一轮没能在 Linux 上跑通的
真实插件树测试。

## 验证对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm` / `1e1fc604`；未提交改动只有本次的 gate 测试、夹具与文档，无生产代码 |
| runtime | 容器内 Node v22.23.2（agent 镜像与 release gate 运行器均为 `node:22-slim`）；宿主 Node v22.23.2 跑链路脚本与 pytest |
| 重建的镜像 | `docker compose build agent agent-worker api-server sandbox sandbox-mcp`，全部来自 `1e1fc604` 的干净工作树 |
| 运行容器已换新 | 是。开工时运行中的 sandbox / sandbox-mcp 仍是 9-16 16:39 的镜像（早于 `6361ae91` 的 F1 修复），重建后逐个核对运行容器 image id：agent / agent-worker `a872704e3ceb`、sandbox `ee8f8288f4a8`、sandbox-mcp `3cd84b2db017`、api-server `8f582eb9a312`（后两个构建输入未变，镜像 id 与重建前相同） |
| 替身边界 | 开发栈：`dbpm-fake` 取密、MySQL 5.7、Redis 5.0.14。release gate 用专用 Redis 容器与 `pi_gate_dev*` 库，结束后已删除；gate 夹具只替换模型 / 工具执行器（为了制造可观察的副作用），Worker 组合根、BullMQ、MySQL 账本、恢复扫描均为生产代码。C7 探针与链路的执行面、HMAC、bwrap 均为真实组件；链路调用真实 LLMIO 网关 |

## 一、先复现：Agent Worker 重启 gate 自分层提交起就起不来

`scripts/dev/release-gates.sh`（未改动的 `1e1fc604`）：

| gate | 结果 |
|---|---|
| UPRedis 放行（直连 Redis 5.0.14） | 6 pass / 1 skip（负对照只在路由模拟下跑） |
| UPRedis 放行（路由模拟代理） | 7 / 7 |
| Redis 重启 | 4 / 4 |
| BullMQ Worker 重启 | 2 / 2 |
| **Agent Worker 重启** | **1 pass / 2 fail**，脚本退出码 1 |

两个恢复用例的 Worker 子进程都在启动时退出：

```
[agent-worker] BullMQ consumer failed to start — shutting down: AGENT_WORKER_CONCURRENCY must be
at least 3 so every subagent depth 0..2 keeps a reserved consumer slot; got 1.
```

根因：gate 夹具写死 `AGENT_WORKER_CONCURRENCY: '1'`。`de745e3c` 把它改成「全部层的总预算」并要求
≥ `maxDepth + 1`，gate 没有跟着改；`de745e3c` 与 `6361ae91` 的证据都把这组 gate 记为「未重跑」，
所以一直没人发现。`agent-worker-dsh-restart` gate 有同样的写死值。

## 二、修复与新增的分层用例

- 两个 gate 的并发改为 `3`（根层 1、d1 / d2 各 1），保持原 gate「根任务单槽」的形状。
- 夹具 `agent-worker-side-effect-process.js` 改为监听**每一层**消费者，`active` / `stalled` /
  `completed` / `failed` 事件带队列名，`ready` 在所有层就绪后才发，并列出全部队列。
- 新增用例 **`replays a depth-1 child Run on its own reserved layer after SIGKILL`**：
  种一个已结束的父 Run（深度 0）和一个 `QUEUED` 子 Run（深度 1，账本 `queue_name` 为 `-d1`），
  **不预先投递作业**。

  | 断言 | 证明什么 |
  |---|---|
  | Worker A 的 `ready.queueNames` = 根 / `-d1` / `-d2` | 三层消费者都起来了 |
  | 子 Run 的 `active` 事件来自 `-d1`；根队列里查不到该 jobId，`-d1` 里查得到 | 启动恢复扫描经唯一投递适配器按 MySQL 权威深度重投，没有落进根队列 |
  | 执行器进入后 SIGKILL，副作用尚未发生 | 在安全检查点之前崩溃 |
  | Worker B 的 `stalled` 与 `completed` 都来自 `-d1`，`attemptsStarted ≥ 2`、`stalledCounter ≥ 1` | 接管和重放发生在子 Run 自己那一层 |
  | Worker B 上没有任何其他层 `active` / `completed` 过这个子 Run | 根层不会抢走深层的作业 |
  | 账本终态 `SUCCEEDED`、`queue_name` 仍为 `-d1`、`run.retrying` 恰好 1 条、副作用只执行 1 次且由 B 执行 | 恢复后账本与投递目的地一致，无重复副作用 |

  父 Run 前台等待导致的槽位饥饿不在本用例范围，由 `subagent-slot-starvation.integration.test.js` 覆盖。

**修复后重跑** `scripts/dev/release-gates.sh`，退出码 0：

| gate | 结果 |
|---|---|
| UPRedis 放行（直连 / 路由模拟） | 6 pass + 1 skip / 7 pass |
| Redis 重启 | 4 / 4 |
| BullMQ Worker 重启 | 2 / 2 |
| **Agent Worker 重启** | **4 / 4**：安全检查点重放、未决副作用停在人工恢复边界、**深度 1 子 Run 分层重放**（另加一条资源安全检查），147 秒 |

**变异验证**：临时把 `container-run-queue.ts` 的 `resolveRunDepth` 改为恒返回 0（所有 Run 路由到根队列），
重建运行器后重跑。前两个用例仍通过，新用例失败：

```
not ok 3 - replays a depth-1 child Run on its own reserved layer after SIGKILL
  expected: 'release-gate-agent-worker-restart-d1'
  actual:   'release-gate-agent-worker-restart'
```

变异已还原（`git diff` 只剩测试与夹具）；三次运行后专用 Redis 容器与 `pi_gate_dev` / `pi_gate_dev_side` 均已删除。

## 三、C7：内部 Shell 截止与取消在当前 HEAD 上复验

这三项已于 2026-09-16 在 `99ef6b02` 上用真实 bwrap 通过（[证据 §一](exec-resource-limits-and-shell-contract-2026-09-16.md)），
但 `6361ae91` 之后内部路由改走共用的 `runGuardedForeground`，那一版证据只重跑了 MCP 窄桥的断连。
探针在 **agent 容器内**用生产 `RemoteShell` + `ExecRpcClient`（真实 HMAC keyring）打真实 sandbox 的
`/internal/v1/shell/run`，先 `sessions/ensure` 初始化探针专用工作区。**5 / 5 通过**：

| 断言 | 结果 |
|---|---|
| `setup` | 工作区初始化后命令可执行 |
| `C7_20s_within_120s_budget` | `sleep 20` 在 120 秒预算内成功：`exitCode 0`、`timedOut false`、20 042 ms，文件已写入 |
| `C7_short_budget_stops_writes` | 预算 4 秒、`sleep 20; echo LATE > 文件`：4 022 ms 返回 `timedOut true`，22 秒后文件 `ABSENT` |
| `C7_cancel_leaves_no_write` | 3 秒时客户端 abort：3 012 ms 抛出取消错误，22 秒后文件 `ABSENT`，新沙箱内无残留 `sleep 20` |
| `C7_control_writes` | 正对照：不取消、预算充足的同形命令写入成功（`PRESENT`），排除「什么都写不进去」的假通过 |

探针工作区用完即删；探针脚本不入库（与前几轮同为一次性工具）。

## 四、真实插件树测试在 Linux 上通过

上一轮 `boot.test.ts`、`mcp-live.test.ts`、`agent-version-policy-live.test.ts`、
`agent-version-wire-request.test.ts`、`policy-install.test.ts` 在「宿主仓库挂进 `node:22-slim`」的环境里
插件树加载失败（该环境的 `node_modules` 是 darwin 构建，失败的具体原因当时未查明）。这次改在**重建后的生产 agent 镜像**里跑（Linux 依赖、uid `node`、
`--network none`）：

```
docker run --rm --network none --entrypoint sh -w /app/agent pi-enterprise-agent:latest \
  -c 'npx tsx --test tests/runtime/boot.test.ts tests/runtime/mcp-live.test.ts \
      tests/runtime/agent-version-policy-live.test.ts tests/runtime/agent-version-wire-request.test.ts \
      tests/runtime/policy-install.test.ts'
```

**41 / 41 通过，0 skip / 0 cancelled**。其中包括「boot 之后实际挂载的是自建实现，不是出厂实现」
「H7.8 真实 MCP 服务器：连上 → 注册成 `mcp__<server>__<tool>` → 调得通」。同一批用例在 Linux 依赖齐全的镜像里通过，上一轮的失败与该挂载环境相关。

## 五、完整真实链路（经 BFF `http://127.0.0.1:4000`，重建后的栈）

**11 / 11 通过**：

| 步骤 | 结果 |
|---|---|
| 注册 A、B / `/api/auth/me` | 200 / 200 / 200 |
| 建会话 | 201，`conversation 01M2Q5G074GTKESEB1XAG6MZ1K` |
| 带工具的 Run | 202 → `SUCCEEDED`（`01M2Q5G08R91E0NVD9EDK9S5D9`），工具台账 `["bash:succeeded","bash:succeeded"]` |
| 后台进程 | `bash-bf96a24963a540778fe5ffd33b496851` 列出，logs 含 `TICK-1…TICK-5` |
| `SIGTERM` | 200 → 终态 `cancelled` |
| 跨租户 404 | run / conversation / tools / process 四项 B 均 404，A 本人同一入口均 200 |

## 六、离线检查

| 项 | 结果 |
|---|---|
| `uv run pytest -q` | 207 passed |
| 两个改动的 gate 文件，不开启时（宿主 Node 22） | 2 / 2（安全检查用例），live 部分按设计跳过 |

本次没有改生产代码，未重跑六套业务测试与各包类型检查（gate 测试与夹具是 JS，不在 `tsc` 范围内）。

## 七、未覆盖与已知限制

- **`agent-worker-dsh-restart` gate 未跑。** 并发值已同步改为 3，但它需要独立的 sandbox 容器、共用 gate 库与
  HMAC 资源，不在 `release-gates.sh` 内；[2026-09-14 证据](release-gates-docker-2026-09-14.md)同样记为未跑，本分支上未找到运行记录。STATUS G2 引用的「5/5」是 2026-07-19
  Pi 时代的旧证据。
- 「某一层消费者挂掉 → `/ready` 不就绪」、依赖守卫逐层 pause / resume 仍只有单元级证据。
- 多 Worker 副本的横向容量、旧镜像回滚演练同 F1–F3 证据，未做。
- exec 的 4 例需要 bwrap 且非 root 的单测（`isolation-bubblewrap` capability 断言等）没有另找环境重跑；
  本文 §三 与既有证据覆盖的是同一隔离层的真机行为，不等于这些单测已通过。
- 目标环境（真实 UPDRDB / UPRedis / DBPM / 双集群 / 麒麟 VM）验收未做。
