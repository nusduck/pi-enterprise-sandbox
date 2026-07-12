# 前端状态管理

## 状态边界

前端有两个职责互斥的容器，不得保存同一业务事实：

- `frontend/src/entities/store.ts`：**runtime 唯一 source of truth**。持有 Conversation、AgentSession、
  Run、Message、ToolExecution、Process、Approval、Artifact、Attachment 等规范化实体，以及
  `activeConversationId` / `activeRunId`。
- `frontend/src/shared/state/chatState.ts`：React Chat UI snapshot。只持有服务端加载的 conversation
  历史、当前选中 conversation/session、上传草稿、布局、认证、flash/status 和 legacy transport
  控制字段；不得保存 runtime message/tool/approval/artifact 的平行副本。

已删除的字段包括 `currentMsg`、`pendingTool`、`pendingApproval`、`readyFiles`。不得以兼容为由恢复。

## Runtime event 数据流

```text
/chat SSE
  -> legacyAdapter.ts（wire event -> RuntimeEvent）
  -> runReducer.ts（一次归约）
  -> EntityStore
  -> selectors / entityBridge.projectRunMessages
  -> React components
```

- `ChatContext.applySSE` 只允许调用 `bridge.ingestLegacyEvent` 一次。
- UI side effect（状态文字、flash、刷新服务端 artifact snapshot）可以观察事件，但不得重新解析并
  写入 message/tool/approval/artifact 状态。
- reducer 必须保持 immutable snapshot；禁止为 token 性能原地修改 message。
- `activeRunId` 只存在于 EntityStore；React 不得创建镜像 `useState`。
- legacy `/chat` fetch 的 AbortController 按 run 保存在 EntityBridge transport map；conversation 切换
  只改变 focus，不停止后台 run。

## Legacy adapter 终态规则

- `trace` -> `run.trace`；trace id 存在 RunEntity。
- `session` -> `run.started`，同步 conversation/session/workspace/model 关系。
- `agent_session` -> `session.restored`，创建/更新 AgentSessionEntity。
- `token/tool/approval/file_ready` 分别归约为 message/tool/approval/artifact entity。
- `error` 一旦产生 `run.failed`，后续 `done` / `session_closed` 不得覆盖失败终态。
- 正常 `done` 后的 `session_closed` 是 Sandbox 生命周期尾事件，不得把 succeeded run 改成 cancelled。
- 本地 abort/network failure 也必须生成 runtime event 进入同一个 reducer，不能只改 UI flag。

## UI 投影与服务端历史

- 服务端 conversation messages 是刷新后的持久化历史来源。
- 当前 run 的增量文本、tool card、artifact link、interrupted/error 状态从 EntityStore 投影为
  `ChatMessage[]`。
- 合并历史与 runtime 投影时按 role + text 识别相同 assistant message；若 entity 投影带 tool、artifact
  或 interrupted 细节，则用富投影替换纯文本历史，不追加重复气泡。
- `localStorage` 仅保存 active conversation id 和 UI preference，不缓存消息历史。

## 变更检查

新增或修改 SSE event 时必须同时检查：

1. `shared/sse/legacyAdapter.ts` 是否产生唯一、单调 sequence 的 RuntimeEvent。
2. `shared/state/runReducer.ts` 是否处理缺字段、重复、乱序、sequence gap 和 terminal status。
3. `entities/types.ts` / `store.ts` 是否维持 ID 关系和 immutable upsert。
4. UI 是否只通过 selector/projection 读取，未新增 ChatState 镜像字段。
5. conversation 切换是否保持后台 run/transport 隔离，Stop 是否只影响 active run。

验证至少运行：

```bash
npm test --prefix frontend
npm run build --prefix frontend
```
