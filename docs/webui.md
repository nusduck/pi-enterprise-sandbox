# WebUI Guide

## 概述

v4 前端是一个**纯 UI SPA**，零 Agent 逻辑。Agent 运行在独立 Node Agent 服务；BFF 负责 `POST /api/chat` SSE relay，前端通过 SSE 消费事件流并渲染。

架构：

```text
React Workbench -> Nginx /api proxy -> Node BFF -> Node Agent -> Sandbox
                     <- serialized SSE <-         <- runtime events <-
```

## 目录结构

```
frontend/
├── src/
│   ├── main.tsx             ← React 入口
│   ├── app/                 ← Router 与 Workbench shell
│   ├── entities/            ← 规范化 runtime entity store
│   ├── features/chat/       ← ChatContext、legacy adapter bridge
│   ├── shared/api/          ← /api fetch 与 URL 构造
│   ├── shared/sse/          ← SSE parser/manager/legacy adapter
│   ├── shared/state/        ← UI state + run reducer
│   ├── widgets/             ← 消息、时间线、审批、交付物等组件
│   └── pages/
├── test/                    ← node:test + tsx
├── index.html
├── nginx.conf               ← /api/* 反代，SSE buffering off
├── vite.config.ts           ← dev proxy → localhost:4000
├── package.json
├── Dockerfile
└── dist/                    ← Vite 构建产物
```

## 核心架构

### 模块边界

| 模块 | 职责 |
|------|------|
| `features/chat/ChatContext.tsx` | 用户流程、conversation focus、transport 与 UI side effects |
| `entities/store.ts` | runtime 实体唯一 source of truth 与 selectors |
| `shared/state/runReducer.ts` | RuntimeEvent 的唯一归约器 |
| `features/chat/entityBridge.ts` | legacy SSE 适配、per-run transport、UI projection |
| `shared/state/chatState.ts` | 非 runtime UI snapshot、上传草稿和 transport 控制 |
| `shared/api/client.ts` | chat、upload/download、approval、conversation 协议 |
| `shared/sse/parser.ts` | SSE 分片、CRLF、尾缓冲和 abort |

依赖：

- 生产构建：`npm run build --prefix frontend`（Vite）

### 状态管理

Runtime 状态只写 `EntityStore`：Run、增量 Message、Tool、Process、Approval、Artifact、trace 和
AgentSession 都由 `legacyAdapter -> runReducer` 单次归约。`ChatState` 不含 `currentMsg`、
`pendingTool`、`pendingApproval` 或 `readyFiles`，只保存服务端历史快照、选择状态、上传草稿、布局、
认证与 transport 控制。`activeRunId` 直接从 EntityStore 读取，不维护 React 镜像 state。

### 消息格式

```javascript
{
  role: 'user' | 'assistant',
  content: [
    { type: 'text', text: '...' },
    { type: 'tool_use', name: 'bash', input: {...}, status: 'running' | 'complete', isError, result },
  ],
  // P7: 交付物优先 artifact download URL
  _fileLinks: [{
    name: 'file.txt',
    url: '/api/files/artifact-download?session_id=...&artifact_id=art_...',
    path: 'file.txt',
    artifact_id: 'art_...',
  }],
  stopReason: 'aborted'  // 仅用户中断时
}
```

## 请求流

### 发送消息

```
用户输入 → Enter / 点击发送
  ↓
sendMessage(text)
  ├── 添加 user 消息
  ├── EntityBridge.beginRun + 注册 per-run AbortController
  ├── React 更新 user message / transport UI
  ├── api.sendChatMessage → POST /api/chat { messages, conversation_id? }
  │     ↓ SSE (sse.readSSEStream)
  │     legacyAdapter -> RuntimeEvent -> runReducer -> EntityStore
  │       trace/session/agent_session → Run + AgentSession 关系
  │       token                    → MessageEntity delta
  │       tool/approval/file_ready → 对应规范化实体
  │       done/error               → 不可被尾随 session_closed 覆盖的终态
  ├── selectors/projectRunMessages
  └── React 最终渲染
```

### 会话切换与中止

- 侧栏选择历史会话只改变 focus；后台 run 和它自己的 fetch controller 继续运行
- 新对话 → 清空 `conversationId`，下次发送创建新会话
- 停止按钮 → EntityBridge 按 active run abort；不会误停其他 conversation 的后台 run

### 文件附件（草稿生命周期）

```
选择/拖拽文件（可多选，同名不去重）
  ↓
ensureSession → POST /api/sessions/ensure（创建/复用 Conversation + Session）
  ↓
attachment draft: queued → uploading → uploaded | failed
  ├── POST /api/files/upload?session_id=xxx (+ Idempotency-Key)
  ├── 不自动发送聊天
  └── 可移除 / 失败重试；上传中或失败时禁用发送
  ↓
用户点击发送 → 文本 + attachment manifest 组成同一 user turn
```

### 文件下载（P7 产物唯一交付）

```
file_ready（仅 submit_artifact 成功后）
  ↓
  有 artifact_id → getArtifactDownloadUrl(sessionId, artifact_id)
  无 artifact_id 仅 path → 兼容 getDownloadUrl（非推荐）
  ↓
render → security.isAllowedApiUrl 校验后生成 <a class="dl" href="/api/...">
```

## 事件绑定

| 交互 | 触发 | 处理 |
|------|------|------|
| 发送消息 | Enter / 发送按钮 | `sendMessage` |
| 中断流 | 停止按钮 | `abortStream` |
| 新行 | Shift+Enter | textarea 默认 |
| 附件 | 按钮 / Ctrl+U / 拖拽 | `handleFilesSelected`（后台上传，不自动发送） |
| 新对话 | 侧栏 New chat | `startNewChat` |
| 切换会话 | 侧栏列表 | `selectConversation` |
| 审批 | 横幅按钮 | `decideApproval` |

## SSE 事件消费

解析见 `frontend/src/shared/sse/parser.ts`；事件类型与 [API 文档](api.md#sse-事件协议) 及 `tests/fixtures/sse_events.json` 对齐：

| 事件类型 | UI 行为 |
|----------|---------|
| `trace` | 记录 `traceId` |
| `session` | 状态栏 session 后 8 位；可带 `conversation_id` / `session_reused` |
| `token` | 增量追加文本到流式气泡 |
| `tool_start` | 工具卡片 running |
| `tool_end` | 工具卡片 complete / error |
| `approval_required` | 审批横幅 |
| `file_ready` | artifact 下载链接 / 交付物列表 |
| `done` | 结束流式 |
| `session_closed` | 状态栏 Session ended |
| `error` | 错误文本 + flash |

## 渲染机制

- `render(state)` — 消息列表与流式气泡
- `incBubble` — 高频 token 增量更新最后一条 assistant
- `rerenderLast` — 工具卡片状态变化时重绘最后一条
- `renderConversationList` / `renderDeliverables` / `showApprovalBanner` — 侧栏与审批
- 文本经 `esc()` 转义；下载链接经 `isAllowedApiUrl` 过滤

## 测试

```bash
npm test --prefix frontend          # node:test — test/*.test.js
npm run build --prefix frontend     # 生产构建（CI 同款）
```

覆盖：SSE 分片/abort/错误、会话切换与 generation、URL/HTML 注入防护、基础 a11y 语义。

## 主题

支持暗色（默认）和亮色主题，通过 CSS `[data-theme]` 切换。

## 键盘快捷键

| 快捷键 | 操作 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `Ctrl+U` | 打开文件选择器上传 |
