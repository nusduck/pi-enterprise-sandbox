# ADR 0010: 保留自建 A2A 服务端协议面并撤销 ADR 0007 D8

| 字段 | 值 |
|---|---|
| 状态 | **Accepted / Implemented**（2026-09-02 决策锁定并收口） |
| 日期 | 2026-09-02 |
| 决策所有者 | Agent runtime maintainers |
| 适用范围 | `agent/src/presentation/a2a/`、`agent/src/application/a2a/`、`agent/tests/a2a/` |
| 关联决策 | [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)（**本 ADR 明确撤销其 D8**「A2A 换用官方 SDK / 12 个手写协议文件作废」）、[ADR 0009](0009-dsh-host-tools-and-application-steward.md) |
| 上游参照 | `@a2a-js/sdk@1.1.0`（出厂提供 `.`、`./server`、`./compat/v0_3/server` 等入口） |

---

## 背景与问题

[ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) §D8 曾规划：
> “A2A 换用官方 SDK `@a2a-js/sdk@1.1.0`。现有 12 个手写协议文件作废，只保留‘把我们的 Run 事件翻译成 SDK 类型’的适配层。”

历史 commit `2a1462fa`（2026-08-29）在提交信息中声称删除了自建协议文件，但实际 diff 显示零文件删除，仅新增了 23 行的 `sdk-adapter.ts`（只调用了 `formatSSEEvent` 编码 SSE 帧）。自建的 JSON-RPC 分发、Task↔Run 映射、Redis/MySQL 连续序列 SSE 流、租户隔离与审计层（共 13 个模块，5,669 行）依然完整运行在生产路径上。

2026-09-02，根据 [`docs/design/a2a-sdk-server.md`](../design/a2a-sdk-server.md)，我们对 `@a2a-js/sdk/server` 进行了彻底的架构评估与代码 Spike 验证，判断是否应继续执行 ADR 0007 D8 迁移，还是应当撤销该决策并确立自建面的权威性。

---

## 评估与实验证据（Spike 结论）

针对设计文档 §5 提出的三条硬摩擦，我们进行了代码审查与实测验证（见测试 `agent/tests/a2a/a2a-custom-protocol-integrity.unit.test.ts`）：

### 1. `ExecutionEventBus` 与跨进程 / 断线续传架构的根本冲突（§5.1）

- **多进程架构**：本仓库中 HTTP 面（`agent/dist/server.js`）与 Run 实际执行（`agent/dist/worker.js`）运行在不同进程中，状态与事件通过 Redis stream 和 MySQL 账本解耦。
- **已验收性质**：STATUS F3/F5 与 plan.md 要求“SSE 断开不取消 Run，且断开重连（`tasks/resubscribe`）必须能续上事件流直至终态 `status-update(final=true)`”。
- **SDK 行为**：
  1. `DefaultRequestHandler.resubscribe` 在遇到终态任务（`TASK_STATE_COMPLETED`、`FAILED`、`CANCELED`、`REJECTED`）时，**直接抛出 `UnsupportedOperationError: Task ... is in a terminal state and cannot be subscribed to.`**。这直接破坏了断线后获取已完成任务终态帧的核心业务场景。
  2. 当任务处于非终态但当前进程内存中没有活跃的 `ExecutionEventBus` 时（例如 Worker 异步执行、服务重启或不同实例），`DefaultRequestHandler.resubscribe` 仅发出一个初始 `Task` 快照便立即 `return;` 退出，**完全无法从 Redis/MySQL 补发历史事件或等待实时事件**。
  3. SDK 的 `ExecutionEventBusManager` 接口为全同步签名（`createOrGetByTaskId`、`getByTaskId`、`cleanupByTaskId`），无法注入游标（`afterSequence`、`Last-Event-ID`）或进行异步跨进程事件总线挂载（`agent/node_modules/@a2a-js/sdk/dist/server/index.d.ts:142-146`）；且在 `_runStreamExecutor` 执行结束时，SDK 会立即调用 `cleanupByTaskId` 从内存中清理总线。

### 2. 多租户隔离、凭据与审计生命周期（§5.2）

- 本仓库的安全不变量要求跨租户访问**一律返回 HTTP 404**（`AGENTS.md` §2，防止存在性泄漏），且对所有 A2A 操作（`send_message`、`cancel_task`、`artifact_download`）记录 `(org_id, client_id, trace_id)` 审计日志，变动操作在审计不可用时必须 fail-closed。
- SDK 的 `ServerCallContext` 与 `JsonRpcTransportHandler` 缺乏企业级审计拦截点与 fail-closed 审计事务集成。

### 3. 方法名双轨兼容与 HTTP 扩展（§5.3）

- 本仓库同时支持 PascalCase（`SendMessage`、`SendStreamingMessage`、`GetTask` 等）与 slash 别名（`message/send`、`message/stream`、`tasks/get` 等）。
- SDK v1.0 `JsonRpcTransportHandler` 仅接受 PascalCase，遇到 slash 报 `METHOD_NOT_FOUND`；SDK v0.3 `LegacyJsonRpcTransportHandler` 仅接受 slash，遇到 PascalCase 报 `METHOD_NOT_FOUND`。两者互不兼容。

---

## 决策

1. **正式撤销 ADR 0007 §D8**：不再尝试将 A2A 服务端协议分发与流处理迁移至 `@a2a-js/sdk/server`。
2. **保留自建 A2A 服务端协议面**：
   - 现有的 13 个协议与应用模块（`presentation/a2a/` 与 `application/a2a/`）作为本仓库 A2A 服务端的长期维护实现。
   - 保留 `@a2a-js/sdk` 在 SSE 帧格式编码层的作用（通过 `formatSSEEvent` 保证 SSE 帧序列化与官方 SDK 一致）。
3. **建立完整性反向棘轮**：
   - 在 `agent/tests/a2a/` 中建立并维护永久反向棘轮测试（`a2a-custom-protocol-integrity.unit.test.ts`），同时扫描 `.js` 与 `.ts`，断言自建协议模块完整存在且接口完备，防止后续误删。

---

## 影响与结论

- **零对外行为变化**：`agent/tests/a2a/` 15 个文件、125 个用例全绿（新增的完整性棘轮 5 条已含在内），断言无需任何妥协修改。agent 全套 1211 pass / 0 fail。
- **状态看板收口**：`docs/review-deferred-items.md` 中对应的跟踪项标记为 Closed。
- **`docs/STATUS.md` F2 仍是 `partial`，本 ADR 不改变它**——F2 的缺口是 live gate 未重跑，
  与协议面由谁实现无关。只更新了它的 Evidence 说明。`docs/design/waves/README.md` 的
  W6-B 也保持 ⚠️：那一格记录的是"当时声称做了而没做"，不因为后来决定不做而变成 ✅。
