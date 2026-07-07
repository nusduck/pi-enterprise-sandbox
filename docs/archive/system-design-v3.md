# Pi Enterprise Sandbox — System Design v3

> 版本：v3.0 · 2026-07-04
> 状态：🟡 设计阶段（建议架构，待实施）

---

## 一、系统总览

### 1.1 架构图

```
                        用户浏览器
              ┌──────────────────────────────────┐
              │  Thin ChatPanel (pi-web-ui)      │
              │                                  │
              │  仅负责渲染 + 输入捕获             │
              │  POST /api/chat { message }       │
              │  ← SSE stream (text + tool events)│
              └──────────────┬───────────────────┘
                             │ HTTP / SSE
                             ▼
┌──────────────────────────────────────────────────────┐
│  pi-enterprise-agent (Node.js 20-slim)                │
│                                                       │
│  server.js ─── Agent Runtime (pi-agent-core)          │
│                                                       │
│  ┌─────────────────────────────────────────────┐     │
│  │  Agent Runtime (Node.js 进程内)              │     │
│  │  ├─ 消息编排                                 │     │
│  │  ├─ tool call 调度                           │     │
│  │  ├─ pi-ai ← 直连 LLM API（无代理层）          │     │
│  │  ├─ SandboxClient ← 直连 Sandbox（无代理层）   │     │
│  │  └─ SSE 流式推送 → 浏览器                     │     │
│  └─────────────────────────────────────────────┘     │
│                                                       │
│  路由表:                                              │
│  ├─ POST /api/chat          → 创建 Agent + SSE 流     │
│  ├─ POST /api/sessions      → 创建 Sandbox 会话       │
│  ├─ GET  /api/conversations → 对话列表                │
│  ├─ POST /api/conversations → 创建对话                │
│  ├─ GET  /api/status        → 健康检查                │
│  └─ 静态文件服务 (dist/)                              │
│                                                       │
│  主机映射: host:3000 → container:3000                 │
└──────────────────────────┬───────────────────────────┘
                           │ HTTP (Docker 内网)
                           ▼
┌──────────────────────────────────────────────────────┐
│  pi-enterprise-sandbox (Python 3.11 / FastAPI)        │
│                                                       │
│  HTTP API (port 8081)  host:8083 → container:8081     │
│  ├─ /health            ← 健康检查                     │
│  ├─ /sessions          ← 会话 CRUD                    │
│  ├─ /sessions/:id/executions  ← 命令/代码执行          │
│  ├─ /sessions/:id/files      ← 文件读写                │
│  └─ /sessions/:id/artifacts  ← 产物注册/查询           │
│                                                       │
│  安全层:                                              │
│  ├─ iptables 默认 DROP 策略（无出站网络）               │
│  ├─ ulimit 限制 CPU/内存/进程数                        │
│  ├─ 非 root 用户执行 (`sandbox` user)                  │
│  ├─ 路径逃逸检测 (resolve + is_relative_to)            │
│  └─ 审计日志 (每次执行记录 trace_id)                   │
└──────────────────────────────────────────────────────┘

                    LLM API (外部)
          https://llm.009100.xyz/openai/v1/
          /chat/completions
               ↑
        pi-agent-core 直连（服务器端）
        (API Key = 环境变量，不外泄，无 CORS 问题)
```

### 1.2 核心设计原则

| 原则 | 说明 |
|------|------|
| **服务端 Agent 运行时** | `pi-agent-core` 在 Node.js 进程中运行，浏览器仅为 UI 壳 |
| **SSE 流式推送** | Agent 回复通过 Server-Sent Events 推送到浏览器，无需 WebSocket |
| **API Key 仅存服务端** | LLM API Key 在 server.js 环境变量中，浏览器不可见 |
| **直连无代理** | Agent → LLM、Agent → Sandbox 均为服务端直连，无 HTTP 代理层 |
| **双容器隔离** | Agent (Node.js) 与 Sandbox (Python FastAPI) 分离，独立构建、扩容、更新 |
| **纯 HTTP 无框架** | server.js 使用原生 `node:http`，无需 Express/Koa，减少依赖和攻击面 |
| **多层沙箱安全** | Docker 隔离 + iptables 防火墙 + ulimit 资源限制 + 非 root 用户 + 路径验证 |

