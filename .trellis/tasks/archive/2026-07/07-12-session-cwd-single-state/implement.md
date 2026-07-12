# Implement — session cwd 与单一运行时状态源

## Checklist

- [x] 为 Agent 增加集中式 session cwd 配置，并补充配置/compose 契约测试。
- [x] 将 cwd 从 Sandbox session 解析结果贯穿 `resolveConversationAndSession`、
      `resolveAgentSessionManager`、SessionManager、SettingsManager、ResourceLoader 与
      `createAgentSession`。
- [x] 更新新建/恢复/内存 session 测试，断言 header 与 SDK 参数不再使用 `/tmp`。
- [x] 审计 legacy adapter + run reducer 对 token/tool/approval/artifact/error/done/session 的覆盖；先补齐
      缺失事件映射和 selectors。
- [x] 修复 `session_closed` 在正常 `done` 后把 succeeded run 覆盖成 cancelled 的终态错误，并为
      `trace`、`agent_session` 定义唯一实体/metadata 归属。
- [x] 删除 `ChatContext.applySSE` 的 ChatState runtime 双写，改为单次 EntityStore ingest 后派生 UI effects。
- [x] 删除 `activeRunId` React 镜像 state，所有调用方读取 EntityStore。
- [x] 将 message list、composer、status bar、approval/artifact 相关组件切到 EntityStore selector/projection；
      ChatState 仅保留非重叠职责。
- [x] 更新/新增前端单测，覆盖单次归约、增量消息、终止/错误、审批、artifact 与后台 run 切换。
- [x] 执行局部测试后运行 Agent 与 Frontend 全量测试和 Frontend build。
- [x] 检查是否需要更新 `.trellis/spec/frontend/state-management.md` 中已过时的 Vanilla/单状态说明。
- [x] 记录 validation.jsonl、完成 Trellis check/spec 更新、提交并 archive task。

## Validation

```bash
node --test agent/tests/session-persistence.test.js agent/tests/chat-runner.test.js
npm test --prefix agent
npm test --prefix frontend
npm run build --prefix frontend
node scripts/smoke-cross-service.mjs
```

## Review gates

1. cwd 数据流完成后确认公开 API/日志没有物理 workspace 泄露。
2. 删除 legacy ChatState runtime 写入前确认 Entity reducer 事件覆盖完整。
3. 全量测试前 grep `cwd: '/tmp'` 与 `dual-write`，只允许明确的测试临时目录或历史文档。

## Rollback points

- Agent cwd 与前端状态统一分两个独立提交候选，任一回退不影响另一项。
- 不做数据库 migration；发现 SDK 不能接受逻辑 cwd 时停止并记录，而不是开放 workspace 物理挂载。

## Implementation notes

- Agent 使用集中配置 `AGENT_SESSION_WORKSPACE_CWD=/home/sandbox/workspace`，同一值进入新建、恢复、
  in-memory SessionManager、header、ResourceLoader、SettingsManager 和 SDK options。
- 恢复旧 JSONL 时先规范化 materialized header cwd，解决 SDK runtime override 不更新 header 的差异。
- 删除旧 `features/chat/sseHandler.ts` 以及 ChatState runtime 字段；legacy SSE 只经 adapter/reducer。
- EntityBridge 按 run 管理 legacy fetch controller，focus 切换不终止后台 run，Stop 只影响 focused run。
- 修复 error/done/session_closed 终态覆盖，并把 trace/agent_session 归入规范化实体。
