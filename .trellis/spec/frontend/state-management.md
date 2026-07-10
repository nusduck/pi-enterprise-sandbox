# 前端状态管理

## 单一状态容器

`frontend/src/state.js` 是 source of truth：

```javascript
state = update(state, { conversationId: conv.id, messages, sessionId });
```

- `INITIAL` 用 `Object.freeze` 固定顶层初始模板。
- `createState` 复制初始 snapshot，并复制 `Set`/array 字段。
- `update` 浅合并 patch、复制 `readyFiles/conversations/artifacts`，计算变更字段并通知 subscribers。
- 调用方必须接回返回值：`state = update(state, patch)`。

这是一种 “immutable-ish” 模式：顶层 snapshot 替换，但 streaming 时 `currentMsg.content` 会为了性能原地追加文本/tool 状态。新增逻辑应理解这个例外，不要假设所有深层对象不可变。

## 状态职责

- 会话：`conversationId`、`conversations`、`messages`。
- 当前流：`isStreaming`、`abortCtrl`、`currentMsg`、`pendingTool`。
- Sandbox/交付：`sessionId`、`readyFiles`、`artifacts`、`traceId`。
- 布局：`sidebarOpen`。

不要建立第二套模块级业务状态；确需新增字段时同时更新 `INITIAL`、必要的 copy 分支、订阅渲染条件和 reset/new-chat 逻辑。

## SSE 状态机

`main.js::handleSSE` 按 event type 更新状态：

- `trace/session`：绑定 trace、session、conversation。
- `token`：追加当前 assistant text。
- `tool_start/tool_end`：维护 tool card 与 `pendingTool`。
- `file_ready`：以 `artifact_id || path` 去重，并生成下载链接。
- `approval_required`：创建一次性审批 UI。
- `error`：写入当前消息并提示。

新增 event 时必须定义：重复事件行为、缺字段行为、conversation 切换行为、stream 取消行为和最终持久化行为。

## 持久化

- 服务端 conversation 是主要历史来源。
- `localStorage` 只缓存最近 50 条纯文本消息和 active conversation ID。
- 启动时优先服务端 history；服务端无消息时才回退本地缓存。
- `normalizeServerMessages` 负责把服务端字符串/parts 统一为 UI content parts。
- tool cards、临时 download link 等非文本状态不会完整写入 localStorage，这是当前设计事实。

## 常见错误

- 忘记接收 `update` 返回的新 state。
- 直接 mutate `conversations/artifacts/readyFiles` 后期望 subscriber 自动触发。
- conversation 切换时只做增量 render，导致旧 DOM 残留。
- 取消 stream 后丢弃 partial assistant message；当前行为会保留并标记 `stopReason='aborted'`。