---

## 二、vs v2：核心架构变化

| 维度 | v2（当前实现） | v3（目标架构） | 改进 |
|------|---------------|----------------|------|
| **Agent 运行时位置** | 浏览器 `main.js` 中 | 服务端 `server.js` 中 | ✅ 消除 BFF 代理层 |
| **LLM 调用路径** | `pi-ai` → `/api/proxy/llm/*` → server.js 转发 → LLM | `pi-ai` 直连 LLM API | ✅ 减少 1 跳 + 消除代理代码 |
| **`dangerouslyAllowBrowser`** | ✅ 使用（安全妥协） | ❌ 不需要 | ✅ 消除安全反模式 |
| **Sandbox 调用路径** | 浏览器 `tool.execute` → `/api/sessions/*` → server.js 转发 → Sandbox | Agent 内直接调用 SandboxClient | ✅ 减少 1 跳 |
| **API Key 暴露面** | `GET /api/config` 返回给浏览器（含占位符） | 不返回任何 Key 相关内容 | ✅ 更安全 |
| **工具执行** | 浏览器中的 Agent 发起 fetch | Node.js 中的 Agent 直接 HTTP 调用 | ✅ 更可靠，网络诊断简单 |
| **多用户隔离** | 各浏览器实例独立 | 服务端统一管理会话 | ✅ 可扩展 |

---

## 三、容器架构

### 3.1 pi-enterprise-agent (Node.js 20-slim)

```
pi-enterprise-agent              ← Docker 容器
└── /home/pi-agent/
    ├── server.js                ← HTTP 入口 + Agent Runtime 宿主
    ├── agent.js                 ← pi-agent-core 封装
    ├── sandbox-client.js        ← Sandbox HTTP 客户端（服务端直连）
    ├── package.json             ← 含 pi-agent-core + pi-ai（服务端依赖）
    │                              （pi-web-ui 仅前端，Vite 构建产物）
    ├── vite.config.js           ← Vite 构建配置
    ├── index.html               ← HTML 入口
    ├── src/
    │   └── main.js              ← 薄前端：仅渲染 ChatPanel + SSE 消费
    ├── dist/                    ← Vite 构建产物 (server.js 静态服务)
    └── node_modules/
```

**核心依赖（服务端）：**

| 包 | 版本 | 用途 |
|----|------|------|
| `@earendil-works/pi-agent-core` | ^0.80.3 | Agent 运行时（服务端进程内运行） |
| `@earendil-works/pi-ai` | ^0.80.3 | LLM Provider 实现（服务端直连） |

**核心依赖（前端）：**

| 包 | 版本 | 用途 |
|----|------|------|
| `@earendil-works/pi-web-ui` | ^0.75.3 | ChatPanel Web Component（仅渲染层，不创建 Agent） |

**server.js 路由表：**

| 路径 | 方法 | 说明 |
|------|------|------|
| `POST /api/chat` | POST | **核心入口**：创建/复用 Agent，流式返回 SSE |
| `POST /api/sessions` | POST | 创建 Sandbox 会话 |
| `GET /api/conversations` | GET | 对话列表 |
| `POST /api/conversations` | POST | 创建新对话 |
| `DELETE /api/conversations/:id` | DELETE | 删除对话 |
| `GET /api/conversations/:id/messages` | GET | 获取历史消息 |
| `GET /api/status` | GET | 聚合健康检查 |
| `GET /` + 静态资源 | GET | 静态文件服务 |

> **v3 对比 v2：** 移除了 `/api/proxy/llm/*`（不再需要 LLM 代理层）、移除了 `/api/config`（浏览器不再需要 LLM 配置）、新增了 `POST /api/chat`（Agent 运行入口）。

