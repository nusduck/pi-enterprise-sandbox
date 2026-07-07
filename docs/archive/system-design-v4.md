# Pi Enterprise Sandbox — System Design

> 版本：v4.0 · 2026-07-04
> 状态：🟢 已实施（设计参考，最新文档见 [README.md](../README.md) 和 [docs/](.))

---

## 一、系统总览

### 架构图

```
                    ====== 前端层 ======

                        用户浏览器
              ┌───────────────────────────────────────────────┐
              │  pi-web-ui 组件（@earendil-works/pi-web-ui）   │
              │                                               │
              │  纯 UI 层，零 Agent 逻辑                       │
              │                                               │
              │  MessageList    ← 消息渲染                     │
              │  MessageEditor  ← 输入框                       │
              │  BashRenderer   ← 工具结果渲染                  │
              │  ...                                          │
              │                                               │
              │  Vite dev server (dev) / Nginx (prod)         │
              │  端口 5173 (dev) / 80 (prod)                  │
              └──────────────────┬────────────────────────────┘
                                 │ POST /api/chat
                                 │ Content-Type: text/event-stream
                                 │
                    ====== 后端层 ======
                                 │
┌────────────────────────────────────────────────────────────┐
│  API Server (Node.js 20-slim)                               │
│  端口 4000                                                  │
│                                                             │
│  纯 REST API — 不提供任何静态文件                             │
│                                                             │
│  server.js                                                  │
│  ├─ POST /api/chat                                         │
│  │    └─ createAgentSession() ← @earendil-works/pi-coding-agent│
│  │       ├─ AgentSession 管理完整对话循环                    │
│  │       ├─ 4 个内置工具 (read/write/edit/bash)             │
│  │       │   └─ 重定向到 Sandbox API                         │
│  │       ├─ LLM 调用（pi-ai 直连，无代理）                    │
│  │       ├─ 事件 → SSE 流回前端                              │
│  │       └─ 一次 prompt 用完即弃（无状态）                   │
│  │                                                          │
│  ├─ GET  /api/status        ← 健康检查                      │
│  └─ GET  /api/config        ← 运行时配置（可选）             │
│                                                             │
│  核心文件:                                                  │
│  ├─ server.js              ← HTTP 入口 + 路由               │
│  ├─ agent-handler.js       ← pi-coding-agent 封装           │
│  └─ sandbox-tools.js       ← 4 个 Sandbox 工具              │
│                                                             │
│  部署: api-server/Dockerfile                                 │
└──────────────────────┬─────────────────────────────────────┘
                       │ HTTP (Docker 内网)
                       ▼
┌──────────────────────────────────────────────────────┐
│  pi-enterprise-sandbox (Python 3.11 / FastAPI)        │
│  端口 8081（仅内网）                                    │
│                                                       │
│  安全隔离执行环境                                       │
│  ├─ /health                                           │
│  ├─ /sessions                                         │
│  ├─ /sessions/{id}/executions/command                  │
│  ├─ /sessions/{id}/files/read?path=                   │
│  ├─ /sessions/{id}/files/write                        │
│  └─ 安全防护                                          │
│      ├─ iptables 默认 DROP 策略（无出站网络）            │
│      ├─ ulimit 限制 CPU/内存/进程数                     │
│      ├─ 非 root 用户执行                               │
│      ├─ 路径逃逸检测                                   │
│      └─ 审计日志                                       │
│                                                       │
│  部署: sandbox/Dockerfile                               │
└──────────────────────────────────────────────────────┘

                    LLM API (外部)
          https://llm.009100.xyz/openai/v1/
               ↑
        pi-coding-agent 直连（API Server 内）
        API Key 仅环境变量，不离开服务器
```

### 核心设计原则

