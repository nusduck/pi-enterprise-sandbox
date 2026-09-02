# 工单：把 A2A server 面接到 `@a2a-js/sdk/server`（ADR 0007 D8 的补执行）

> **这份文档写给一个对本仓库零上下文的外部 agent。** 所有事实都标了复现命令，
> 请**先自己跑一遍**再动手——本仓库对"先复现再修"是硬性要求（`AGENTS.md` §3），
> 而这个工单存在的原因恰恰是上一次有人跳过了这一步。
>
> 动手前必读：仓库根的 `AGENTS.md` §1（层边界）、§2（安全不变量）、§4（验证清单）。

---

## 0. 一句话

`agent/` 的 A2A 对外面（JSON-RPC、Task 生命周期、SSE 流）是 5669 行自建实现，
官方 `@a2a-js/sdk` 只被用来编码 SSE 帧。ADR 0007 D8 决定「12 个手写协议文件作废、
只留适配层」，该决策**从未执行**，却被记成完成。你的任务是判断它现在还该不该执行，
该执行就执行，不该就写清为什么并留下 ADR。

---

## 1. 已核实的事实（请复现）

### 1.1 决策是什么

`docs/adr/0007-agent-runtime-rebuild-on-dsh.md` §D8：

> ### D8：A2A 换用官方 SDK
> `@a2a-js/sdk@1.1.0`。现有 12 个手写协议文件作废，只保留"把我们的 Run 事件翻译成
> SDK 类型"的适配层。DSH 里没有任何 A2A 组件——这是另一个生态的 SDK。

### 1.2 实际发生了什么

实现 commit 是 `2a1462fa`（2026-08-29），它的 message 写着：

> A2A drops the 12 hand-written protocol files for @a2a-js/sdk plus a thin
> adapter that translates our Run events into SDK types.

diff 与这句话矛盾：

```bash
# 该 commit 在 a2a 目录下删了哪些文件 —— 输出为空
git show --stat --diff-filter=D 2a1462fa | grep -i a2a

# 该 commit 对 a2a 的全部改动 —— 9 个文件 +48/-17，其中新增的是 sdk-adapter
git show --stat --format= 2a1462fa -- agent/src/application/a2a agent/src/presentation/a2a

# 改动前后的文件清单 —— 12 个文件一个没少，只是后来转成了 .ts，另加了第 13 个
git ls-tree -r --name-only 2a1462fa^ | grep 'src/application/a2a'
git ls-tree -r --name-only HEAD     | grep 'src/application/a2a'
```

### 1.3 今天的真实状态

```bash
# 全仓对官方 SDK 的引用 —— 只有一处 import，只有一个函数
grep -rn "@a2a-js/sdk" --include='*.ts' agent/src

# server 子入口零引用
grep -rn "@a2a-js/sdk/server" agent/src agent/tests ; echo "exit=$?"

# 自建面的体量
wc -l agent/src/application/a2a/*.ts agent/src/presentation/a2a/*.ts
```

`agent/src/application/a2a/sdk-adapter.ts` 全文 23 行，导出两个函数：
`encodeA2aSseFromSdk`（转发 `formatSSEEvent`）和 `mapRunStatusToSdkTaskState`
（转发本仓库自己的 `projectRunStatusToA2a`，与 SDK 无关）。

唯一的 SDK 测试 `agent/tests/a2a/sdk-adapter.unit.test.js` 断言"帧以 `data: ` 开头、
以 `\n\n` 结尾"。**它证明 SDK 被 import 了，不证明协议面归 SDK。** 没有任何棘轮
检查 `@a2a-js/sdk/server` 是否被使用——这是这次漏检的直接原因。

### 1.4 记录已在 `93f8af56` 更正

`docs/design/waves/README.md`（W6-B 降级）、`docs/STATUS.md`（F2 两处）、
`docs/review-deferred-items.md`（新增一行）、`sdk-adapter.ts` 的文件头注释。
你不需要再改这些**说明现状**的文字；但如果你完成了迁移，就要把它们改成新的现状
（`AGENTS.md` §6 要求文档与行为变更同一个 PR）。

---

## 2. 目标与非目标

### 目标

1. **先判定**：`@a2a-js/sdk/server` 能否承载本仓库的 A2A 语义（见 §5 三条摩擦）。
   判定结论本身就是交付物之一。
