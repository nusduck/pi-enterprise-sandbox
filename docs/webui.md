# WebUI Guide

## 概述

v4 前端是一个**纯 UI SPA**，零 Agent 逻辑。Agent 运行在服务端（API Server），前端通过 SSE 消费事件流并渲染。

架构：

```
Browser                  Frontend (Nginx:80)          API Server (Node:4000)
┌──────────────┐  HTTP  ┌──────────────────┐  SSE   ┌──────────────────┐
│ main.js       │◄──────►│ 静态文件服务       │◄──────►│ POST /api/chat   │
│              │        │ /api/* 反向代理    │        │                  │
│ 消息渲染      │        └──────────────────┘        │ SSE event stream │
│ SSE 消费      │        host:3000 → container:80    └──────────────────┘
│ 文件上传/下载  │
│ 拖拽支持      │
└──────────────┘
```

## 目录结构

```
frontend/
├── src/
│   └── main.js              ← 唯一入口（~463 行 vanilla JS）
├── index.html               ← HTML 结构
├── nginx.conf               ← Nginx 配置（/api/* 反向代理，SSE buffering off）
├── vite.config.js           ← Vite dev proxy → localhost:4000
├── package.json             ← @earendil-works/pi-web-ui
├── Dockerfile               ← Nginx + build
└── dist/                    ← Vite 构建产物
```

## 核心架构

### 单文件 SPA

`main.js` 是唯一的前端入口，使用原生 JavaScript（无框架），所有逻辑内联。依赖：

- `@earendil-works/pi-web-ui` — 目前仅引用 CSS 样式（`app.css`），v4 不使用 Web Components

### 状态管理

```javascript
const state = {
  messages: [],            // 消息历史 [{ role, content, _fileLinks }]
  isStreaming: false,      // 是否正在接收 SSE 流
  abortCtrl: null,         // AbortController 引用
  currentMsg: null,        // 流式构建中的 assistant 消息
  sessionId: null,         // Sandbox session ID
  readyFiles: new Set(),   // 已 emit file_ready 的文件路径（去重）
  pendingTool: null,       // 当前工具执行信息 { id, name, args }
};
```

### 消息格式

```javascript
{
  role: 'user' | 'assistant',
  content: [
    { type: 'text', text: '...' },
    { type: 'tool_use', name: 'bash', input: {...}, status: 'running' | 'complete', isError, result },
  ],
  _fileLinks: [{ name: 'file.txt', url: '/api/files/download?...', path: 'file.txt' }],
  stopReason: 'aborted'  // 仅用户中断时
}
```

## 请求流

### 发送消息

```
用户输入 → Enter / 点击发送
  ↓
sendMessage(text)
  ├── 添加 user 消息到 state.messages
  ├── 设置 state.isStreaming = true
  ├── 初始化 state.currentMsg + state.readyFiles
  ├── render() 更新 DOM
  ├── fetch POST /api/chat { messages }
  │     ↓ SSE stream
  │     handleSSE(ev):
  │       session      → 记录 sessionId，更新状态指示
  │       token        → 追加到 currentMsg.content (text delta)
  │       tool_start   → 插入 tool_use 条目（status: running）
  │       tool_end     → 更新 tool_use 条目（status: complete）
  │       file_ready   → 生成下载链接，追加 _fileLinks
  │       done         → 标记完成
  │       session_closed → 状态指示
  │       error        → 错误注入消息
  ├── 将 currentMsg 推入 state.messages
  └── render() 最终渲染
```

### 文件上传

```
拖拽文件 / 点击上传
  ↓
uploadFile(file)
  ├── 添加 user 消息（显示文件名和大小）
  ├── POST /api/files/upload?session_id=xxx (multipart)
  └── 自动发送分析请求
```

### 文件下载

```
file_ready SSE 事件
  ↓
handleSSE → state.currentMsg._fileLinks.push()
  ↓
render() → 生成 <a class="dl" href="/api/files/download?...">⬇ filename</a>
```

## 事件绑定

`init()` 函数负责所有事件绑定：

| 交互 | 触发 | 处理函数 |
|------|------|----------|
| 发送消息 | Enter / 点击发送按钮 | `sendMessage(text)` |
| 中断流 | 流式过程中点击停止 | `cancelStream()` → `abortCtrl.abort()` |
| 新行 | Shift+Enter | textarea 默认行为 |
| 上传文件 | 点击上传按钮 / Ctrl+U | `uploadFile(file)` |
| 拖拽上传 | dragenter / dragover / drop | `uploadFile(file)` |
| 自动调整高度 | textarea input | 动态 height |

## SSE 事件消费

见 `handleSSE(ev)` 函数。支持的 8 种事件类型与 [API 文档](api.md#sse-事件协议) 一致：

| 事件类型 | UI 行为 |
|----------|---------|
| `session` | 更新状态栏显示 session ID 后 8 位 |
| `token` | 增量追加文本到流式消息气泡 |
| `tool_start` | 插入工具调用卡片（带 running 动画） |
| `tool_end` | 更新工具卡片为完成/错误状态 |
| `file_ready` | 生成下载链接 `<a>` 标签 |
| `done` | 结束流式状态 |
| `session_closed` | 状态栏显示 "Session ended" |
| `error` | 错误文本注入消息，红色闪出通知 |

## 渲染机制

- `render()` — 全量渲染：遍历 `state.messages` 构建 DOM
- `incBubble()` — 增量更新：仅更新最后一条 assistant 消息的文本内容（高频率 token 流）
- `rerenderLast()` — 最后一条消息重新渲染（tool card 状态变化）
- `showWelcome()` / `removeWelcome()` — 空状态欢迎页切换

## 主题

支持暗色（默认）和亮色主题，通过 CSS `[data-theme]` 切换。当前版本未暴露切换 UI，默认暗色。

## 键盘快捷键

| 快捷键 | 操作 |
|--------|------|
| `Enter` | 发送消息 |
| `Shift+Enter` | 换行 |
| `Ctrl+U` | 打开文件选择器上传 |