| 原则 | 说明 |
|------|------|
| **前后端分离** | 前端纯静态 SPA，后端纯 REST API。不同进程、不同容器、可独立部署 |
| **前端零 Agent** | 前端只使用 pi-web-ui 的 UI 组件，不 import pi-agent-core、pi-ai，不管理任何 Agent 状态 |
| **SSE 驱动渲染** | 后端通过 SSE 推送事件，前端直接消费更新 MessageList |
| **pi-coding-agent SDK** | 后端使用 `@earendil-works/pi-coding-agent` 的 `createAgentSession()` 驱动完整 Agent 循环 |
| **内置工具重定向** | read/write/edit/bash 四工具的 `execute()` 调用 Sandbox HTTP API |
| **API Key 仅存服务端** | 通过环境变量注入 pi-coding-agent，浏览器零接触 |
| **3 容器隔离** | Frontend (Nginx) + API Server (Node.js) + Sandbox (Python)，各自独立容器 |
| **Sandbox 内网隔离** | Sandbox 不对外暴露端口，仅 API Server 通过 Docker 内网访问 |

---

## 二、组件关系

```
┌──────────────────────────────────────────────────┐
│                   前端依赖链                       │
│                                                  │
│  frontend/package.json                           │
│  └── @earendil-works/pi-web-ui                   │
│       ├── MessageList        ← 消息列表渲染       │
│       ├── MessageEditor      ← 输入框             │
│       ├── StreamingMessageContainer ← 流式消息    │
│       ├── BashRenderer       ← bash 工具渲染      │
│       └── DefaultRenderer    ← 通用工具渲染       │
│                                                  │
│  无需: pi-agent-core, pi-ai, pi-tui, storage     │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│                   后端依赖链                       │
│                                                  │
│  api-server/package.json                         │
│  └── @earendil-works/pi-coding-agent             │
│       ├── createAgentSession()  ← SDK 入口       │
│       ├── AgentSession         ← 会话管理         │
│       ├── Agent (pi-agent-core) ← Agent 循环     │
│       ├── pi-ai                 ← LLM 调用        │
│       ├── SessionManager       ← 会话存储         │
│       └── ModelRegistry/AuthStorage ← 模型+认证  │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│                通信协议                           │
│                                                  │
│  前端 → 后端: POST /api/chat                      │
│    Content-Type: application/json                  │
│    Body: { model, messages, systemPrompt }         │
│                                                  │
│  后端 → 前端: SSE (text/event-stream)              │
│    data: {"type":"token","text":"hello"}          │
│    data: {"type":"tool_start","name":"bash",...}  │
│    data: {"type":"tool_end","name":"bash",...}    │
│    data: {"type":"done"}                          │
│                                                  │
│  后端 → Sandbox: HTTP REST                        │
│    POST /sessions/{id}/executions/command          │
│    GET  /sessions/{id}/files/read?path=           │
│    POST /sessions/{id}/files/write                │
└──────────────────────────────────────────────────┘
```

---

## 三、详细流

### 3.1 一次完整对话

```
用户输入 "写一个 Python 脚本计算斐波那契数列"
    │
    ├─► 前端 MessageEditor 捕获输入
    │   ├── 拼接消息数组
    │   └── POST /api/chat
    │       { messages: [..., {role:"user", content:"..."}] }
    │
    ├─► API Server 收到请求
    │   ├── createAgentSession() ← pi-coding-agent SDK
    │   │   ├── model: 前端的模型选择
    │   │   ├── tools: [read, write, edit, bash] ← Sandbox 实现
    │   │   └── messages: 对话历史
    │   │
    │   ├── session.prompt("写个Python...")
    │   │   │
    │   │   ├── Round 1: LLM 响应
    │   │   │   ├── pi-ai 直连 LLM API → 流式 response
    │   │   │   ├── SSE: { type: "token", text: "当然，我来写..." }
    │   │   │   ├── SSE: { type: "token", text: "```python\ndef fib..." }
    │   │   │   └── LLM 返回 tool_call: bash
    │   │   │
    │   │   ├── Round 2: 执行 bash 工具
    │   │   │   ├── SSE: { type: "tool_start", name: "bash", args: "python3 fib.py" }
    │   │   │   ├── sandboxBashTool.execute()
    │   │   │   │   └── POST sandbox:8081/sessions/{sid}/executions/command
    │   │   │   └── SSE: { type: "tool_end", name: "bash", result: {...} }
    │   │   │
    │   │   └── Round 3: LLM 总结
    │   │       ├── pi-ai 再次调用 LLM（带工具结果）
    │   │       ├── SSE: { type: "token", text: "脚本已运行，输出: 0,1,1,2,3,5..." }
    │   │       └── Agent 结束
    │   │
    │   └── SSE: { type: "done" }
    │
    └─► 前端消费 SSE
        ├── token → 追加到当前消息文本
        ├── tool_start → 显示工具调用卡片
        ├── tool_end → 显示工具执行结果
        ├── done → 完成渲染
        └── MessageList 自动更新
