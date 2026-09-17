# 真实 DSH Worker / Sandbox 中断 release gate 重写与首次运行（2026-09-17）

对应 STATUS G2。`agent/tests/redis/agent-worker-dsh-restart.release-gate.test.js` 是 Pi 时代的 gate，
2026-09-03 只改了文件名；[2026-09-14 证据](release-gates-docker-2026-09-14.md)与
[同日上午的证据](worker-restart-gate-layered-and-c7-recheck-2026-09-17.md)都记为未跑，本分支上没有运行记录。
G2 引用的「5/5」是 2026-07-19 Pi 运行时下的结果。

按用户决定（2026-09-17）：**场景 1–3 按当前 DSH 架构重写并跑通；场景 4（执行中重启 sandbox）只摸现状、
不改生产语义**，结果交给后续决策。

## 验证对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm` / `076241bf`；未提交改动只有本 gate 测试、新脚本与文档，无生产代码 |
| runtime | 运行器 `node:22-slim`，Node v22.23.2 |
| 被测组件 | 生产 Worker 组合根（`startWorkerMain`，不注入 RunExecutor）+ 真实 DSH 运行时 + 真实 BullMQ / MySQL 账本 + 独立 sandbox 容器（`enterprise-sandbox:latest` = `ee8f8288f4a8`，真实 HMAC 内部面与 bwrap） |
| 替身边界 | 模型是受保护的假 OpenAI 兼容服务（`tests/support/fake-openai-provider.js`），按脚本返回文本 / 工具调用并可挂起请求；DBPM 用本机假 DBPM；工具派发边界用一个转发代理拦住首个 `/internal/v1/shell/run` |
| 资源 | 专用库 `pi_gate_dsh`（按发布 DDL 建表）、专用 Redis `pi-release-gate-redis-dsh`、专用 sandbox `pi-release-gate-sandbox-dsh`，均由脚本创建并在结束时删除 |

## 一、为什么要重写：Pi 时代的假设在 DSH 下不成立

| 旧 gate 的假设 | 现在的事实 |
|---|---|
| 测试里 `migrateRollbackAll` + `migrateLatest` | 服务不迁移，sandbox 启动时按清单核对；在运行中的 sandbox 下回滚会拆掉 exec 的表。改为脚本先跑发布 DDL，测试只确认是空库 |
| 拦截 `/internal/v1/executions/bash` | 该端点已随 Python 执行面删除，当前是 `/internal/v1/shell/run` |
| 断言 `sandbox_executions` 表 | 表已删除；exec 侧的 `exec_executions` 仓储没有任何调用方，前台命令不落执行记录。改为以工作区里的副作用文件为证，并加正对照 |
| 所有模型请求都算作一次 Agent 轮次 | DSH 每轮另发一次不带工具的「生成会话标题」请求；只统计带工具的请求 |
| `ask_user` 工具、`interaction_type/title/options` 参数 | 出厂工具名 `ask_user_question`，参数为 `questions[]` |
| `bash` 参数 `command` + `timeoutSeconds` | 必填 `description`，超时字段是 `timeoutMs` |
| `AGENT_SESSION_WORKSPACE_CWD` 指向运行器本地临时目录 | DSH 把它作为逻辑工作区根发给 exec，沙箱里没有这个目录（`bwrap: Can't chdir`）；与 Compose 一致改为 `/home/sandbox/workspace` |

## 二、结果：`scripts/dev/release-gate-dsh-restart.sh`，5 / 5，退出码 0