### 3.2 pi-enterprise-sandbox (Python 3.11 / FastAPI)

（与 v2 一致，无变化）

```
pi-enterprise-sandbox             ← Docker 容器
├── /app/
│   ├── main.py                   ← FastAPI 入口 + 路由注册
│   ├── config.py                 ← 环境变量配置管理
│   ├── database.py               ← SQLite (WAL mode) / PostgreSQL 兼容抽象
│   ├── models.py                 ← Pydantic 数据模型
│   ├── repositories.py           ← Repository 模式（数据访问层）
│   ├── trace.py                  ← 分布式追踪 (trace_id)
│   ├── routers/
│   │   ├── health.py             ← /health, /ready
│   │   ├── sessions.py           ← /sessions CRUD
│   │   ├── executions.py         ← /sessions/{id}/executions
│   │   ├── files.py              ← /sessions/{id}/files
│   │   └── artifacts.py          ← /sessions/{id}/artifacts
│   ├── services/
│   │   ├── session_manager.py    ← 会话生命周期管理
│   │   ├── execution_manager.py  ← 命令/代码执行引擎
│   │   ├── file_manager.py       ← 文件读写操作
│   │   ├── artifact_manager.py   ← 产物注册/查询
│   │   ├── policy_checker.py     ← 命令风险等级评估
│   │   ├── audit_logger.py       ← 审计日志记录
│   │   └── workspace_manager.py  ← 工作区目录管理
│   ├── security/
│   │   ├── path_validation.py    ← 路径逃逸检测
│   │   └── safe_env.py           ← 安全环境配置
│   ├── mcp/
│   │   └── server.py             ← MCP 协议适配器 (port 8091)
│   ├── utils/
│   │   └── resource_limits.py    ← ulimit 资源限制
│   └── entrypoint.sh             ← 容器启动脚本 (iptables 初始化 + uvicorn)
├── /sandbox/skills/              ← 技能文件 (只读挂载卷)
├── /sandbox/workspaces/          ← 会话工作区 (持久化挂载卷)
└── /sandbox/data/                ← SQLite 数据库文件 (持久化卷)
```

---

## 四、请求流详解

### 4.1 一次完整对话周期（v3）

```
用户输入 "写一个 Python 脚本计算斐波那契数列"
    │
    ├─► 浏览器 ChatPanel 捕获输入
    │   ├── 清空输入框
    │   └── POST /api/chat { conversationId, message }
    │       响应: SSE stream (Content-Type: text/event-stream)
    │
    ├─► server.js 收到请求
    │   ├── 查找/创建 Conversation 对象
    │   ├── 创建/复用 Agent 实例 (pi-agent-core)
    │   │   (Agent 在 Node.js 进程内，非浏览器)
    │   ├── 调用 agent.prompt(userMessage)
    │   │
    │   ├─► Agent 回合开始
    │   │   ├── 创建 Sandbox 会话（首条消息时）
    │   │   │   └── HTTP POST → sandbox:8081/sessions
    │   │   ├── convertToLlm(message)
    │   │   └── pi-ai.streamFunction()
    │   │       └── HTTPS POST → llm.009100.xyz/openai/v1/chat/completions
    │   │           (直连，无代理跳转，无 CORS)
    │   │
    │   ├─► Agent 解析流式事件
    │   │   ├── text_delta  → SSE event: {"type":"token","text":"..."}
    │   │   │                  → 浏览器 ChatPanel 实时渲染
    │   │   └── tool_call   → 触发工具执行
    │   │
    │   ├─► Agent 调用 bash 工具
    │   │   ├── SandboxClient.execute("bash", {command, timeout})
    │   │   └── HTTP POST → sandbox:8081/sessions/{sid}/executions/command
    │   │       (Agent 内直接调用，非浏览器发请求)
    │   │
    │   ├─► 工具结果注入 Agent context
    │   │   └── SSE event: {"type":"tool_result","name":"bash","output":"..."}
    │   │
    │   └─► Agent 生成最终回复
    │       └── SSE event: {"type":"done","text":"..."}
    │           → 浏览器 ChatPanel 显示完整回复
    │
    └─► SSE 流结束，连接关闭
```

