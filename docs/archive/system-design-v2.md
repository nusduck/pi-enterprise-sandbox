# Pi Enterprise Sandbox — System Design v2

> 版本：v2.1 · 2026-07-04
> 状态：🟢 运行中（双容器健康 · WebUI 3000 端口在线）

---

## 一、系统总览

### 1.1 架构图

```
                       用户浏览器
              ┌──────────────────────────────┐
              │  pi-web-ui ChatPanel          │
              │  (Lit Web Components)         │
              │  port 3000                    │
              │  GET  /api/config             │ ← 运行时配置
              │  POST /api/proxy/llm/...      │ ← LLM 代理
              │  POST /api/sessions           │ ← Sandbox 操作
              └──────────┬───────────────────┘
                         │ HTTP
                         ▼
┌───────────────────────────────────────────────────┐
│  pi-enterprise-agent (Node.js 20-slim)             │
│                                                    │
│  server.js ─── BFF (Backend For Frontend)          │
│  ├─ 静态文件服务 (dist/ ← Vite build)              │
│  ├─ GET  /api/config        ← 运行时 LLM 配置      │
│  ├─ POST /api/proxy/llm/*   ← LLM API 代理        │
│  │     (CORS 绕过 + API Key 服务端)                │
│  ├─ POST /api/sessions       ← 创建 Sandbox 会话   │
│  ├─ GET  /api/sessions/:id/* ← 代理到 Sandbox      │
│  ├─ POST /api/sessions/:id/* ← 代理到 Sandbox      │
│  ├─ GET  /api/conversations  ← 对话 CRUD           │
│  └─ GET  /api/status         ← 健康检查聚合        │
│                                                    │
│  主机映射: host:3000 → container:3000              │
└──────────────────────┬────────────────────────────┘
                       │ HTTP (Docker 内网)
                       ▼
┌───────────────────────────────────────────────────┐
│  pi-enterprise-sandbox (Python 3.11 / FastAPI)      │
│                                                    │
│  HTTP API (port 8081)  host:8083 → container:8081  │
│  ├─ /health            ← 健康检查                  │
│  ├─ /sessions          ← 会话 CRUD                 │
│  ├─ /sessions/:id/executions  ← 命令/代码执行       │
│  ├─ /sessions/:id/files      ← 文件读写             │
│  ├─ /sessions/:id/artifacts  ← 产物注册/查询        │
│  └─ /skills/:name            ← 技能只读访问         │
│                                                    │
│  MCP Adapter (port 8091)  host:8093 → container:8091│
│                                                    │
│  安全层:                                            │
│  ├─ iptables 默认 DROP 策略（无出站网络）            │
│  ├─ ulimit 限制 CPU/内存/进程数                     │
│  ├─ 非 root 用户执行 (`sandbox` user)               │
│  ├─ 路径逃逸检测 (resolve + is_relative_to)         │
│  └─ 审计日志 (每次执行记录 trace_id)                │
└───────────────────────────────────────────────────┘

                    LLM API (外部)
          https://llm.009100.xyz/openai/v1/
          /chat/completions
               ↑
        server.js 代理转发
        (API Key = 环境变量，不外泄)
```

### 1.2 核心设计原则

| 原则 | 说明 |
|------|------|
| **BFF 模式** | server.js 作为 Backend For Frontend，聚合 Sandbox API + LLM API，浏览器只需请求一个源 |
| **API Key 服务端** | LLM API Key 仅存于 server.js 环境变量，浏览器通过代理 `/api/proxy/llm/*` 调用 |
| **运行时配置** | 前端通过 `GET /api/config` 获取 LLM 配置（modelId, baseUrl），非构建时注入 |
| **双容器隔离** | Agent (Node.js) 与 Sandbox (Python FastAPI) 分离，独立构建、扩容、更新 |
| **纯 HTTP 无框架** | server.js 使用原生 `node:http`，无需 Express/Koa，减少依赖和攻击面 |
| **多层沙箱安全** | Docker 隔离 + iptables 防火墙 + ulimit 资源限制 + 非 root 用户 + 路径验证 |

---

## 二、容器架构

### 2.1 pi-enterprise-agent (Node.js 20-slim)

