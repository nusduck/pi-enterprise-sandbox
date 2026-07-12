# 可行性审计：session cwd 与前端单状态源

## 2026-07-12 — Pi SDK 逻辑 cwd

在当前锁定的 `@earendil-works/pi-coding-agent` 版本上，用不存在于 Agent 容器文件系统的
`/home/sandbox/workspace` 创建以下对象并执行 ResourceLoader reload：

- `SessionManager.create(cwd, tempSessionDir)`
- `SettingsManager.create(cwd, tempAgentDir)`
- `DefaultResourceLoader({ cwd, ... }).reload()`

结果：命令成功退出；SessionManager header 的 `cwd` 为 `/home/sandbox/workspace`，ResourceLoader
返回空 project context，没有 ENOENT。SDK 的 `SessionManager.open(..., cwdOverride)` 也明确支持当前
cwd 覆盖旧 header cwd。

结论：可以使用稳定逻辑 cwd，无需把 `/var/sandbox/workspaces/...` 物理目录暴露或挂载给 Agent。

## 2026-07-12 — legacy SSE → EntityStore 覆盖审计

已有覆盖：

- `session` → `run.started`
- `token` → `message.started` + `message.delta`
- `tool_start` / `tool_end` → tool events
- `file_ready` → `artifact.created`
- `approval_required` → `tool.approval_required`
- `error` → `run.failed`
- `done` → `message.completed` + `run.completed`
- budget events → budget runtime events

替换 dual-write 前必须修复：

1. `trace` 当前被 adapter 丢弃，ChatState 仍独占 trace id；需要在 RunEntity 或明确的非重复 UI
   metadata 中建立唯一归属。
2. `agent_session` 当前被 adapter 忽略，EntityStore 的 AgentSessionEntity 无法从 live stream 建立。
3. `session_closed` 无条件映射为 `cancelled`；正常流是 `done` 后紧跟 `session_closed`，会把 succeeded
   run 错改为 cancelled。应把该事件视为 sandbox 生命周期事件，或仅在没有 terminal run event 时映射。
4. 当前消息投影只包含纯文本，旧 `currentMsg.content` 还承载 tool card 与 `_fileLinks`；MessageList 若
   切换到 EntityStore，应从 run 关系组合 message/tool/artifact，而不是复制嵌套 runtime 状态。
5. `activeRunId` 目前既在 EntityStore 又在 React useState；必须删除镜像 state，并确保 focus conversation
   时选择该 conversation 的 run，而不是保留其他 conversation 的 active run。

## 权威证据位置

- Agent cwd 硬编码：`agent/chat-runner.js`
- SDK cwd override：`agent/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`
- 双写入口：`frontend/src/features/chat/ChatContext.tsx::applySSE`
- adapter：`frontend/src/shared/sse/legacyAdapter.ts`
- reducer：`frontend/src/shared/state/runReducer.ts`
- 实体定义：`frontend/src/entities/types.ts`
