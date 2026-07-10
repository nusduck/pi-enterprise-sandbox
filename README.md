# Pi Enterprise Sandbox

> 三容器安全沙箱 + AI 编程助手 · v4.0

三容器架构：前端 SPA + REST API Server + 安全沙箱执行环境。Agent 运行在服务端，浏览器零接触 LLM API Key 和工具执行细节。

## 快速启动

```bash
# 1. 配置
cp .env.example .env
vi .env  # 填入 LLMIO_BASE_URL 和 LLMIO_API_KEY

# 2. 构建并启动（开发模式）
docker compose up --build -d

# 3. 访问
open http://localhost:3000
```

## 架构

```
  Browser              Frontend               API Server              Sandbox
  (SPA)                (Nginx:80)             (Node.js:4000)          (FastAPI:8081)
┌──────────┐    HTTP  ┌──────────────┐   HTTP  ┌──────────────┐   HTTP  ┌──────────────┐
│ pi-web-ui│◄───────►│ 静态文件服务   │◄───────►│ pi-coding-   │◄───────►│ 安全执行环境   │
│ 纯 UI 层  │         │ /api/* 反向代理 │         │ agent SDK    │         │              │
│          │         │              │         │              │         │ iptables      │
│          │         │              │         │ SSE 流推送    │         │ ulimit        │
│          │         │              │         │ LLM 直连      │         │ 非 root       │
└──────────┘         └──────────────┘         └──────────────┘         │ 路径逃逸防护    │
 host:3000             host:3000→80            host:4000→4000           │ MCP host:8093→8091
                                                                       └──────────────┘
                                                                         API host:8083→8081
```

| 组件 | 技术栈 | host→容器端口 |
|------|--------|---------------|
| **Frontend** | Vite + pi-web-ui → Nginx | `3000→80` |
| **API Server** | Node.js 20 + pi-coding-agent SDK | `4000→4000` |
| **Sandbox API** | Python 3.11 + FastAPI | `8083→8081` |
| **Sandbox MCP** | MCP adapter (REST over HTTP) | `8093→8091` |

## 目录结构

```
pi-sandbox/
├── frontend/             ← SPA 前端（Vite + @earendil-works/pi-web-ui）
│   ├── src/main.js       ← 前端入口（纯 UI，零 Agent）
│   ├── Dockerfile        ← Nginx 静态服务
│   └── nginx.conf        ← /api/* 反向代理到 api-server
├── api-server/           ← REST API（@earendil-works/pi-coding-agent SDK）
│   ├── server.js         ← HTTP 入口（/api/chat SSE, /api/status）
│   ├── routes/           ← chat, files, status 路由
│   ├── services/         ← Sandbox HTTP 客户端
│   ├── sandbox-tools.js  ← read/write/edit/bash 工具（重定向到 Sandbox）
│   └── Dockerfile
├── sandbox/              ← 安全沙箱（Python FastAPI + 多层防护）
│   ├── main.py           ← FastAPI 入口
│   ├── routers/          ← sessions, executions, files, artifacts, traces, MCP...
│   ├── services/         ← 会话/执行/文件/审计/审批策略
│   ├── mcp/              ← MCP 协议适配器
│   └── Dockerfile
├── skills/               ← 技能文件（只读挂载到容器）
├── tests/                ← pytest 测试套件
├── scripts/              ← 备份/恢复脚本
├── nginx/                ← 生产 Nginx + SSL
├── docs/                 ← 文档
├── workspaces/           ← 会话工作区（运行时，持久化）
├── docker-compose.yml           ← 开发 3 容器编排
├── docker-compose.prod.yml      ← 生产 overlay（Nginx + SSL + 资源限制）
└── .env.example          ← 环境变量模板
```

## 环境变量

### 必需

| 变量 | 说明 |
|------|------|
| `LLMIO_BASE_URL` | LLM API 基地址（OpenAI 兼容） |
| `LLMIO_API_KEY` | LLM API 密钥 |

### 推荐

| 变量 | 说明 |
|------|------|
| `SANDBOX_API_TOKEN` | Sandbox API 认证令牌（生成: `openssl rand -hex 32`） |
| `SANDBOX_MCP_AUTH_TOKENS` | MCP 端点认证令牌（逗号分隔） |
| `AGENT_RUNTIME` | Chat 编排运行时：`node`（默认）或 `python`（BFF 代理到 sandbox `/agent/chat`） |

### Agent 运行时切换与回滚

生产浏览器仍走 `POST /api/chat`（Node BFF）。通过 `AGENT_RUNTIME` 选择编排实现：

