# 工具派发边界落 RUNNING + 执行面断连记 UNKNOWN（2026-09-17）

修复 [DSH 中断 gate 证据](dsh-restart-gate-rewrite-2026-09-17.md) §三记录的两处偏差，用户同日确认「按设计来」。
对应 STATUS G2。

## 验证对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm` / `a9835d45` + 本次未提交改动（agent 生产代码、测试、脚本、文档） |
| runtime | 宿主 Node v22.23.2；容器 / 运行器 `node:22-slim` v22.23.2 |
| 重建的镜像 | `pi-enterprise-agent`（agent + agent-worker 共享）= `ec9cb9ee6595`；运行容器已核对换新、healthy。`exec/`、`api-server/`、前端未改，未重建 |
| 替身边界 | 开发栈 `dbpm-fake`、MySQL 5.7、Redis 5.0.14。DSH gate 用假模型；链路调用真实 LLMIO 网关 |

## 一、复现（修复前，同一组真实 DSH gate）

| 场景 | 修复前实测 |
|---|---|
| 3. 工具请求已发往执行面（被代理拦住）时 SIGKILL | 账本 `status=PROPOSED request_hash=null execution_fence_token=null` |
| 4. 命令执行中重启 sandbox | 工具 `FAILED/TOOL_ERROR`，模型收到的工具结果是 `"fetch failed"`，Run 继续并 `SUCCEEDED` |

## 二、根因

1. **派发边界**：`recordToolStarted` 在行没有策略指纹时刻意留 PROPOSED，等「随后的策略判定」接管——那是 Pi 的时序
   （start 通知先于 beforeToolCall）。DSH 下 `tools/pre-execute` 先判定、`tools/execute` 后调用 `started`，
   没有人再接管，命令执行期间账本一直是 PROPOSED。负责派发前绑定请求指纹与 fence 的
   `ToolExecutionRepository.bindSandboxRequest` 在 `agent/src` 里没有调用方（Pi 时代由沙箱桥调用，换引擎后断了）。
   另外 `tools/execute` 把 `started` 的失败 `.catch` 掉照常执行——fence 已被别的 Worker 接管时，旧 Worker 仍会落副作用。
2. **结果未知**：`ExecRpcClient` 把所有传输异常统一翻成 `INTERNAL_ERROR`；DSH 把工具异常序列化成结果时只给自家
   `HarnessError` 保留错误码，账本层无从区分「执行面明确失败」与「请求可能已送达、结果丢失」，一律记 FAILED。
   `recordToolUnknown`（RUNNING → UNKNOWN）只在并行工具停泊时使用。

## 三、修复

| 位置 | 改动 |
|---|---|
| `application/fenced-tool-governance-recorder.ts` | `recordToolStarted` 即派发边界：PROPOSED / WAITING_APPROVAL 一律推进到 RUNNING（去掉 Pi 占位分支），同一事务里调用新的 `bindDispatchedSandboxRequest` |
| `application/tool-dispatch-binding.ts`（新） | sandbox 工具复用 `bindSandboxRequest` 写入 `request_hash` / `request_hash_version` / `execution_fence_token`；同一 toolCallId 换参数重来即冲突拒绝。会话没有 `sandboxSessionId` 时不绑定（执行器对这类会话刻意不拒跑），fence 仍在 FOR UPDATE 下核过 |
| `runtime/policy/install.ts` | `started` 失败不再吞掉：**不派发**（fail-closed）；`ended` 失败仍只留痕不打死结果。工具体结束后若本次调用被标为结果未知，调用 `ledger.unknown`，否则 `ended` |
| `runtime/providers/exec-outcome.ts`（新）+ `exec-rpc.ts` | 仅对有副作用的路由（`shell/run`、`shell/start`、`fs/write-text`、`fs/edit-text`、`artifacts/submit`），请求可能已送达却没拿到响应（连接重置 / 对端关闭 / 传输截止到期）时标记结果未知，并抛出给模型的明确说明（可能已部分生效、重试前先检查）。连不上（`ECONNREFUSED` / `ENOTFOUND` / `EAI_AGAIN` / 连接超时等）、调用方取消、只读路由、执行面给出错误响应仍是普通失败 |
| `runtime/providers/tool-execution-context.ts` | 结果未知标记经本次调用的 ALS 上下文传递（WeakMap 以上下文对象为键，不改上下文形状、不串调用） |
| `application/dsh-run-executor.ts` | `toolLedger.unknown` → `recordToolUnknown` |

Run 本身不因 UNKNOWN 停下（与 Pi 时代设计一致）：模型拿到明确提示后自行决定；之后若 Worker 崩溃，
恢复只重放全部工具行为 `SUCCEEDED/FAILED/CANCELLED` 的 Run，UNKNOWN / RUNNING 交人工对账。
前端已有 UNKNOWN 投影（「Outcome unconfirmed; do not retry automatically.」），未改。