### 4.2 v2 vs v3 调用路径对比

```
v2（当前）:
  用户消息 → 浏览器 ChatPanel
    → Agent (pi-agent-core 在浏览器)
    → pi-ai (浏览器) → /api/proxy/llm (server.js 代理) → LLM API
    → tool call → /api/sessions/... (server.js 代理) → Sandbox
    → 响应原路返回 → ChatPanel 渲染
  ❌ 代理 2 层（LLM + Sandbox），2 次 HTTP 转发
  ❌ dangerouslyAllowBrowser: true
  ❌ API Key 通过 GET /api/config 暴露到前端 JS

v3（目标）:
  用户消息 → 浏览器 ChatPanel
    → POST /api/chat → server.js
    → Agent (pi-agent-core 在 Node.js)
    → pi-ai (Node.js) → 直连 LLM API
    → tool call → 直连 Sandbox
    → SSE 流 → ChatPanel 渲染
  ✅ 零代理层，Agent 直连所有后端
  ✅ 无需 dangerouslyAllowBrowser
  ✅ API Key 永远不会离开服务器进程
```

---

## 五、WebUI 前端架构 (pi-web-ui)

### 5.1 角色变化：从 Agent 宿主 → 薄渲染层

| 职责 | v2（浏览器含 Agent） | v3（浏览器仅 UI） |
|------|---------------------|--------------------|
| LLM 调用 | 浏览器发起，经代理转发 | ❌ 不涉及，完全在服务端 |
| 工具执行调度 | 浏览器 Agent 编排 | ❌ 不涉及，完全在服务端 |
| SSE 消费 | 无独立模块，pi-web-ui 内置 | ✅ 原生 EventSource / fetch SSE |
| 消息渲染 | pi-web-ui ChatPanel | ✅ 不变（纯渲染层） |
| 对话管理 | 前端 localStorage + IndexedDB | ✅ 服务端管理 + SSE 驱动 |
| API Key 接触 | 运行时获取（`GET /api/config`） | ❌ 零接触 |

### 5.2 组件树

```
#app
└── <pi-chat-panel>                              ← @earendil-works/pi-web-ui 的 ChatPanel
    ├── <chat-header>                            ← 标题栏 + 会话按钮
    ├── <chat-messages>                          ← 消息列表（SSE 驱动）
    │   ├── <agent-turn>                         ← 一次 Agent 回合
    │   │   ├── <agent-message>                  ← 用户消息
    │   │   │   └── <message-content>            ← 文本/代码块
    │   │   └── <agent-message>                  ← Agent 回复（SSE 流式）
    │   │       └── <streaming-content>          ← 实时打字效果
    │   └── ... (历史消息)
    ├── <chat-input>                             ← 输入区
    │   ├── <textarea>                           ← 消息输入框
    │   └── 发送按钮                              ← 提交消息到 POST /api/chat
    └── <session-list-dialog>                    ← 会话历史弹窗
```

### 5.3 main.js 初始化流程（薄版）

```javascript
initApp()
│
├── new ChatPanel()                             ← ① 创建 Web Component
│
├── createConversation()                        ← ② 新建对话
│   └── POST /api/conversations → { id }
│
├── chatPanel.onSend = async (message) => {     ← ③ 绑定发送逻辑
│     const response = await fetch('/api/chat', {
│       method: 'POST',
│       headers: { 'Content-Type': 'application/json' },
│       body: JSON.stringify({
│         conversationId: convId,
│         message: message,
│       }),
│     });
│
│     // 读取 SSE 流
│     const reader = response.body.getReader();
│     while (true) {
│       const { done, value } = await reader.read();
│       if (done) break;
│       // 解析 SSE events → 更新 ChatPanel
│       //  {"type":"token","text":"..."}
│       //  {"type":"tool_start","name":"bash","args":{...}}
│       //  {"type":"tool_end","name":"bash","result":{...}}
│       //  {"type":"done","text":"..."}
│     }
│   }
│
└── app.appendChild(chatPanel)                  ← ④ 挂载到 DOM
```