| 值 | 行为 |
|----|------|
| `node`（默认） | 现有 `api-server/routes/chat.js` + pi-coding-agent |
| `python` | Node 将 SSE 透传到 sandbox `POST /agent/chat`（Python `AgentRuntime`） |

**回滚（无需重部署前端）：**

```bash
# .env
AGENT_RUNTIME=node
docker compose up -d api-server
# 或本地：重启 api-server 进程
```

确认 `GET /api/status` 返回 `"agent_runtime":"node"`。在多轮/工具/审批/产物/中止对等验证完成前，请保持默认 `node`。

### 执行限制

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_EXECUTION_TIMEOUT_SECONDS` | `120` | 单次命令超时 |
| `SANDBOX_MAX_OUTPUT_CHARS` | `50000` | stdout/stderr 上限 |
| `SANDBOX_MAX_PROCESS_COUNT` | `20` | 最大子进程数 |
| `SANDBOX_MAX_CPU_TIME_SECONDS` | `300` | CPU 时间上限 |
| `SANDBOX_MAX_MEMORY_MB` | `512` | 内存上限 |
| `SANDBOX_MAX_FILE_SIZE_MB` | `50` | 单文件大小上限 |
| `SANDBOX_WORKSPACE_QUOTA_MB` | `500` | 工作区总空间上限 |

### 会话管理

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_SESSION_TTL_MINUTES` | `30` | 会话空闲自动清理时间 |
| `SANDBOX_CLEANUP_INTERVAL_MINUTES` | `5` | 清理任务运行间隔 |

### 网络隔离

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_IPTABLES_ENABLED` | `true` | 启用 iptables 网络隔离 |
| `SANDBOX_IPTABLES_DEFAULT_POLICY` | `DROP` | 默认出站策略 |
| `SANDBOX_ALLOWED_TCP_PORTS` | — | 放行 TCP 端口 |
| `SANDBOX_ALLOWED_UDP_PORTS` | — | 放行 UDP 端口 |
| `SANDBOX_ALLOWED_CIDRS` | — | 放行 IP 段 |

### 数据库

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | SQLite（WAL 模式）/ PostgreSQL |

### 其他

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_LOG_LEVEL` | `INFO` | 日志级别 |
| `SANDBOX_MCP_ENABLED` | `true` | 启用 MCP 适配器 |
| `SANDBOX_MCP_PORT` | `8091` | MCP 端口 |
| `SANDBOX_UVICORN_WORKERS` | `1` | Uvicorn worker 数 |

## 开发

完整干净安装与验证命令见 [docs/development.md](docs/development.md)。摘要：

```bash
# 依赖（从仓库根目录）
uv sync --extra test
npm ci --prefix api-server
npm ci --prefix frontend

# 本地三进程
uv run uvicorn sandbox.main:app --port 8081 --reload
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix api-server
npm run dev --prefix frontend

# 质量门禁（与 CI 对齐）
uv run pytest tests/ -q --tb=short
node --test api-server/tests/*.test.js
npm test --prefix frontend && npm run build --prefix frontend
docker compose config -q
```

## 安全特性

| 层级 | 措施 |
|------|------|
| 容器 | Docker 隔离，只读 root FS |
| 网络 | iptables 默认 DROP 出站策略 |
| 用户 | 子进程以非 root `sandbox` 用户运行 |
| 资源 | ulimit: CPU / 内存 / 进程数 / 文件大小 |
| 路径 | Session 物理工作区隔离；agent 稳定路径 `/home/sandbox/workspace` + `/home/sandbox/skill` |
| 命令 | 禁止 `sudo, su, rm -rf /, dd, mkfs, fdisk, chmod 777` |
| 输出 | stdout/stderr 上限截断 |
| 交付 | 仅 Artifact API / `submit_artifact` 向用户分享文件（`write` 不自动下载） |
| 审计 | 每次执行记录 trace_id + 全量日志 |
| API Key | 仅存服务端环境变量，浏览器零接触 |

## 文档

| 文档 | 说明 |
|------|------|
| [架构设计](docs/architecture.md) | 系统架构、设计决策、安全模型、数据流 |
| [部署指南](docs/deployment.md) | 生产部署、SSL、备份、监控 |
| [开发指南](docs/development.md) | 本地开发、测试、调试 |
| [API 参考](docs/api.md) | Sandbox API + MCP + SSE 协议、Artifact 提交流程 |
| [前端指南](docs/webui.md) | 前端 SPA 架构、SSE 消费、扩展 |