```
pi-enterprise-agent              ← Docker 容器
└── /home/pi-agent/webui/
    ├── server.js                ← HTTP BFF 服务入口 (纯 Node.js)
    ├── package.json             ← @earendil-works/pi-web-ui + pi-agent-core
    ├── vite.config.js           ← Vite 构建配置
    ├── tsconfig.json            ← TypeScript 配置
    ├── index.html               ← HTML 入口 (Vite 构建根)
    ├── src/
    │   └── main.js              ← 前端入口：ChatPanel + Agent 初始化
    ├── dist/                    ← Vite 构建产物 (server.js 静态服务)
    └── node_modules/            ← npm 依赖
```

**核心依赖：**

| 包 | 版本 | 用途 |
|----|------|------|
| `@earendil-works/pi-web-ui` | ^0.75.3 | ChatPanel Web Component (Lit)，含 SessionList/Settings dialogs |
| `@earendil-works/pi-agent-core` | ^0.80.3 | Agent 运行时（消息循环、工具执行、事件系统） |
| `@earendil-works/pi-ai` | ^0.80.3 | LLM Provider 实现 (openai-completions) |
| `vite` | ^6.0.0 | 前端构建工具 |

**server.js 路由表：**

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 静态文件：`dist/index.html` |
| `/*.js,css,...` | GET | 静态文件：`dist/` 目录下的构建产物 |
| `/api/config` | GET | 返回运行时 LLM 配置（modelId, baseUrl, apiKey 占位符） |
| `/api/proxy/llm/*` | POST | LLM API 代理：替换 API Key，转发到外部 LLM |
| `/api/sessions` | POST | 创建 Sandbox 会话（代理到 Sandbox 容器） |
| `/api/sessions/:id/*` | GET/POST | Sandbox 操作代理（executions, files, artifacts） |
| `/api/conversations` | GET/POST | 对话列表/创建 |
| `/api/conversations/:id` | GET/DELETE/PATCH | 对话 CRUD |
| `/api/conversations/:id/messages` | GET | 获取对话消息 |
| `/api/status` | GET | 聚合健康检查（自身 + Sandbox） |
| `/api/health`, `/api/skills/*` | GET | 透传到 Sandbox |

### 2.2 pi-enterprise-sandbox (Python 3.11 / FastAPI)

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

**REST API：**

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查（含数据库连接、iptables 状态） |
| POST | `/sessions` | 创建会话，返回 `session_id` + `workspace` |
| GET | `/sessions` | 查询活跃会话列表 |
| GET | `/sessions/{id}` | 查询单个会话状态 |
| DELETE | `/sessions/{id}` | 关闭会话，清理工作区 |
| POST | `/sessions/{id}/executions/command` | 执行 Shell 命令（带安全策略检查） |
| POST | `/sessions/{id}/executions/python` | 执行 Python 代码 |
| GET | `/sessions/{id}/executions/{eid}` | 查询执行结果（含 stdout/stderr/exit_code） |
| POST | `/sessions/{id}/executions/{eid}/cancel` | 取消正在执行的命令 |
| GET | `/sessions/{id}/files/read?path=` | 读文件内容 |
| POST | `/sessions/{id}/files/write` | 写文件（path + content） |
| GET | `/sessions/{id}/files?path=` | 列出目录 |
| POST | `/sessions/{id}/artifacts/register` | 注册 artifact |
| GET | `/sessions/{id}/artifacts` | 列出 artifacts |

---

## 三、WebUI 前端架构 (pi-web-ui)

### 3.1 组件树

```
#app
└── <pi-chat-panel>                              ← @earendil-works/pi-web-ui 的 ChatPanel
    ├── <chat-header>                            ← 标题栏 + 设置/会话按钮
    ├── <chat-messages>                          ← 消息列表
    │   ├── <agent-turn>                         ← 一次 Agent 回合
    │   │   ├── <agent-message>                  ← 用户消息
    │   │   │   └── <message-content>            ← 文本/代码块
    │   │   └── <agent-message>                  ← Agent 回复（流式）
    │   │       └── <streaming-content>          ← 实时打字效果
    │   └── ... (历史消息)
    ├── <chat-input>                             ← 输入区
    │   ├── <textarea>                           ← 消息输入框
    │   ├── 模型选择器                            ← 显示当前模型
    │   └── 发送按钮                              ← 提交消息
    └── <session-list-dialog>                    ← 会话历史弹窗
```

### 3.2 main.js 初始化流程