> **关键点：** 前端不再 import Agent、不再 import pi-ai、不再 import IndexedDBStorage。
> 不再需要 `GET /api/config`，因为浏览器不需要知道任何 LLM 配置。

### 5.4 SSE 事件协议

| 事件类型 | 字段 | 说明 |
|----------|------|------|
| `token` | `{ text: string }` | LLM 回复的文本增量 |
| `tool_start` | `{ id, name, args }` | Agent 开始执行工具 |
| `tool_end` | `{ id, name, result, error? }` | 工具执行完成 |
| `done` | `{ text: string }` | Agent 回合结束，含完整回复 |

---

## 六、服务端 Agent 运行时

### 6.1 server.js 中的 Agent 生命周期

```javascript
// 每收到 POST /api/chat，server.js 做:
async function handleChat(req, res) {
  const { conversationId, message } = await readBody(req);

  // 1. 查找或创建会话
  let conv = conversations.get(conversationId);
  if (!conv) { res.writeHead(404); return; }

  // 2. 创建/复用 Agent 实例
  if (!conv.agent) {
    conv.agent = new Agent({
      initialState: {
        systemPrompt: '...',
        model: makeModel(),  // 直连 LLM API，无代理
        tools: makeSandboxTools(() => conv.sandboxSessionId),
        messages: conv.messages,
      },
      getApiKey: (provider) => process.env.LLMIO_API_KEY,
      convertToLlm: defaultConvertToLlm,
    });
  }

  // 3. 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // 4. 订阅 Agent 事件 → SSE
  const unsubscribe = conv.agent.subscribe((event) => {
    switch (event.type) {
      case 'text_delta':
        res.write(`data: ${JSON.stringify({type:'token',text:event.text})}\n\n`);
        break;
      case 'tool_call':
        res.write(`data: ${JSON.stringify({type:'tool_start',...})}\n\n`);
        break;
      // ...
    }
  });

  // 5. 执行 prompt
  await conv.agent.prompt(message);

  // 6. 完成
  res.write(`data: ${JSON.stringify({type:'done'})}\n\n`);
  res.end();
}
```

### 6.2 模型配置（服务端直连）

```javascript
function makeModel() {
  return {
    id: process.env.MODEL_ID || 'deepseek-v4-flash',
    name: process.env.MODEL_ID || 'deepseek-v4-flash',
    api: 'openai-completions',
    provider: 'llmio',
    baseUrl: process.env.LLMIO_BASE_URL,    // 直连，非代理路径
    headers: {
      Authorization: 'Bearer ' + process.env.LLMIO_API_KEY
    },
    input: ['text'], output: ['text'],
    contextWindow: 128000, maxTokens: 8192,
    // ...
  };
}
```

> **v3 关键变化：** `baseUrl` 从 `'/api/proxy/llm'` 变为真实的 LLM API URL。
> 因为 pi-ai 运行在 Node.js 服务端，没有 CORS 限制，无需代理。

### 6.3 Sandbox 工具（服务端直连）

```javascript
function makeSandboxTools(getSid) {
  const sandboxFetch = (path, options) => {
    return fetch('http://sandbox:8081' + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(SANDBOX_API_TOKEN ? { 'X-API-Key': SANDBOX_API_TOKEN } : {}),
      },
    });
  };

  return [
    {
      name: 'bash',
      async execute(_id, params) {
        const resp = await sandboxFetch('/sessions/' + getSid() + '/executions/command', {
          method: 'POST',
          body: JSON.stringify({ command: params.command, timeout: params.timeout }),
        });
        return resp.json();
      },
    },
    // ... read, write, edit, skill_view
  ];
}
```