2. 若可行：把 JSON-RPC 分发、Task 生命周期、流式响应交给 SDK，自建代码只剩
   「本仓库领域 → SDK 类型」的翻译层与「SDK 抽象 → 本仓库存储/事件」的实现层。
3. **对外行为逐字节不变**：现有 15 个 `agent/tests/a2a/*.test.js` 全部继续通过，
   一条都不许改断言来迁就实现。要改断言，必须先证明原断言写错了。

### 非目标（做了会被打回）

- 不要碰 `exec/`、`api-server/`、`frontend/`。A2A 只在 `agent/`。
- 不要引入 express 作为 agent 的 HTTP 框架。现在是 `node:http` 手挂路由
  （`agent/src/bootstrap/http-main.ts` + `create-http-server.ts`）。
  `@a2a-js/sdk/server/express` 只有在你已证明它不改变现有路由/中间件顺序时才可用；
  默认走 `A2ARequestHandler` 这一层，HTTP 绑定自己接。
- 不要引入 gRPC 传输。
- 不要顺手改 `agent/src/domain/a2a/`（scopes / status 投影）的语义。
- 不要为了让 SDK 好接而放宽 §7 的任何一条安全不变量。

---

## 3. 现状地图

### 3.1 文件与职责

| 文件 | 行数 | 职责 | 迁移后应该 |
|---|---|---|---|
| `presentation/a2a/http-handler.ts` | 938 | 路由、鉴权、JSON-RPC 分发、SSE 写出 | 大幅收缩为 HTTP↔`A2ARequestHandler` 绑定 |
| `presentation/a2a/http-handler-mapping.ts` | 90 | 方法→scope、异常→JSON-RPC 错误码的纯查表 | 保留（scope 是本仓库概念） |
| `presentation/a2a/admin-http-handler.ts` | 278 | 凭据管理后台面，**不是 A2A 协议** | 不动 |
| `application/a2a/task-service.ts` | 992 | Task↔Run 映射、幂等、审计 | 拆成 `TaskStore` 实现 + `AgentExecutor` |
| `application/a2a/event-projector.ts` | 759 | Run 事件 → A2A 帧 | 保留，输出改成 SDK 的 `AgentExecutionEvent` |
| `application/a2a/stream-service.ts` | 572 | SSE 流、resubscribe、心跳 | 判定后决定（见 §5.1） |
| `application/a2a/credential-service.ts` | 487 | Bearer 凭据、scope、租户绑定 | 保留，接到 `ServerCallContextBuilder` |
| `application/a2a/agent-card.ts` | 391 | Agent Card 生成 | 保留，喂给 `DefaultRequestHandler` |
| `application/a2a/task-request.ts` | 287 | 入参校验 | 大部分由 SDK 类型接管 |
| `application/a2a/stream-event-schema.ts` | 269 | 帧结构校验 | 大部分由 SDK 类型接管 |
| `application/a2a/json-rpc.ts` | 240 | JSON-RPC 解析、方法别名、错误码 | **应当整体删除**（SDK 的活） |
| `application/a2a/artifact-download.ts` | 199 | 产物下载 token | 保留（本仓库扩展，不在 A2A spec 内） |
| `application/a2a/{index,identity,deterministic-task-id}.ts` | 144 | 装配与 id 派生 | 保留 |
| `application/a2a/sdk-adapter.ts` | 23 | 现在只有帧编码 | 迁移后要么长大，要么消失 |

### 3.2 对外路由（`http-handler.ts` 文件头）

```
GET  /.well-known/agent-card.json
POST /a2a                                              JSON-RPC 2.0（根卡片广告的端点）
GET  /a2a/agents/{agentId}/.well-known/agent-card.json  （agent meta 缺失时 404）
POST /a2a/agents/{agentId}                              JSON-RPC 2.0
GET  /a2a/artifacts/download?token=…
```

鉴权：`Authorization: Bearer <a2a_api_credential>`。SSE 每个 data 行都是 JSON-RPC，
心跳是 SSE 注释行。

### 3.3 支持的方法（`application/a2a/json-rpc.ts` 的 `A2A_METHODS` / `A2A_METHOD_ALIASES`）

PascalCase 与 slash 两种形式都接受，**这一点必须保住**：