```javascript
initApp()
│
├── fetch('/api/config')                        ← ① 运行时加载 LLM 配置
│   └── { modelId, llmioBaseUrl, llmioApiKey }  ← 轻量 JSON
│
├── setupStorage()
│   └── new IndexedDBStorageBackend({            ← ② IndexedDB 持久化
│         dbName: 'pi-enterprise-sandbox',
│         stores: [Settings, Sessions, ProviderKeys, CustomProviders]
│       })
│   └── new AppStorage(settings, pkeys, sessions, cproviders, backend)
│   └── setAppStorage(storage)                  ← 全局单例
│
├── new ChatPanel()                             ← ③ 创建 Web Component
│
├── const agent = new Agent({                   ← ④ 创建 Agent 运行时
│     initialState: {
│       model: makeModel(),                     ← 含 baseUrl = '/api/proxy/llm'
│       systemPrompt: '...Sandbox Agent...',
│       tools: [],
│       messages: [],
│     },
│     getApiKey: (provider) =>                  ← 返回服务端 API Key
│       provider === 'llmio' ? LLMIO_API_KEY : null,
│     convertToLlm: defaultConvertToLlm,        ← 消息格式转换
│   })
│
├── await chatPanel.setAgent(agent, {           ← ⑤ 绑定 Agent 到 UI
│     onApiKeyRequired: async () => true,        ← 用服务端代理，key 已在 model headers
│     toolsFactory: () => makeTools(getSid),     ← 注册 5 个 Sandbox 工具
│     sandboxUrlProvider: () => '/',
│   })
│
├── agent.subscribe(event => {                  ← ⑥ 监听 Agent 事件
│     if (event.type === 'turn_start' && !sid)  ← 首条消息时创建 Sandbox 会话
│       POST /api/sessions
│   })
│
└── app.appendChild(chatPanel)                  ← ⑦ 挂载到 DOM
```

### 3.3 模型配置

```javascript
{
  id: 'deepseek-v4-flash',
  name: 'deepseek-v4-flash',
  api: 'openai-completions',           // OpenAI 兼容 API
  provider: 'llmio',                   // 自定义 provider 名称
  baseUrl: '/api/proxy/llm',           // 服务端代理路径
  headers: { Authorization: 'Bearer <key>' },  // 运行时注入真实 key
  input: ['text'],
  output: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: 'max_tokens',
    requiresAssistantAfterToolResult: true,
  }
}
```

### 3.4 工具注册

前端通过 `toolsFactory` 注册 5 个 Sandbox 工具：

| 工具名 | 代理路径 | 说明 |
|--------|----------|------|
| `read` | `GET /api/sessions/{sid}/files/read?path=` | 读文件，支持 offset/limit |
| `write` | `POST /api/sessions/{sid}/files/write` | 写文件 (path + content) |
| `edit` | read + write 组合 | find-and-replace 编辑 |
| `bash` | `POST /api/sessions/{sid}/executions/command` | 执行命令（带阻止列表） |
| `skill_view` | `GET /api/skills/{name}` | 查看技能文档 |

bash 工具阻止列表（防止破坏性操作）：
```
sudo, su, chmod 777, chown, rm -rf /, rm -rf /*, dd if=, mkfs., fdisk, > /dev/, < /dev/
```

---

## 四、LLM 代理架构

### 4.1 为什么需要代理

```
浏览器直接调用 LLM API:
  fetch('https://llm.009100.xyz/openai/v1/chat/completions', {
    headers: {
      'Authorization': 'Bearer real-key',
      'x-stainless-os': 'browser'     ← OpenAI SDK 自动添加
    }
  })
  → ❌ CORS 错误：Request header field x-stainless-os not allowed
  → ❌ API Key 暴露在浏览器 DevTools 中

服务端代理调用:
  POST /api/proxy/llm/chat/completions
  → server.js 替换 Key + 转发
  → ✅ 无 CORS 问题（同源请求）
  → ✅ API Key 仅在服务端环境变量
```

### 4.2 代理请求流