> **v3 关键变化：** `sandboxFetch` 从浏览器端 `apiFetch('/api/sessions/...')` 变为服务端 `fetch('http://sandbox:8081/sessions/...')`。
> 无需 server.js 做二次转发，Agent 直接调用 Sandbox 容器。

---

## 七、安全收益总结

### 7.1 v2 vs v3 安全对比

| 攻击面 | v2（浏览器 Agent） | v3（服务端 Agent） | 改进程度 |
|--------|-------------------|-------------------|---------|
| **API Key 在浏览器** | 通过 `GET /api/config` 返回给前端 JS | ❌ 浏览器零接触 | 🔒 完全消除 |
| **`dangerouslyAllowBrowser`** | 需要设置 | ❌ 不需要 | 🔒 消除反模式 |
| **LLM 代理代码** | ~30 行手工 HTTP 转发 | ❌ 不需要 | 🔒 减少攻击面 |
| **Sandbox API 对浏览器暴露** | 浏览器直接调用 `/api/sessions/...` | 浏览器仅调用 `/api/chat` | 🔒 大幅缩小 |
| **CORS 配置** | 需要 `Access-Control-Allow-*` | 仅一个端点需要 | 🔒 简化 |
| **请求篡改** | 用户可修改工具参数直接调用 Sandbox API | 用户只能发消息，工具调用在服务端 | 🔒 无法绕过 |

### 7.2 最终调用链安全级别

```
v2:  浏览器（不可信）→ BFF 代理 → Sandbox / LLM
     用户可通过 DevTools 修改任何请求

v3:  浏览器（仅 UI）→ 服务端 Agent（可信）→ Sandbox / LLM
     用户只能发送文本消息，无法干预工具执行
```

---

## 八、Docker Compose 部署

### 8.1 服务定义

```yaml
services:
  sandbox:                             # Python FastAPI（不变）
    build:
      context: .
      dockerfile: sandbox/Dockerfile
    image: enterprise-sandbox:latest
    container_name: pi-enterprise-sandbox
    ports:
      - "8083:8081"                    # HTTP API
      - "8093:8091"                    # MCP Adapter
    volumes:
      - ./skills:/sandbox/skills:ro
      - ./workspaces:/sandbox/workspaces
      - sandbox_data:/sandbox/data
    environment:
      SANDBOX_PORT: 8081
      SANDBOX_MCP_PORT: 8091
      SANDBOX_LOG_LEVEL: INFO
      SANDBOX_DATABASE_URL: sqlite:////sandbox/data/sandbox.db
      SANDBOX_IPTABLES_ENABLED: true
      SANDBOX_IPTABLES_DEFAULT_POLICY: DROP
    cap_add:
      - NET_ADMIN
      - NET_RAW
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/health"]

  pi-agent:                            # Node.js Agent Runtime
    build:
      context: .
      dockerfile: Dockerfile
    image: enterprise-pi-agent:latest
    container_name: pi-enterprise-agent
    ports:
      - "3000:3000"                    # WebUI（仅一个端口）
    volumes:
      - ./skills:/home/pi-agent/.pi/agent/skills:ro
      - ./config/agent/settings.json:/home/pi-agent/.pi/agent/settings.json:ro
      - ./config/agent/models.json:/home/pi-agent/.pi/agent/models.json:ro
    env_file: .env
    environment:
      SANDBOX_BASE_URL: http://sandbox:8081
      # LLM 配置：pi-agent-core 在服务端直连
      LLMIO_BASE_URL: https://llm.009100.xyz/openai/v1
      LLMIO_API_KEY: ***
      MODEL_ID: deepseek-v4-flash
      PORT: 3000
    depends_on:
      sandbox: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:3000/api/status"]
```

### 8.2 端口映射（v3 简化）

| Host 端口 | 容器 | 容器端口 | 用途 |
|-----------|------|----------|------|
| 3000 | pi-agent | 3000 | WebUI（唯一面向用户的端口） |
| 8083 | sandbox | 8081 | Sandbox HTTP REST API（内网，不对外暴露） |
| 8093 | sandbox | 8091 | MCP Adapter（内网，不对外暴露） |