| 规范名 | slash 别名 | 需要的 scope |
|---|---|---|
| `SendMessage` | `message/send` | `agent.invoke` |
| `SendStreamingMessage` | `message/stream` | `agent.invoke` |
| `GetTask` | `tasks/get` | `agent.read` |
| `CancelTask` | `tasks/cancel` | `agent.cancel` |
| `SubscribeToTask` | `tasks/resubscribe`、`tasks/subscribe` | `agent.read` |
| `ListTasks` | `tasks/list` | `agent.read` |

scope 常量在 `agent/src/domain/a2a/scopes.ts`，另有 `artifact.read`。

### 3.4 现有测试（一条都不能变红）

```
agent/tests/a2a/
  a2a-protocol.unit.test.js              a2a-protocol-compliance.unit.test.js
  a2a-standard-client.unit.test.js       a2a-official-client-configuration.unit.test.js
  a2a-stream-contract.unit.test.js       a2a-terminal-event-vocabulary.unit.test.js
  a2a-credential.unit.test.js            a2a-tenant-identity.unit.test.js
  a2a-agent-version-binding.unit.test.js a2a-audit-correlation.unit.test.js
  a2a-root-gateway.unit.test.js          a2a-admin.unit.test.js
  a2a-domain.unit.test.js                a2a-severe-followup.unit.test.js
  sdk-adapter.unit.test.js               standard-a2a-client.js（夹具）
```

`a2a-terminal-event-vocabulary.unit.test.js` 是一条棘轮：`src/application` 里出现
一个不可投影的 `run.*` eventType 就失败。它曾经因为只扫 `.js` 而在 TS 转换后静默
失效过——**你新增的任何"扫源码"断言都要同时覆盖 `.js` 与 `.ts`。**

---

## 4. SDK 提供了什么（`@a2a-js/sdk@1.1.0`，已安装在 `agent/node_modules`）

子入口：`.`、`./errors`、`./errors/grpc`、`./server`、`./server/express`、`./server/grpc`。
请直接读 `agent/node_modules/@a2a-js/sdk/dist/server/index.d.ts`，关键签名：

```ts
interface TaskStore { /* 可自己实现 —— 这是接 MySQL 的正门 */ }
declare class InMemoryTaskStore implements TaskStore {
  constructor(ownerResolver?: OwnerResolver);
}

declare class DefaultRequestHandler implements A2ARequestHandler {
  constructor(
    agentCard: AgentCard,
    taskStore: TaskStore,
    agentExecutor: AgentExecutor,
    eventBusManager?: ExecutionEventBusManager,
    pushNotificationStore?: PushNotificationStore,
    pushNotificationSender?: PushNotificationSender,
    extendedAgentCardProvider?: AgentCard | ExtendedAgentCardProvider,
    agentCardSignatureGenerator?: AgentCardSignatureGenerator,
    options?: DefaultRequestHandlerOptions,
  );
}

type AgentExecutionEvent =
  | { kind: 'message';       data: Message }
  | { kind: 'task';          data: Task }
  | { kind: 'statusUpdate';  data: TaskStatusUpdateEvent }
  | { kind: 'artifactUpdate';data: TaskArtifactUpdateEvent };

type ExecutionEventName = 'event' | 'finished';   // ExecutionEventBus 是 EventEmitter
```

还导出 `ServerCallContextBuilder` / `defaultServerCallContextBuilder` / `User` /
`UnauthenticatedUser` —— 这是把本仓库 Bearer 凭据接进去的钩子。

---

## 5. 三条硬摩擦（每条都给了判定实验，先做实验再写代码）

### 5.1 `ExecutionEventBus` 是进程内的，而本仓库的 Run 跨进程

SDK 的事件总线是一个 `EventEmitter`（`'event'` / `'finished'`）。本仓库里：

- HTTP 面在 `agent/dist/server.js`，Run 实际执行在 `agent/dist/worker.js`，**两个进程**。
- `tasks/resubscribe` 必须能在**流断开之后、甚至进程重启之后**重新接上，
  这是 STATUS F3/F5 已通过的性质（"SSE disconnect does not cancel Run"）。
- 现有实现靠 Redis stream + MySQL 事件表做这件事，见 `application/a2a/stream-service.ts`
  与 BFF 侧同构的 `readAfter` 轮询。

**判定实验**：写一个最小 spike，用 `DefaultRequestHandler` + 自定义
`ExecutionEventBusManager`，让 bus 的事件来源是 Redis/MySQL 而不是同进程 publish，
验证 `message/stream` 与 `tasks/resubscribe` 两条路径都能拿到 `status-update(final=true)`。
**如果 `ExecutionEventBusManager` 的接口不允许异步/跨进程来源，这条就是阻断项**，
到 §10 走退出路径。