```
用户输入消息 → Enter
    │
    ▼
Agent.prompt("写个 Python 脚本")
    │
    ▼
Agent (pi-agent-core)
    ├── convertToLlm → 消息转 LLM 格式
    └── Agent.streamFunction(model, context, {apiKey})
        │
        ▼
openai-completions (pi-ai)
    ├── new OpenAI({                          ← OpenAI JS SDK
    │     baseURL: '/api/proxy/llm',          ← 本地代理路径
    │     apiKey: 'proxied',                  ← 占位符
    │     dangerouslyAllowBrowser: true,       ← 允许浏览器环境
    │   })
    └── POST /api/proxy/llm/chat/completions  ← 实际 HTTP 请求
        │
        ▼
server.js proxy handler
    │   1. 提取 LLMIO_BASE_URL + LLMIO_API_KEY (环境变量)
    │   2. 构造目标 URL:
    │      https://llm.009100.xyz/openai/v1/chat/completions
    │   3. 设置 Authorization: Bearer <real-key>
    │   4. 转发请求（json body 不变）
    │   5. 流式/非流式响应原样返回
    │
        ▼
LLM API (llm.009100.xyz)
    │   chat/completions 流式响应
    │
        ▼
Agent 解析 SSE stream
    ├── text_delta  → 实时文本块
    ├── tool_call   → 触发工具执行
    └── turn_end    → 回合结束
        │
        ▼
ChatPanel 渲染
    ├── 流式打字效果
    ├── 工具调用卡片 ("🔧 执行 bash...")
    └── 完整回复显示
```

### 4.3 安全收益

| 风险 | 无代理 | 有代理 |
|------|--------|--------|
| API Key 泄露 | Key 在浏览器 JS bundle + Network tab 可见 | Key 仅存服务端环境变量 |
| CORS 拦截 | 浏览器跨域请求被预检拦截 | 同源请求，无 CORS |
| 请求篡改 | 用户可修改请求参数/Key | 代理层可控，Key 不可篡改 |
| 速率限制 | 无法集中控制 | 可在代理层加限流 |

---

## 五、Sandbox 执行安全模型

### 5.1 命令执行流程

```
POST /sessions/{id}/executions/command
    │
    ├─► ① Policy Checker 评估风险等级
    │    ├── 低风险 (read, write, python --version) → 直接放行
    │    ├── 中风险 (pip install, apt-get) → 记录日志后放行
    │    └── 高风险 (curl external, wget) → 拒绝（iptables DROP 策略）
    │
    ├─► ② 路径验证 (resolve + is_relative_to)
    │    └── 阻止 `../../../etc/passwd` 等逃逸
    │
    ├─► ③ 生成 trace_id + 写入审计日志
    │
    ├─► ④ 生成执行记录 (Pydantic model)
    │
    ├─► ⑤ subprocess 执行 (asyncio.create_subprocess_exec)
    │    ├── 以 sandbox 用户运行（非 root）
    │    ├── cwd = session workspace
    │    ├── timeout 控制（默认 120s）
    │    ├── ulimit: CPU 300s, 内存 512MB, 进程数 20
    │    ├── stdout/stderr 捕获（上限 50K chars）
    │    └── iptables: 默认 DROP（无出站网络）
    │
    ├─► ⑥ 写入输出文件到 workspace/output/
    │
    └─► ⑦ 返回执行结果
         { exit_code, stdout_preview, stderr_preview,
           duration_ms, trace_id, output_files }
```

### 5.2 多层安全措施

| 层级 | 措施 | 实现方式 |
|------|------|----------|
| **容器** | Docker 隔离 | 独立容器，只读 root FS（部分卷可写） |
| **网络** | iptables 防火墙 | 默认 DROP 策略，仅允许必要端口(DNS 53) |
| **用户** | 非 root 执行 | 子进程以 `sandbox` 用户运行（UID 不同） |
| **资源** | ulimit 限制 | CPU 时长 300s，内存 512MB，进程数 20，文件大小 50MB |
| **路径** | 逃逸检测 | `resolve() + is_relative_to()` + 阻止 `..` 序列 |
| **命令** | 黑名单 | 禁止 `sudo, su, rm -rf /, dd, mkfs, fdisk` |
| **输出** | 截断保护 | stdout/stderr 上限 50K chars |
| **审计** | 全量记录 | 每次执行记录 trace_id + timestamp + 命令 + 结果 |
| **会话** | TTL 自动清理 | 30 分钟无活动自动清理工作区 |

---

## 六、数据流

### 6.1 一次完整对话周期

