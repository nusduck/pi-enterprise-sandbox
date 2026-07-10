# WebUI Guide

## 概述

v4 前端是一个**纯 UI SPA**，零 Agent 逻辑。Agent 运行在服务端（API Server；`AGENT_RUNTIME=node|python`），前端通过 SSE 消费事件流并渲染。

架构：

```
Browser                  Frontend (Nginx:80)          API Server (Node:4000)
┌──────────────┐  HTTP  ┌──────────────────┐  SSE   ┌──────────────────┐
│ main.js 编排  │◄──────►│ 静态文件服务       │◄──────►│ POST /api/chat   │
│ state/api/    │        │ /api/* 反向代理    │        │                  │
│ render/sse    │        └──────────────────┘        │ SSE event stream │
│ security      │        host:3000 → container:80    └──────────────────┘
└──────────────┘
```

## 目录结构

```
frontend/
├── src/
│   ├── main.js              ← 入口编排（事件绑定、对话切换、SSE 分发）
│   ├── state.js             ← 状态 + streamGeneration / 会话切换
│   ├── api.js               ← /api/* fetch 与 URL 构造
│   ├── render.js            ← DOM 渲染（消息、侧栏、审批、交付物）
│   ├── sse.js               ← 增量 SSE 解析（分片/UTF-8/abort）
│   ├── security.js          ← /api URL 白名单与转义
│   └── style.css
├── test/                    ← node:test（SSE / state / security）
├── index.html
├── nginx.conf               ← /api/* 反代，SSE buffering off
├── vite.config.js           ← dev proxy → localhost:4000
├── package.json
├── Dockerfile
└── dist/                    ← Vite 构建产物
```

## 核心架构

### 模块边界

| 模块 | 职责 |
|------|------|
| `main.js` | 编排：绑定 UI、调用 api、分发 SSE、驱动 render |
| `state.js` | 单一状态源；`startStream` / `abortStream` / `switchConversation` |
| `api.js` | 协议层：`sendChatMessage`、upload/download、approvals、conversations |
| `sse.js` | 纯解析 + `readSSEStream`（支持分片、CRLF、尾缓冲 flush、abort） |
| `render.js` | DOM：消息气泡、工具卡片、审批横幅、侧栏、交付物列表 |
| `security.js` | `isAllowedApiUrl` / `esc` — 拒绝 `javascript:` 与站外 URL，HTML 转义 |

依赖：

- `@earendil-works/pi-web-ui` — 当前主要引用样式；业务逻辑不依赖其 Web Components
- 生产构建：`npm run build --prefix frontend`（Vite）

### 状态管理

```javascript
// frontend/src/state.js — INITIAL（示意）
{
  messages: [],
  isStreaming: false,
  abortCtrl: null,
  currentMsg: null,
  sessionId: null,
  conversationId: null,
  readyFiles: new Set(),     // file_ready 去重
  pendingTool: null,         // { id, name, args }
  pendingApproval: null,     // 审批横幅
  conversations: [],
  artifacts: [],
  traceId: null,
  sidebarOpen: true,
  streamGeneration: 0,       // 中止/切换会话后丢弃迟到 SSE
}
```

`update(state, patch)` 做浅拷贝并通知订阅者；`streamGeneration` 在 start/abort/switch 时递增，编排层用 `isActiveGeneration` 忽略过期事件。

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
  ├── startStream（bump streamGeneration，AbortController）
  ├── render() 更新 DOM
  ├── api.sendChatMessage → POST /api/chat { messages, conversation_id? }
  │     ↓ SSE (sse.readSSEStream)
  │     handleSSE(ev) 且 isActiveGeneration:
  │       trace             → 记录 traceId
  │       session           → sessionId / conversationId / 状态栏
  │       token             → 追加 text delta
  │       tool_start/end    → 工具卡片 running → complete
  │       approval_required → 审批横幅（approve/reject → /api）
  │       file_ready        → artifact 下载链接 → _fileLinks / deliverables
  │       done / error      → 结束流或注入错误
  │       session_closed    → 状态指示
  ├── endStream / errorStream
  └── render() 最终渲染
```

### 会话切换与中止

- 侧栏选择历史会话 → `switchConversation`：abort 在途流、清空 ephemeral（tokens/approvals/artifacts）、从服务端加载消息
- 新对话 → 清空 `conversationId`，下次发送创建新会话
- 停止按钮 → `abortStream` + `abortCtrl.abort()`，迟到 SSE 因 generation 失效被忽略

### 文件上传

```
拖拽 / 点击上传
  ↓
uploadFile(file)
  ├── user 消息展示文件名与大小
  ├── POST /api/files/upload?session_id=xxx (multipart)
  └── 可选自动跟进分析请求
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
| 上传 | 按钮 / Ctrl+U / 拖拽 | `uploadFile` |
| 新对话 | 侧栏 New chat | `startNewChat` |
| 切换会话 | 侧栏列表 | `selectConversation` |
| 审批 | 横幅按钮 | `decideApproval` |

## SSE 事件消费

解析见 `frontend/src/sse.js`；事件类型与 [API 文档](api.md#sse-事件协议) 及 `tests/fixtures/sse_events.json` 对齐：

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