```

### 3.2 SSE 事件协议

```
事件类型:
  token       { text: string }                      ← LLM 文本增量
  tool_start  { id, name, args }                    ← 工具开始执行
  tool_end    { id, name, result, isError }         ← 工具执行完成
  done        {}                                    ← Agent 回合结束

示例流:
  data: {"type":"token","text":"我来帮你写"}
  data: {"type":"token","text":"一个Python脚本"}
  data: {"type":"tool_start","id":"call_1","name":"bash","args":"python3 fib.py"}
  data: {"type":"tool_end","id":"call_1","name":"bash","result":{"exit_code":0,"stdout":"0,1,1,2,3"}}
  data: {"type":"token","text":"脚本已成功运行"}
  data: {"type":"done"}
```

---

## 四、前端设计

### 4.1 目录结构

```
frontend/
├── src/
│   └── main.js              ← 唯一入口
├── index.html
├── vite.config.js           ← Vite dev proxy: /api/* → localhost:4000
├── package.json
│   └── @earendil-works/pi-web-ui
├── dist/                    ← Vite 构建产物
├── Dockerfile               ← Nginx + dist/
└── nginx.conf               ← 反向代理 /api/* → api-server:4000
```

### 4.2 main.js — 完整前端代码

```javascript
import {
  MessageList,
  MessageEditor,
  StreamingMessageContainer,
  formatUsage,
} from "@earendil-works/pi-web-ui";
import "@earendil-works/pi-web-ui/app.css";

const API_BASE = import.meta.env.DEV ? "/api" : "/api";

// ── 状态管理（纯前端，无 Agent） ──────────────────
let messages = [];
let isStreaming = false;
let streamingMessage = null;
let currentAbortController = null;

// ── UI 引用 ────────────────────────────────────
const app = document.getElementById("app");
const messageList = document.createElement("message-list");
const streamingContainer = document.createElement("streaming-message-container");
const messageEditor = document.createElement("message-editor");

// ── SSE 流消费 ──────────────────────────────────
async function sendMessage(text) {
  if (!text.trim() || isStreaming) return;

  // 添加用户消息
  messages.push({ role: "user", content: text, timestamp: Date.now() });
  messageList.messages = [...messages];
  messageEditor.value = "";

  isStreaming = true;
  currentAbortController = new AbortController();
  streamingContainer.isStreaming = true;
  streamingContainer.classList.remove("hidden");

  try {
    const response = await fetch(API_BASE + "/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages,
        model: { id: "deepseek-v4-flash", provider: "llmio" },
      }),
      signal: currentAbortController.signal,
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6));

        switch (event.type) {
          case "token":
            if (!streamingMessage) {
              streamingMessage = { role: "assistant", content: "", timestamp: Date.now() };
            }
            streamingMessage.content += event.text;
            streamingContainer.setMessage(streamingMessage, false);
            break;

          case "tool_start":
            // 显示工具开始执行的 UI 提示
            break;

          case "tool_end":
            // 工具结果会被整合进 assistant 消息中
            break;

          case "done":
            // 完成
            break;
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") console.error(err);
  } finally {
    if (streamingMessage) {
      messages.push(streamingMessage);
      messageList.messages = [...messages];
    }
    streamingMessage = null;
    streamingContainer.isStreaming = false;
    streamingContainer.classList.add("hidden");
    streamingContainer.setMessage(null, true);
    isStreaming = false;
    currentAbortController = null;
    messageList.requestUpdate();
  }
}

// ── 挂载 UI ─────────────────────────────────────
messageEditor.onSend = sendMessage;
messageEditor.onAbort = () => currentAbortController?.abort();

app.appendChild(messageList);
app.appendChild(streamingContainer);
app.appendChild(messageEditor);
```

### 4.3 前端零 Agent 的收益

| 因素 | 当前（有 Agent） | v4（无 Agent） |
|------|-----------------|----------------|
| 依赖数 | pi-agent-core + pi-ai + pi-web-ui + storage | **只依赖 pi-web-ui** |
| JS Bundle | 大（含完整 Agent 循环） | **小（仅 UI 组件）** |
| API Key 暴露 | `getApiKey` 机制 | **浏览器零接触** |
| CORS 问题 | 需代理或 streamFn | **不调用 LLM，无 CORS** |
| 复杂度 | Agent 状态同步、事件订阅 | **直接消费 SSE，自己管状态** |

---

## 五、后端设计

### 5.1 目录结构

```
api-server/
├── server.js                ← HTTP 入口 + 路由
├── agent-handler.js         ← pi-coding-agent SDK 封装
├── sandbox-tools.js         ← 4 个 Sandbox 工具
├── package.json
│   └── @earendil-works/pi-coding-agent
├── Dockerfile
└── .env
```

### 5.2 server.js

```javascript
import http from "node:http";
import { handleChat } from "./agent-handler.js";

const PORT = process.env.PORT || 4000;

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  try {
    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readBody(req);
      await handleChat(body, res);
      return;
    }

    if (url.pathname === "/api/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: "4.0.0" }));
      return;
    }

    res.writeHead(404); res.end("Not found");
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => console.log("[api] Server on", PORT));
```

### 5.3 agent-handler.js

```javascript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { sandboxTools } from "./sandbox-tools.js";

export async function handleChat(body, res) {
  const { messages, model } = body;

  // SSE 响应头
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
  });

  const sse = (event) => { res.write(`data: ${JSON.stringify(event)}\n\n`); };

  try {
    // 创建 pi-coding-agent 会话
    const { session } = await createAgentSession({
      model,
      tools: sandboxTools,
      sessionManager: SessionManager.inMemory(),
    });

    // 事件 → SSE
    session.subscribe((event) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            sse({ type: "token", text: event.assistantMessageEvent.delta });
          }
          break;
        case "tool_execution_start":
          sse({ type: "tool_start", id: event.toolCallId, name: event.toolName, args: event.args });
          break;
        case "tool_execution_end":
          sse({ type: "tool_end", id: event.toolCallId, name: event.toolName,
            result: event.result, isError: event.isError });
          break;
      }
    });

    // 执行 prompt
    const lastMessage = messages[messages.length - 1];
    await session.prompt(lastMessage.content);

    sse({ type: "done" });
  } catch (err) {
    sse({ type: "error", message: err.message });
  } finally {
    res.end();
  }
}
```

### 5.4 sandbox-tools.js

```javascript
import { Type } from "typebox";

const SANDBOX = process.env.SANDBOX_BASE_URL || "http://sandbox:8081";
const SANDBOX_TOKEN = process.env.SANDBOX_API_TOKEN || "";

function sb(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (SANDBOX_TOKEN) headers["X-API-Key"] = SANDBOX_TOKEN;
  return fetch(SANDBOX + path, { ...opts, headers });
}

// 每个请求一个会话 ID（可由 agent-handler 管理）
let currentSessionId = null;
export function setSessionId(sid) { currentSessionId = sid; }

export const sandboxTools = [
  {
    name: "read",
    label: "Read File",
    description: "Read file contents from the sandbox workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "File path (relative to workspace)" }),
      offset: Type.Optional(Type.Number()),
      limit: Type.Optional(Type.Number()),
    }),
    execute: async (_, params) => {
      const q = new URLSearchParams({ path: params.path });
      const r = await (await sb(`/sessions/${currentSessionId}/files/read?${q}`)).json();
      return { content: [{ type: "text", text: r.content || "" }], details: { size: r.size } };
    },
  },
  {
    name: "write",
    label: "Write File",
    description: "Write content to a file in the sandbox workspace.",
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      content: Type.String({ description: "Content to write" }),
    }),
    execute: async (_, params) => {
      const r = await (await sb(`/sessions/${currentSessionId}/files/write`, {
        method: "POST", body: JSON.stringify(params),
      })).json();
      return { content: [{ type: "text", text: `Written ${r.size} bytes to ${params.path}` }], details: { size: r.size } };
    },
  },
  {
    name: "edit",
    label: "Edit File",
    description: "Find-and-replace edit on a file in the sandbox.",
    parameters: Type.Object({
      path: Type.String({ description: "File path" }),
      old_string: Type.String({ description: "Text to find" }),
      new_string: Type.String({ description: "Replacement text" }),
    }),
    execute: async (_, params) => {
      const q = new URLSearchParams({ path: params.path });
      const file = await (await sb(`/sessions/${currentSessionId}/files/read?${q}`)).json();
      const content = (file.content || "").replace(params.old_string, params.new_string);
      await sb(`/sessions/${currentSessionId}/files/write`, {
        method: "POST", body: JSON.stringify({ path: params.path, content }),
      });
      return { content: [{ type: "text", text: `Replaced in ${params.path}` }], details: { path: params.path } };
    },
  },
  {
    name: "bash",
    label: "Run Command",
    description: "Run a shell command in the sandbox (Python, bash, node, etc).",
    parameters: Type.Object({
      command: Type.String({ description: "Shell command" }),
      timeout: Type.Optional(Type.Number({ description: "Seconds (max 300)" })),
    }),
    execute: async (_, params) => {
      const r = await (await sb(`/sessions/${currentSessionId}/executions/command`, {
        method: "POST", body: JSON.stringify({ command: params.command, timeout: params.timeout || 120 }),
      })).json();
      const out = [r.stdout_preview, r.stderr_preview].filter(Boolean).join("\n\n") || "(no output)";
      const isErr = r.exit_code != null && r.exit_code !== 0;
      return { content: [{ type: "text", text: out }], details: { exit_code: r.exit_code, duration_ms: r.duration_ms }, isError: isErr };
    },
  },
];
```

---

## 六、容器与部署

### 6.1 三容器架构

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Frontend   │     │  API Server  │     │   Sandbox    │
│              │     │              │     │              │
│  Nginx       │────▶│  Node.js     │────▶│  FastAPI     │
│  port 80     │     │  port 4000   │     │  port 8081   │
│              │     │              │     │              │
│  /api/* 代理  │     │  pi-coding   │     │  iptables    │
│  → api:4000  │     │  -agent SDK  │     │  ulimit      │
│              │     │              │     │               │
│  dist/       │     │  only REST   │     │  no expose   │
│  静态 SPA    │     │  no static   │     │  仅内网      │
└──────────────┘     └──────────────┘     └──────────────┘
```

### 6.2 docker-compose.yml

```yaml
services:
  frontend:
    build: ./frontend
    container_name: pi-enterprise-frontend
    ports:
      - "80:80"
    depends_on:
      - api-server

  api-server:
    build: ./api-server
    container_name: pi-enterprise-api
    env_file: .env
    environment:
      SANDBOX_BASE_URL: http://sandbox:8081
      LLMIO_BASE_URL: https://llm.009100.xyz/openai/v1
      LLMIO_API_KEY: ***
      PORT: 4000
    depends_on:
      sandbox:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:4000/api/status"]

  sandbox:
    build: ./sandbox
    container_name: pi-enterprise-sandbox
    # 不对外暴露端口
    volumes:
      - ./workspaces:/sandbox/workspaces
    cap_add:
      - NET_ADMIN
      - NET_RAW
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/health"]

volumes:
  workspaces:
```

### 6.3 端口映射

| Host 端口 | 容器 | 容器端口 | 用途 |
|-----------|------|----------|------|
| 80 | frontend | 80 | WebUI（唯一面向用户的端口） |
| — | api-server | 4000 | REST API（仅内网，不暴露） |
| — | sandbox | 8081 | Sandbox API（仅内网，不暴露） |

### 6.4 关键环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLMIO_BASE_URL` | `https://llm.009100.xyz/openai/v1` | LLM API 基地址 |
| `LLMIO_API_KEY` | — | LLM API 密钥（仅服务端） |
| `SANDBOX_BASE_URL` | `http://sandbox:8081` | Sandbox 容器内地址 |
| `MODEL_ID` | `deepseek-v4-flash` | 默认 LLM 模型 |

---

## 七、目录结构

```
pi-sandbox/
├── docker-compose.yml            # 3 容器编排
├── .env                          # 环境变量

├── frontend/                     # 前端 SPA
│   ├── Dockerfile                # Nginx
│   ├── nginx.conf                # /api/* → api-server:4000
│   ├── package.json
│   │   └── @earendil-works/pi-web-ui
│   ├── vite.config.js
│   ├── index.html
│   ├── src/
│   │   └── main.js               # 唯一前端逻辑
│   └── dist/

├── api-server/                   # 后端 API
│   ├── Dockerfile
│   ├── package.json
│   │   └── @earendil-works/pi-coding-agent
│   ├── server.js
│   ├── agent-handler.js
│   └── sandbox-tools.js

├── sandbox/                      # Sandbox Python 服务
│   ├── Dockerfile
│   ├── entrypoint.sh
│   ├── requirements.txt
│   ├── main.py
│   ├── config.py
│   ├── database.py
│   ├── models.py
│   ├── repositories.py
│   ├── trace.py
│   ├── routers/
│   ├── services/
│   ├── security/
│   ├── mcp/
│   └── utils/

├── skills/
├── workspaces/
├── config/agent/
├── data/
└── docs/
    └── system-design.md
```

---

## 八、SSE 事件协议参考

### 事件类型

```typescript
type SSEEvent =
  | { type: "token";      text: string }
  | { type: "tool_start"; id: string; name: string; args: any }
  | { type: "tool_end";   id: string; name: string; result: any; isError: boolean }
  | { type: "done" }
  | { type: "error";      message: string };
```

### 前端消费伪代码

```javascript
const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  buffer += decoder.decode(value, { stream: true });
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const event = JSON.parse(line.slice(6));

    switch (event.type) {
      case "token":
        streamingMsg.content += event.text;
        break;
      case "tool_start":
        showToolCard(event.name, event.args);
        break;
      case "tool_end":
        updateToolResult(event.id, event.result);
        break;
    }
  }
}
```

---

## 九、实施步骤

### Phase 1: 重构目录

1. 从 `webui/` 分离为 `frontend/` 和 `api-server/`
2. 创建 `frontend/Dockerfile` + `nginx.conf`
3. 创建 `api-server/Dockerfile`

### Phase 2: 前端

4. 精简 `package.json`（移除 pi-agent-core、pi-ai）
5. 重写 `main.js`（纯 UI + SSE）
6. 配置 `vite.config.js`（proxy /api/*）

### Phase 3: 后端

7. 安装 `@earendil-works/pi-coding-agent`
8. 写 `sandbox-tools.js`
9. 写 `agent-handler.js`
10. 写 `server.js`

### Phase 4: 上线

11. 更新 `docker-compose.yml`
12. 端到端测试