```
用户输入 "写一个 Python 脚本计算斐波那契数列"
    │
    ├─► pi-web-ui ChatPanel 捕获输入
    │   ├── 清空输入框
    │   └── 调用 agent.prompt(userMessage)
    │
    ├─► Agent 回合开始 (turn_start)
    │   ├── 创建 Sandbox 会话 (首条消息时)
    │   │   └── POST /api/sessions → { session_id, workspace }
    │   ├── convertToLlm(userMessage)
    │   └── streamFunction(model, context, {apiKey})
    │       └── POST /api/proxy/llm/chat/completions
    │           └── server.js → LLM API → 流式响应
    │
    ├─► Agent 解析流式事件
    │   ├── text_delta → ChatPanel 实时渲染
    │   └── tool_call → 触发工具执行
    │
    ├─► Agent 调用 bash 工具
    │   ├── execute("bash", { command: "python3 fib.py", timeout: 30 })
    │   └── POST /api/sessions/{sid}/executions/command
    │       └── server.js → Sandbox → { exit_code, stdout_preview }
    │
    ├─► 工具结果注入 Agent context
    │   └── Agent 继续 LLM 调用，生成最终回复
    │
    └─► ChatPanel 显示完整回复
        ├── 流式渲染的 LLM 回答
        └── 工具执行结果摘要
```

### 6.2 会话生命周期

```
┌─────────┐    ┌──────────┐    ┌────────┐    ┌─────────┐
│  创建    │───►│  运行中   │───►│  空闲   │───►│  已关闭  │
└─────────┘    └──────────┘    └────────┘    └─────────┘
     │              │              │              │
     │ POST         │ 工具执行     │ TTL 超时     │ DELETE
     │ /sessions    │ /executions  │ 30min        │ /sessions/{id}
     │              │              │              │
     ▼              ▼              ▼              ▼
 workspace/       output/        cleanup        removed
 会话工作区       执行产物      自动清理       目录删除
```

### 6.3 HTTP 请求完整路径示例

```
用户写文件:
  ChatPanel → Agent → tool.write(path, content)
    → POST /api/sessions/sandbox_abc123/files/write
    → server.js handleSandboxProxy
    → fetch('http://sandbox:8081/sessions/sandbox_abc123/files/write')
    → Sandbox file_manager.write(path, content)
    → 写入 workspace/sandbox_abc123/content
    → 返回 { size, path }
    → server.js → 浏览器 → Agent → ChatPanel

用户执行命令:
  同上路径，POST /api/sessions/{sid}/executions/command
    → Sandbox execution_manager.execute(command, timeout)
    → policy_checker 检查风险
    → subprocess with uid=sandbox, cwd=workspace
    → iptables 默认 DROP 网络
    → 返回 { exit_code, stdout_preview, stderr_preview, duration_ms }
```

---

## 七、Docker Compose 部署

### 7.1 服务定义

```yaml
services:
  sandbox:                             # Python FastAPI
    build:
      context: .
      dockerfile: sandbox/Dockerfile
    image: enterprise-sandbox:latest
    container_name: pi-enterprise-sandbox
    ports:
      - "8083:8081"                    # HTTP API
      - "8093:8091"                    # MCP Adapter
    volumes:
      - ./skills:/sandbox/skills:ro    # 技能文件只读
      - ./workspaces:/sandbox/workspaces  # 会话工作区
      - sandbox_data:/sandbox/data     # 数据库持久化
    environment:
      SANDBOX_PORT: 8081
      SANDBOX_MCP_PORT: 8091
      SANDBOX_LOG_LEVEL: INFO
      SANDBOX_DATABASE_URL: sqlite:////sandbox/data/sandbox.db
      SANDBOX_IPTABLES_ENABLED: true
      SANDBOX_IPTABLES_DEFAULT_POLICY: DROP
      # ... 30+ 可配置参数
    cap_add:
      - NET_ADMIN                      # iptables 需要
      - NET_RAW
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8081/health"]

  pi-agent:                            # Node.js BFF
    build:
      context: .
      dockerfile: Dockerfile
    image: enterprise-pi-agent:latest
    container_name: pi-enterprise-agent
    ports:
      - "3000:3000"                    # WebUI
    volumes:
      - ./skills:/home/pi-agent/.pi/agent/skills:ro
      - ./config/agent/settings.json:/home/pi-agent/.pi/agent/settings.json:ro
      - ./config/agent/models.json:/home/pi-agent/.pi/agent/models.json:ro
    env_file: .env
    environment:
      SANDBOX_BASE_URL: http://sandbox:8081
      PORT: 3000
    depends_on:
      sandbox: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "curl", "-sf", "http://localhost:3000/api/status"]
```