> **v3 简化：** Sandbox 的 8083/8093 端口在生产环境中不再需要暴露到 host。Agent 容器通过 Docker 内网 DNS（sandbox:8081）直连 Sandbox。仅 3000 端口对外。

### 8.3 关键环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLMIO_BASE_URL` | `https://llm.009100.xyz/openai/v1` | LLM API 基地址（Agent 直连） |
| `LLMIO_API_KEY` | — | LLM API 密钥（仅服务端环境变量） |
| `SANDBOX_BASE_URL` | `http://sandbox:8081` | Sandbox 容器内地址（Agent 直连） |
| `MODEL_ID` | `deepseek-v4-flash` | 默认 LLM 模型 |
| `SANDBOX_DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | Sandbox 数据库 |
| `SANDBOX_IPTABLES_DEFAULT_POLICY` | `DROP` | 默认网络策略 |

---

## 九、构建与部署流水线

### 9.1 构建流程（v3 简化）

```
代码修改
    │
    ├─► webui/src/main.js 修改          ← 前端逻辑（薄 UI 层）
    │   └─► Docker build 中 npx vite build  → dist/
    │
    ├─► webui/server.js 修改             ← Agent Runtime 逻辑
    │   └─► 重启容器即可生效（含 Agent 行为变更）
    │
    ├─► webui/package.json 修改          ← 依赖变更
    │   └─► docker compose build pi-agent
    │
    └─► sandbox/*.py 修改                ← Sandbox 逻辑
        └─► docker compose build sandbox

生产部署:
  docker compose up -d --build
```

---

## 十、目录结构

```
pi-sandbox/
├── .env                          # 环境变量（含 LLMIO_API_KEY）
├── Dockerfile                    # pi-agent 容器构建
├── docker-compose.yml            # 双容器编排
├── README.md
├── CHANGELOG.md

├── webui/                        # pi-agent 前端 + Agent Runtime
│   ├── server.js                 # HTTP 入口 + Agent Runtime 宿主
│   ├── agent-runtime.js          # pi-agent-core 封装模块
│   ├── sandbox-client.js         # Sandbox HTTP 客户端（服务端直连）
│   ├── package.json              # 依赖（含 pi-agent-core 服务端）
│   ├── vite.config.js            # Vite 构建配置
│   ├── index.html                # HTML 入口（薄 UI）
│   ├── src/
│   │   └── main.js               # 前端入口：仅渲染 ChatPanel + SSE 消费
│   ├── dist/                     # Vite 构建产物
│   └── node_modules/

├── sandbox/                      # Sandbox Python 服务（不变）
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

├── skills/                       # 技能文件 (挂载卷)
├── workspaces/                   # 会话工作区 (持久化)
├── config/agent/                 # Agent 配置 (挂载卷)
├── data/                         # 对话持久化 JSON
└── docs/
    └── system-design-v3.md       # ← 本文档
```

---

## 十一、关键决策记录 (ADR)

### ADR-1（取代原 ADR-1）: 服务端 Agent Runtime 而非浏览器 Agent

**决定：** `pi-agent-core` 在服务端（Node.js 进程内）运行，而不是在浏览器中。

**理由：**
- 消除 LLM API Key 暴露给浏览器的风险
- 消除 `dangerouslyAllowBrowser` 反模式
- 消除 BFF 代理层（`/api/proxy/llm/*`），减少一跳延迟
- 服务端直连 Sandbox，无需浏览器中转
- 多用户会话可以在服务端统一管理，为后续多租户打基础
- 浏览器仅负责渲染，DevTools 无法篡改工具调用

**代价：**
- 服务端需要处理 SSE 流式推送
- 服务端内存中维护 Agent 实例（需考虑长连接和资源释放）

### ADR-2: 运行时配置而非构建时注入

**决定：** Agent 配置（模型、API Key、基础 URL）通过环境变量注入，无需前端配置。

**理由：**
- 配置仅在服务端读取，与浏览器无关
- Docker 容器只需改 `.env` 文件
- 同一个 Vite 构建产物可部署到不同环境
- 无任何 LLM 配置信息进入前端 JS bundle

### ADR-3: pi-web-ui Web Components 而非自研 UI

**决定：** 使用 `@earendil-works/pi-web-ui` 官方 ChatPanel。

**理由：**
- 官方维护，功能完善（流式渲染、工具调用可视化、会话管理）
- Web Components 框架无关
- 只需用其渲染层，不负责任何 Agent 逻辑

### ADR-4: HTTP REST API 而非 MCP 作为主通信协议

**决定：** Agent ↔ Sandbox 之间使用 HTTP REST API。

**理由：**
- HTTP 调试简单
- 所有语言都有 HTTP 客户端
- MCP 作为可选的外部协议适配器（Sandbox 8091 端口）

### ADR-5: 纯 Node.js HTTP Server 而非 Express

**决定：** server.js 使用原生 `node:http`，不引入 Express/Koa。

**理由：**
- 路由数量较少（~6 条），原生 HTTP 足够
- 减少依赖 = 减少安全漏洞面
- 容器镜像更小
- 性能更好（无框架开销）

### ADR-6: SSE 而非 WebSocket

**决定：** 服务端 Agent 通过 Server-Sent Events (SSE) 推送流式响应给浏览器。

**理由：**
- SSE 是单向协议（服务端→浏览器），天然匹配 LLM 流式响应场景
- 浏览器原生支持 `EventSource` API
- 不需要额外的 WebSocket 库（ws/socket.io）
- 自动重连机制（EventSource 内置）
- 与 HTTP/2 兼容

---

## 十二、实施计划

### Phase 1: 迁移 Agent Runtime

1. 在 `webui/` 下创建 `agent-runtime.js` — 封装 pi-agent-core 创建、模型配置、Sandbox 工具注册
2. 在 `webui/` 下创建 `sandbox-client.js` — 服务端直连 Sandbox 的 HTTP 客户端
3. 修改 `webui/server.js` — 新增 `POST /api/chat` SSE 端点，移除 `/api/proxy/llm/*` 和 `/api/config` 路由
4. 精简 `webui/src/main.js` — 移除 Agent 创建、工具注册、IndexedDB 存储，仅保留 ChatPanel + SSE 消费

### Phase 2: 前端精简

5. 更新 `webui/package.json` — pi-agent-core 和 pi-ai 移到 devDependencies（仅 build 使用）或留在 dependencies（服务端引用）
6. 更新 `webui/index.html` — 移除不需要的依赖
7. 验证 SSE 事件协议 — 确保 token/tool_start/tool_end/done 四种事件正确流式渲染

### Phase 3: 安全审计

8. 确认浏览器 Network tab 不再出现 API Key 和 Sandbox API 调用
9. 确认 `GET /api/config` 已完全移除
10. 确认 `dangerouslyAllowBrowser` 不再出现在任何代码中

---

## 附录：v2 → v3 迁移清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `webui/server.js` | 重写 | 新增 `POST /api/chat` SSE，移除代理路由 |
| `webui/src/main.js` | 重写 | 移除 Agent 逻辑，仅渲染 + SSE |
| `webui/package.json` | 修改 | 依赖角色确认（服务端 vs 前端） |
| `webui/agent-runtime.js` | **新建** | Agent 封装 |
| `webui/sandbox-client.js` | **新建** | 服务端直连 Sandbox |
| `webui/services/agent-factory.js` | 删除 | 逻辑合并到 agent-runtime.js |
| `webui/routes/chat.js` | 重写 | SSE 流，非代理 |
| `webui/routes/static.js` | 保留 | 不变 |
| `docs/system-design-v2.md` | 归档 | 历史参考 |
| `docs/system-design-v3.md` | **新建** | 本文档 |