| 用例 | 结果与关键断言 |
|---|---|
| 资源安全检查 | 专用容器名 / `pi_gate_*` 库 / HMAC 齐全才运行 |
| **1. 模型调用中 SIGKILL Worker** | 假模型挂起首个 Agent 轮次请求 → Run `RUNNING`、Redis lease 存在 → SIGKILL → Worker B 恢复扫描 `projected_and_enqueued` → `SUCCEEDED`。Agent 轮次请求恰好 2 次（中断 1 + 重放 1），`run.retrying` 恰好 1 条，无工具账本 |
| **2. `ask_user_question` 停泊后 Worker 重启** | 首个 Worker 只问一次 → `run_interactions` PENDING、Run `WAITING_INPUT`、lease 释放 → SIGKILL → `InteractionResponseService` 重新水合并回答 `eu` → Worker B 处理续跑作业 → `SUCCEEDED`；interaction `RESOLVED/APPLIED`，快照含续跑结果，续跑只再请求模型 1 次，账本 1 行 `SUCCEEDED`，`interaction.resolved` 1 条 |
| **3. 工具派发边界 SIGKILL** | 代理拦住 `shell/run` 后 SIGKILL → Worker B 恢复扫描 `needsReconciliation`（`durable tool execution outcome is unresolved (PROPOSED); manual recovery required`）；Run 仍 `RUNNING`，账本行未被改动，模型只被请求 1 次，无 `run.retrying`；等待 3 秒后工作区里 `dispatch-boundary-marker.txt` **不存在**。**正对照**：经真实内部面在同一工作区写 `dispatch-boundary-control.txt`，检查结果为存在 |
| **4. 命令执行中重启 sandbox（现状探针）** | 确认 `sleep 20; printf LATE > …` 已在 sandbox 里运行后 `docker restart --time 10`。断言：工具账本到达终态、只有 1 行；越过原命令写文件的时间点后标记文件**不存在**（没有自动重跑、没有补写） |

**变异验证**：临时把 `PROPOSED` 加进 `run-recovery-service.ts` 的 `REPLAY_SAFE_TOOL_STATUSES`
（恢复时视为可以安全重放）后重跑脚本：场景 3 失败——Worker B 以
`lease-free run replayed from durable session state` 重新入队并再次激活作业，没有进入人工恢复；
场景 1、2、4 仍通过。变异已还原，`git diff agent/src` 为空，专用资源已删除。

## 三、观测到的现状（未改语义，待决策）

### 3.1 工具派发时账本停在 `PROPOSED`

场景 3 SIGKILL 前的账本：`status=PROPOSED request_hash=null execution_fence_token=null`，而请求已经发往执行面。

- `agent/src/runtime/policy/install.ts:387` 在 `tools/execute` 里先 `await ledger.started(...)` 再执行工具；
- `agent/src/application/fenced-tool-governance-recorder.ts:1009` 在行没有策略指纹时刻意不推进到 `RUNNING`，
  注释是「Pi emits this notification before beforeToolCall. Leave a side-effect-free placeholder for policy to adopt」。
  DSH 下策略判定（`tools/pre-execute`）先于 `tools/execute`，低风险工具不会再有策略来「接管」这一行，
  于是整个执行期间账本都停在 PROPOSED，也没有绑定请求指纹与 fence。

**安全性质仍成立**：恢复逻辑只把 `SUCCEEDED/FAILED/CANCELLED` 视为可重放，PROPOSED 按未决处理、交人工恢复
（变异验证证明了这一点是 gate 真正在钉的）。偏差在于账本的准确性：「已派发」与「从未派发」的 PROPOSED 无法区分，
Pi 时代「派发前落 RUNNING + request_hash + fence」的边界在 DSH 下没有兑现。

### 3.2 exec 中途重启时工具记为普通失败

场景 4 的观测：`tool=FAILED/TOOL_ERROR`，模型收到的工具结果只有 `"fetch failed"`，Run 继续并 `SUCCEEDED`，
没有 `run.retrying`，Agent 轮次请求 2 次。

Pi 时代的设计是 exec 侧执行记录与 Agent 工具都记 `UNKNOWN`、交人工对账。现在命令可能已经部分执行，
模型却只看到一个传输错误，下一步可以自行决定重试——本次假模型没有重试，但真实模型可能会。
「应记 UNKNOWN（停下对账）还是 FAILED（交给模型）」需要决策；gate 目前只钉两种语义下都必须成立的性质。

## 四、离线检查

| 项 | 结果 |
|---|---|
| `uv run pytest -q` | 207 passed |
| `bash -n scripts/dev/release-gate-dsh-restart.sh` | 通过 |

没有改生产代码，未重跑六套业务测试与类型检查。

## 五、未覆盖与已知限制

- 场景 4 只在「docker restart，10 秒宽限」下观测；SIGKILL 级的 exec 崩溃、网络分区未测。
- 3.1 / 3.2 两处语义未决，G2 不据此标为 `done`。
- 多 Worker 副本、目标环境（UPDRDB / UPRedis / DBPM / 麒麟 VM）上的中断行为未验证。