### 5.2 认证与审计是自建的，且有已通过的验收证据

- 凭据、scope、租户绑定在 `credential-service.ts`；跨租户**一律 404 不用 403**
  （`AGENTS.md` §2，存在性本身不能泄漏）。
- 每次 `send_message` / `cancel_task` / `artifact_download` 都要往
  `A2aAuditRepository` 落 **org_id + client_id + trace_id** 三元组
  （STATUS F6 = done，证据 `docs/evidence/p1-trace-audit-2026-07-19.md`）。

SDK 的 `ServerCallContextBuilder` 是正确的接入点。**接完必须重跑
`a2a-audit-correlation.unit.test.js` 与 `a2a-tenant-identity.unit.test.js`**，
并确认跨租户仍是 404 而不是被 SDK 变成 403 或 401。

### 5.3 HTTP 绑定形状不同

现在是 `node:http` + 手写路由表（`create-http-server.ts` 第 144 行附近判断
`/.well-known/agent-card.json`、`/a2a`、`/a2a/`），凭据路由与 agent 维度的
子路径都是本仓库扩展，A2A spec 里没有。

`@a2a-js/sdk/server/express` 会引入 express 与它自己的路由顺序。**默认不要用它**，
用 `A2ARequestHandler` 接口自己做 HTTP 绑定，保住现有五条路由与 SSE 心跳格式。

---

## 6. 实施顺序（每一阶段单独可验证，单独提交）

> 每一阶段都按 `AGENTS.md` §3：先写一个**当前会失败**的测试，再改实现。

**P0 · 判定（不写生产代码）**
产出一份 spike 结论：§5.1 的跨进程事件总线能不能接。写进本文件末尾的「判定记录」
一节。结论为「不能」时，直接跳到 §10。

**P1 · `TaskStore` 接 MySQL**
用现有 `a2a-task-repository.ts` 实现 SDK 的 `TaskStore` 接口。此阶段**不改任何
对外行为**，只是让 SDK 能读到本仓库的 Task。新增单测：同一个 task id 经 SDK
`TaskStore` 读出的 `Task` 与现有 `task-service.ts` 投影出的一致。

**P2 · `AgentExecutor` + `DefaultRequestHandler` 并行接线**
新路径挂在一个环境变量开关后（fail-closed：变量缺失时走旧路径），旧路径不动。
用 `agent/tests/a2a/standard-a2a-client.js` 这个既有夹具，对新旧两条路径跑同一组
请求，逐字节比对响应。差异要么修实现，要么在提交信息里说明为什么该差。

**P3 · 流式**
`message/stream` 与 `tasks/resubscribe` 走 SDK。这一步必须真机验证（§8），
离线单测不足以证明 SSE 断线重连。

**P4 · 删自建**
`json-rpc.ts` 整体删除；`task-request.ts` / `stream-event-schema.ts` 收缩到只剩
SDK 覆盖不到的部分；开关与旧路径一起删掉。
**这一步必须重建容器跑真实链路**（`AGENTS.md` §4）。

**P5 · 防复发棘轮**
加一条测试，断言 `agent/src` 里存在 `from '@a2a-js/sdk/server'` 的 import，
且 `application/a2a/json-rpc.ts` 不存在。同时扫 `.js` 与 `.ts`（§3.4 的教训）。
这条棘轮是这次工单的核心交付之一——没有它，同样的漂移会再来一次。

---

## 7. 不可破的安全不变量（`AGENTS.md` §2 摘录，逐条适用）

- **fail-closed 优先**：凭据/密钥/隔离配置缺失时必须关闭能力，不能回退到默认可用。
  P2 的开关也适用这条：变量缺失 = 走旧路径，不是"两条都开"。
- **跨租户一律 404**，不用 403。
- **令牌比较用常量时间**（`timingSafeEqual`）。凭据校验若被移进 SDK 的钩子，
  常量时间比较必须跟着搬。
- **所有出站调用有超时**。
- **不把密钥写进文档、日志、`.env.example`**（只允许占位符）。

另外：`tests/test_repository_layout.py` 是行数棘轮，生产文件默认 ≤1000 行，
热点文件的预算钉死在当前行数，**只能减不能增**。`task-service.ts`(992) 与
`http-handler.ts`(938) 都贴着上限，加行会直接红。这对你是好消息——本工单的方向
就是减行。