## 四、回归测试（修复前失败、修复后通过）

| 文件 | 修复前 | 修复后 |
|---|---|---|
| `agent/tests/executor/tool-dispatch-boundary.unit.test.js`（新） | 4 fail / 1 pass（stale fence 对照） | 5 / 5 |
| `agent/tests/runtime/policy-install.test.ts`：started 失败不派发、unknown 分派 | 2 fail / 1 pass（ended 失败对照） | 27 / 27（全文件） |
| `agent/tests/runtime/exec-rpc-outcome-unknown.test.ts`（新） | 3 fail / 5 pass（对照） | 8 / 8 |
| 真实 DSH gate 场景 3 / 4 收紧为 RUNNING + 绑定、UNKNOWN + 明确提示 | 见 §一 | 见 §五 |

`tool-governance-record-tool-unknown.unit.test.js` 有一例在同一 Run 进入 `WAITING_APPROVAL` 之后再启动 bash；
绑定要求 Run 为 RUNNING 而拒绝——这是正确行为（Run 停泊时本就不许派发，`WAITING_APPROVAL` 只能转回 RUNNING），
用例改为在停泊前准备该工具。`fenced-tool-governance-recorder.ts` 行数 1558 → 1557，棘轮预算同步收紧。

## 五、真机验证

### 5.1 真实 DSH 中断 gate：`scripts/dev/release-gate-dsh-restart.sh`，5 / 5，退出码 0

| 场景 | 结果 |
|---|---|
| 1. 模型调用中 SIGKILL | 只重放一次模型请求，`SUCCEEDED` |
| 2. `ask_user_question` 停泊后 Worker 重启 | 回答续跑成功 |
| 3. 派发边界 SIGKILL | SIGKILL 前账本 **RUNNING**、`request_hash` 为 64 位十六进制、`execution_fence_token` = 会话 fence；Worker B `needsReconciliation`、不重放、工作区无副作用；正对照写入成功 |
| 4. 执行中重启 sandbox | 工具 **`UNKNOWN / TOOL_OUTCOME_UNKNOWN`**；模型收到 `The sandbox connection was lost after the request was sent (UND_ERR_SOCKET), so this operation may or may not have taken effect — it may have partially run. Inspect the workspace state before retrying; do not blindly repeat it.`；命令未重跑、无补写 |

第一次运行场景 3 失败在「标记文件已存在」：专用 sandbox 复用了开发栈工作区的 bind mount，而上一轮变异验证里
真的被重放的命令留下了同名文件（文件时间与变异运行吻合）。脚本改为给专用 sandbox 挂独立数据根
`.runtime/release-gate-dsh/`（经 compose 的 `SANDBOX_*_MOUNT` 变量），结束删除；清理了开发工作区里 4 个 gate 固定 ID 目录后重跑通过。

### 5.2 其余 gate 与链路

| 项 | 结果 |
|---|---|
| `scripts/dev/release-gates.sh` | UPRedis 6+1skip / 7、Redis 重启 4、BullMQ Worker 重启 2、Agent Worker 重启 4，退出码 0 |
| 生产 agent 镜像内（断网）插件树等 7 个文件 | 56 / 56 |
| 经 BFF 完整链路（真实模型） | 11 / 11：登录、建会话、带工具 Run `SUCCEEDED`、后台进程 logs / SIGTERM → `cancelled`、四项跨租户 404 含本人 200 对照 |
| 链路 Run `01M2Q91MDTM3GVFGZCG65HD03N` 的账本 | 两条 bash 均 `SUCCEEDED`，`request_hash_version=1`，`execution_fence_token=1` 与会话 fence 一致，`started_at` 已写——真实模型路径上派发边界绑定生效 |

## 六、离线测试与类型检查

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 207 passed |
| `npm test --prefix contract` | 118 pass / 0 fail |
| `npm test --prefix exec` | 419 pass / 0 fail |
| `npm test --prefix agent` | 1380 pass / 0 fail / 0 cancelled |
| `npm test --prefix api-server` | 160 pass / 0 fail |
| `npm test --prefix frontend` | 367 pass / 0 fail |
| `npm run build --prefix frontend` | 通过 |
| 类型检查 | exec / contract / api-server / agent（主程序 + `src/runtime` strict）全部通过 |

## 七、未覆盖与已知限制

- 审批续跑（WAITING_APPROVAL → RUNNING 后派发并绑定）只有离线用例（`approval-resume`、B2 restart 测试），
  没有在真实栈上走一次高风险工具审批。
- 结果未知只覆盖 Agent 与执行面之间的连接；执行面进程被 SIGKILL（而非 docker restart 的 SIGTERM + 宽限）、
  网络分区未测。exec 侧前台命令仍不落执行记录，UNKNOWN 的判定完全在 Agent 侧。
- 多 Worker 副本、目标环境（UPDRDB / UPRedis / DBPM / 麒麟 VM）上的中断行为未验证。