### 7.2 端口映射

| Host 端口 | 容器 | 容器端口 | 用途 |
|-----------|------|----------|------|
| 3000 | pi-agent | 3000 | WebUI (BFF + 静态文件) |
| 8083 | sandbox | 8081 | Sandbox HTTP REST API |
| 8093 | sandbox | 8091 | MCP Protocol Adapter |

### 7.3 关键环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLMIO_BASE_URL` | `https://llm.009100.xyz/openai/v1` | LLM API 基地址 |
| `LLMIO_API_KEY` | — | LLM API 密钥（必须设置） |
| `SANDBOX_BASE_URL` | `http://sandbox:8081` | Sandbox 容器内地址 |
| `MODEL_ID` | `deepseek-v4-flash` | 默认 LLM 模型 |
| `SANDBOX_DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | Sandbox 数据库 |
| `SANDBOX_IPTABLES_DEFAULT_POLICY` | `DROP` | 默认网络策略 |
| `SANDBOX_SESSION_TTL_MINUTES` | `30` | 会话空闲超时 |
| `SANDBOX_EXECUTION_TIMEOUT_SECONDS` | `120` | 命令执行超时 |

---

## 八、构建与部署流水线

### 8.1 构建流程

```
代码修改
    │
    ├─► webui/src/main.js 修改          ← 前端逻辑
    │   └─► Docker build 中 npx vite build  → dist/
    │
    ├─► webui/server.js 修改             ← BFF 逻辑
    │   └─► 重启容器即可生效
    │
    ├─► webui/package.json 修改          ← 依赖变更
    │   └─► docker compose build pi-agent
    │
    └─► sandbox/*.py 修改                ← Sandbox 逻辑
        └─► docker compose build sandbox

生产部署:
  docker compose up -d --build
```

### 8.2 健康检查链

```
用户访问 http://host:3000
    │
    ├─► pi-agent HEALTHCHECK
    │   └── curl http://localhost:3000/api/status
    │       ├── 自身运行状态 → ok
    │       └── sandbox: { status: 'ok' }  ← 检查 Sandbox 可达
    │
    └─► sandbox HEALTHCHECK
        └── curl http://localhost:8081/health
            ├── 数据库连接 → ok
            ├── iptables 状态 → ok
            └── 磁盘空间 → ok
```

---

## 九、当前状态与路线图

### 9.1 已实现 ✅

| 组件 | 状态 | 说明 |
|------|------|------|
| Sandbox Python 服务 | ✅ | FastAPI, SQLite WAL, session/execution/file/artifact API |
| Agent BFF (server.js) | ✅ | 纯 Node.js HTTP server，无框架依赖 |
| LLM API 代理 | ✅ | `/api/proxy/llm/*` 安全转发，CORS 解决 |
| 运行时配置 | ✅ | `GET /api/config` 返回 LLM 配置 |
| pi-web-ui 集成 | ✅ | ChatPanel + Agent 绑定成功，消息发送可用 |
| Sandbox 工具注册 | ✅ | read/write/edit/bash/skill_view 5 工具 |
| Docker Compose 编排 | ✅ | 双容器，健康检查，依赖顺序控制 |
| 安全沙箱 | ✅ | iptables DROP, ulimit, 非 root, 路径验证, 审计日志 |
| 会话管理 | ✅ | 创建/查询/关闭 + TTL 自动清理 |
| 对话持久化 | ✅ | JSON 文件存储 conversations |
| 健康检查 | ✅ | 每 30s，含 Sandbox 可达性验证 |

### 9.2 已知问题 🟡

| 问题 | 优先级 | 说明 |
|------|--------|------|
| 消息发送偶发挂起 | P0 | Agent prompt 调用后有时不返回响应，需进一步调试事件订阅 |
| 流式响应有时中断 | P1 | SSE stream 连接偶发断开，需重连机制 |
| pi-web-ui SessionList 未集成 | P2 | 需要挂载 `<session-list-dialog>` 组件 |

### 9.3 规划中 📋

| 任务 | 优先级 | 说明 |
|------|--------|------|
| PostgreSQL 双后端 | P1 | Sandbox 增加 PostgreSQL 支持 |
| 对话消息持久化 | P1 | 消息存入数据库而非仅内存 JSON |
| 前端会话历史管理 | P1 | pi-web-ui SessionListDialog 集成 |
| 流式 SSE 错误恢复 | P1 | 断线重连 + 超时重试 |
| 速率限制 (Rate Limiting) | P2 | LLM 代理层加限流 |
| 用户认证 | P2 | 基本认证或 JWT |
| 性能测试 | P2 | 并发执行、大文件读写、长会话 |

---

## 十、关键决策记录 (ADR)

### ADR-1: BFF 而非直接调用 LLM

**决定：** server.js 作为 BFF，代理所有 LLM 请求。

**理由：**
- API Key 不暴露给浏览器
- 统一解决 CORS（浏览器同源策略绕过）
- 可在代理层加缓存、限流、审计
- 切换 LLM 提供商只需改 server.js 环境变量，前端无需修改

### ADR-2: 运行时配置而非构建时注入

**决定：** 前端通过 `GET /api/config` 在运行时获取 LLM 配置。

**理由：**
- 同一个 Vite 构建产物可部署到不同环境
- Docker 容器只需改 `.env` 文件，无需重建
- 配置变更即时生效（浏览器刷新即可）
- 避免 Vite 构建时将 API Key 打入 JS bundle

### ADR-3: pi-web-ui Web Components 而非自研 UI

**决定：** 使用 `@earendil-works/pi-web-ui` 官方 ChatPanel。

**理由：**
- 官方维护，功能完善（流式渲染、工具调用可视化、会话管理）
- Web Components 框架无关（React/Vue/Svelte 都可使用）
- 定期更新，社区支持
- 减少自研 UI 的维护成本

### ADR-4: HTTP REST API 而非 MCP 作为主通信协议

**决定：** Agent ↔ Sandbox 之间使用 HTTP REST API。

**理由：**
- HTTP 调试简单（curl, Postman, 浏览器 DevTools）
- 所有语言都有 HTTP 客户端
- 负载均衡、限流中间件生态成熟
- MCP 作为可选的外部协议适配器（Sandbox 8091 端口）

### ADR-5: 纯 Node.js HTTP Server 而非 Express

**决定：** server.js 使用原生 `node:http`，不引入 Express/Koa。

**理由：**
- 路由数量较少（~10 条），原生 HTTP 足够
- 减少依赖 = 减少安全漏洞面
- 容器镜像更小
- 性能更好（无框架开销）

---

## 附录 A：目录结构

```
pi-sandbox/
├── .env                          # 环境变量（含 LLMIO_API_KEY）
├── Dockerfile                    # pi-agent 容器构建
├── docker-compose.yml            # 双容器编排
├── README.md                     # 项目说明
├── REFACTORING_PLAN.md           # 重构计划
├── CHANGELOG.md                  # 变更日志
│
├── webui/                        # pi-agent 前端 + BFF
│   ├── server.js                 # BFF Node.js HTTP 服务
│   ├── package.json              # 前端依赖
│   ├── vite.config.js            # Vite 构建配置
│   ├── index.html                # HTML 入口
│   ├── src/
│   │   └── main.js               # 前端初始化（Agent + ChatPanel）
│   ├── dist/                     # Vite 构建产物
│   └── node_modules/
│
├── sandbox/                      # Sandbox Python 服务
│   ├── Dockerfile                # Sandbox 镜像构建
│   ├── entrypoint.sh             # 容器启动脚本 (iptables + uvicorn)
│   ├── requirements.txt          # Python 依赖
│   ├── main.py                   # FastAPI 入口
│   ├── config.py                 # 配置管理
│   ├── database.py               # 数据库抽象
│   ├── models.py                 # Pydantic 模型
│   ├── repositories.py           # 数据访问层
│   ├── trace.py                  # 分布式追踪
│   ├── routers/                  # HTTP 路由
│   ├── services/                 # 业务逻辑
│   ├── security/                 # 安全控制
│   ├── mcp/                      # MCP 协议适配
│   └── utils/                    # 工具函数
│
├── skills/                       # 技能文件 (挂载卷)
├── workspaces/                   # 会话工作区 (持久化)
├── config/agent/                 # Agent 配置 (挂载卷)
│   ├── settings.json
│   └── models.json
├── data/                         # 对话持久化 JSON
└── docs/                         # 文档
    └── system-design-v2.md       # ← 本文档
```