---

## 8. 验证（缺一不可）

六套测试：

```bash
uv run pytest -q
npm test --prefix exec
npm test --prefix contract
npm test --prefix agent          # 基线 1206 passed / 0 failed（2026-09-02）
npm test --prefix api-server
npm test --prefix frontend && npx tsc --noEmit -p frontend/tsconfig.json
```

类型检查**不在 `npm test` 里**，必须另跑：

```bash
npx tsc --noEmit -p exec/tsconfig.json
npx tsc --noEmit -p contract/tsconfig.json
npm --prefix agent run typecheck
```

真机链路（P3 与 P4 强制；镜像**不挂载源码**，不重建就是在验证旧代码）：

```bash
docker compose build agent api-server sandbox sandbox-mcp && docker compose up -d
```

最少覆盖：拿一枚 A2A 凭据 → `message/send` → `message/stream` 收到
`status-update(final=true)` → 中途断开再 `tasks/resubscribe` 能续上 →
`tasks/cancel` → 用另一个租户的凭据访问同一个 task 得到 **404**。

已知环境陷阱（撞上先别怀疑自己的改动）：`scripts/smoke-cross-service.mjs` 在宿主机
起进程，macOS 上失败是预期的，应在 Linux/CI 跑。

---

## 9. 交付与提交

- 分支从 `main` 切出；`main` 受保护，必须走 PR、squash 合并。
- squash 意味着中间提交不进 `main`，**PR 描述与 commit message 是这批改动在 main 上
  唯一的记录**，要写清「改了什么、为什么、怎么验证的」，并**贴上实际的测试输出数字**。
- 提交用显式路径，不要 `git add -A`。
- 文档同步（`AGENTS.md` §6，与行为变更同一个 PR）：
  - `docs/STATUS.md` F2 两处
  - `docs/design/waves/README.md` 的 W6-B 更正段
  - `docs/review-deferred-items.md` 里 "ADR 0007 D8 未执行" 那一行
  - `docs/architecture.md` / `docs/api.md`（若路由或帧格式有任何变化）
  - `docs/CHANGELOG.md` 的 `[Unreleased]`
  - 本文件的「判定记录」一节
- **禁止**：改测试断言来迁就实现；把 P0 验收项挪进 `review-deferred-items.md`；
  在任何文档里写真实密钥。

---

## 10. 允许的退出路径

如果 §5.1 的判定结论是「SDK 的事件总线承载不了跨 Worker + 跨重启的 resubscribe」，
**不要硬做**。正确的交付是：

1. 新增 `docs/adr/0010-*.md`（当前最新是 0009，新 ADR 从 0010 起编号），
   状态 Accepted，明确**撤销 ADR 0007 D8**，并写清撤销理由与实验证据。
2. 在 0007 的 D8 节加一行指回 0010。
3. 保留 §6 的 P5 棘轮的反向版本：断言自建协议面仍然完整，防止有人再"顺手"删一半。
4. `review-deferred-items.md` 那一行改成 closed，指向 0010。

**一个写清楚了"为什么不做"的 ADR，比一次做了一半又记成完成的迁移有价值得多。**
这份工单存在的全部原因就是后者。

---

## 11. 判定记录

> P0 完成后填这里。留空 = 还没判定。

| 日期 | 结论 | 证据 |
|---|---|---|
| 2026-09-02 | **走 §10 退出路径**：撤销 ADR 0007 D8，保留自建 A2A 协议面（13 个模块），建立完整性反向棘轮并立 ADR 0010。 | 1. `DefaultRequestHandler.resubscribe` 在任务终态时显式 throw `UnsupportedOperationError`，破坏断线后重连获取终态帧（`status-update(final=true)`）的验收性质；<br>2. `ExecutionEventBus` 为进程内 `EventEmitter`（`on`/`off`/`once`/`removeAllListeners` 均返回 `this`），无法支撑多进程异步架构（`server.js` + `worker.js`）及跨重启/游标补发（`afterSequence`/`Last-Event-ID`）；<br>3. Spike 测试 `agent/tests/a2a/a2a-custom-protocol-integrity.unit.test.ts` 实测通过；<br>4. ADR 见 `docs/adr/0010-retain-custom-a2a-server-layer.md`。 |

