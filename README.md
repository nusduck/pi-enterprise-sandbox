# Pi Enterprise Sandbox

> 四服务安全沙箱 + AI 编程助手 · v4.0

四服务架构：前端 SPA + 薄 BFF API Server + 独立 Node Agent + 安全沙箱执行环境。Agent 运行在独立服务中，浏览器零接触 LLM API Key 和工具执行细节。

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
  Browser → Frontend → API Server (BFF) → Agent (pi-coding-agent) → Sandbox
  (SPA)     (Nginx)    (Node:4000)        (Node:4100)               (FastAPI:8081)
```

| 组件 | 技术栈 | host→容器端口 |
|------|--------|---------------|
| **Frontend** | Vite + pi-web-ui → Nginx | `3000→80` |
| **API Server (BFF)** | Node.js 22 — auth / files / SSE relay | `4000→4000` |
| **Agent** | Node.js 22 + pi-coding-agent SDK | `4100→4100` |
| **Sandbox API** | Python 3.11 + FastAPI | `8083→8081` |
| **Sandbox MCP** | MCP adapter (REST over HTTP) | `8093→8091` |

## 目录结构

```
pi-sandbox/
├── frontend/             ← SPA 前端（Vite + @earendil-works/pi-web-ui）
│   ├── src/main.js       ← 前端入口（纯 UI，零 Agent）
│   ├── Dockerfile        ← Nginx 静态服务
│   └── nginx.conf        ← /api/* 反向代理到 api-server
├── api-server/           ← 薄 BFF（auth / files / SSE relay）
│   ├── server.js         ← HTTP 入口（/api/chat SSE, /api/status）
│   ├── routes/           ← chat, files, status, conversations...
│   ├── services/         ← sandbox-client + agent-client
│   └── Dockerfile
├── agent/                ← 独立 Agent（@earendil-works/pi-coding-agent 0.80.3）
│   ├── server.js         ← 内部 Run API + /health /ready
│   ├── chat-runner.js    ← SDK 会话循环
│   ├── sandbox-tools.js  ← read/write/edit/bash → Sandbox REST
│   └── Dockerfile
├── sandbox/              ← 安全沙箱（Python FastAPI + 多层防护，无 Agent 主循环）
│   ├── main.py           ← FastAPI 入口
│   ├── routers/          ← sessions, executions, files, artifacts, traces, MCP...
│   ├── services/         ← 会话/执行/文件/审计/审批策略
│   ├── mcp/              ← MCP 协议适配器
│   └── Dockerfile
├── skills/               ← 技能文件（默认只读挂载；研发可 SKILLS_MODE=development + RW）
├── tests/                ← pytest 测试套件
├── scripts/              ← 备份/恢复脚本
├── nginx/                ← 生产 Nginx + SSL
├── docs/                 ← 文档
├── workspaces/           ← 会话工作区（运行时，持久化）
├── docker-compose.yml           ← 开发 4 服务编排
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
| `AGENT_BASE_URL` | BFF → Agent 服务地址（compose 内默认 `http://agent:4100`） |
| `AGENT_INTERNAL_TOKEN` | BFF ↔ Agent 共享内部令牌（生产必填） |

### Agent 服务

浏览器仍统一走 `POST /api/chat`（BFF）。BFF 创建 Agent run 并 relay 序列化 SSE；编排与 SDK 循环只在 `agent/` 服务中。

```bash
# 本地四进程开发时
AGENT_BASE_URL=http://localhost:4100
SANDBOX_BASE_URL=http://localhost:8081
```

`GET /api/status` 返回 `"agent_runtime":"node-agent"` 以及 agent/sandbox 健康信息。Python Agent Runtime 与 `AGENT_RUNTIME` 开关已删除。

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
node --test api-server/tests/*.test.js api-server/tests/sdk-compat/*.test.js
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
| 路径 | Session 物理工作区隔离；agent 稳定路径 `/home/sandbox/workspace` + `/home/sandbox/skill`（默认只读；`SKILLS_MODE=development` 时仅专用 skill 工具可写） |
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
