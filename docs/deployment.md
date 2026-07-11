# Deployment Guide

> 生产部署指南 — 四服务 + Nginx 反向代理 + SSL + 资源限制 + 持久化存储

## 快速启动（开发模式）

```bash
# 1. 配置
cp .env.example .env
vi .env  # 填入 LLMIO_BASE_URL 和 LLMIO_API_KEY

# 2. 构建并启动
docker compose up --build -d

# 3. 验证
curl -f http://localhost:3000/            # Frontend
curl -f http://localhost:4000/api/status  # BFF
curl -f http://localhost:4100/health      # Agent
curl -f http://localhost:8083/health      # Sandbox liveness
curl -f http://localhost:8083/ready       # Sandbox readiness (workspaces + DB)
```

| 服务 | 端口 | 容器内端口 |
|------|------|-----------|
| Frontend (Nginx) | `3000` | `80` |
| API Server (BFF) | `4000` | `4000` |
| Agent | `4100` | `4100` |
| Sandbox MCP | `8093` | `8091` |
| Sandbox API | 内网仅 | `8081` |

## 生产部署

```bash
# 使用生产 overlay（Nginx + SSL + 资源限制）
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

# 验证
curl -sf https://localhost/api/status
curl -sf https://localhost/nginx/status
```



### 生产架构

```
                           ┌───────────────────────┐
                           │   Nginx (443/80)        │
                           │   TLS + Rate Limit     │
                           └──────┬────────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   frontend (Nginx:80)         │
                  │   Static SPA + /api/* proxy   │
                  └───────────────┬──────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   api-server BFF (Node:4000)  │
                  │   Auth · Files · SSE relay    │
                  └───────────────┬──────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   agent (Node:4100)           │
                  │   pi-coding-agent SDK · LLM   │
                  └───────────────┬──────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   sandbox (FastAPI:8081)       │
                  │   Execution · Files · Auth     │
                  │   PostgreSQL (prod required)  │
                  │   MCP:8091                    │
                  └──────────────────────────────┘
```

## 环境变量

### Auth

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_API_TOKEN` | — | Sandbox API 令牌。生成: `openssl rand -hex 32`。所有 API 调用需带 `X-API-Key` header |
| `SANDBOX_MCP_AUTH_TOKENS` | — | MCP 端点认证令牌，逗号分隔 |

### 入站网络（监听 vs 来源白名单）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_BIND_HOST` | `0.0.0.0` | **仅控制监听接口**。`0.0.0.0` 不等于允许任意来源。旧名 `SANDBOX_HOST` 仍可用 |
| `SANDBOX_ALLOWED_CLIENT_CIDRS` | loopback + Docker 私网 | 入站 HTTP/MCP 来源 CIDR 白名单。空列表 = 拒绝全部（失败关闭）。非法 CIDR 导致启动失败 |
| `SANDBOX_TRUSTED_PROXY_CIDRS` | _(空)_ | 可信反向代理。默认忽略 `X-Forwarded-For`；仅当 TCP peer 属于此列表时，才从右向左剥离可信代理解析真实客户端 |

**默认 allowlist（compose / 本地容器）:**
`127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16`

**本机非 Docker 更严示例（仅 loopback）:**
```env
SANDBOX_BIND_HOST=127.0.0.1
SANDBOX_ALLOWED_CLIENT_CIDRS=127.0.0.1/32,::1/128
SANDBOX_TRUSTED_PROXY_CIDRS=
```

**反向代理示例（nginx 在 Docker 网桥，业务来源为办公网）:**
```env
SANDBOX_BIND_HOST=0.0.0.0
SANDBOX_ALLOWED_CLIENT_CIDRS=10.0.0.0/8,172.16.0.0/12
SANDBOX_TRUSTED_PROXY_CIDRS=172.16.0.0/12
```

**外部 MCP 直连:** 必须把对端 CIDR 写入 `SANDBOX_ALLOWED_CLIENT_CIDRS`，并配置 `SANDBOX_API_TOKEN` / `SANDBOX_MCP_AUTH_TOKENS`。BFF 不直接执行 Sandbox 工具。

注意：`SANDBOX_ALLOWED_CIDRS` 是 **出站 iptables** 目的网段，与入站 `SANDBOX_ALLOWED_CLIENT_CIDRS` 无关。

### LLM Provider

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `LLMIO_BASE_URL` | — | **必需** — LLM API 基地址 |
| `LLMIO_API_KEY` | — | **必需** — LLM API 密钥 |
| `MODEL_ID` | `deepseek-v4-flash` | 模型 ID |

### Domain & SSL

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DOMAIN` | `localhost` | 生产 Nginx SSL 域名 |
| `NGINX_HTTP_PORT` | `80` | HTTP 端口 |
| `NGINX_HTTPS_PORT` | `443` | HTTPS 端口 |

### Database

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | SQLite（仅开发/测试）或 PostgreSQL（生产强制） |
| `POSTGRES_DB` | `sandbox` | 生产 PostgreSQL database name |
| `POSTGRES_USER` | `sandbox` | 生产 PostgreSQL user |
| `POSTGRES_PASSWORD` | 无 | 生产必填 secret；无默认值 |

**开发（SQLite）:** 无需额外配置，自动创建。

**生产（PostgreSQL）:** `docker-compose.prod.yml` 已内置 PostgreSQL 17、healthcheck、持久 volume 和 Sandbox 依赖。启动前必须设置强 `POSTGRES_PASSWORD`；production overlay 不回退 SQLite。Sandbox 以不可变 `schema_migrations` 初始化空库，checksum 不一致时拒绝启动。

研发阶段不可逆的空环境切换见 [Development reset runbook](runbooks/development-reset.md)。该流程明确不备份、不迁移、不恢复旧数据。

### 资源限制

配置于 `docker-compose.prod.yml`：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_CPU_LIMIT` | `2` | Sandbox 最大 CPU |
| `SANDBOX_MEM_LIMIT` | `1g` | Sandbox 最大内存 |
| `AGENT_CPU_LIMIT` | `1` | API Server 最大 CPU |
| `AGENT_MEM_LIMIT` | `512m` | API Server 最大内存 |

### Logging

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_LOG_LEVEL` | `INFO` | 日志级别 (DEBUG, INFO, WARNING) |

生产日志配置 (docker-compose.prod.yml):
- Driver: `json-file`
- Max size: `10m` per file
- Max files: `3`

## Auth (API Token)

当 `SANDBOX_API_TOKEN` 设置后，Sandbox API 除健康检查外的所有端点要求：

```
X-API-Key: ***
```

**工作原理:**
1. Nginx → Frontend → API Server → Sandbox
2. API Server 自动为所有 Sandbox 请求添加 `X-API-Key` header
3. 绕过 API Server 的直接 API 调用也需 token

**豁免端点:** `/health`, `/ready`, `/metrics`, `/docs`, `/openapi`, `/redoc`

```bash
# 测试
curl -H "X-API-Key: ***" http://localhost:8083/health     # OK (exempt)
curl -H "X-API-Key: ***" http://localhost:8083/sessions    # OK
curl http://localhost:8083/sessions                        # 401
```

## Volumes

| Volume | 路径 | 说明 |
|--------|------|------|
| `sandbox_data` | `/sandbox/data` | SQLite 数据库、审计日志 |
| `nginx_ssl` | `/etc/nginx/ssl` | SSL 证书（生产） |
| `nginx_certbot` | `/var/www/certbot` | Let's Encrypt ACME challenge（生产） |
| `./skills` | Agent `/home/sandbox/skill`（默认 `:ro`；研发可 `:rw`）+ Sandbox `:ro` | 共享技能；生产只读 |
| `./workspaces` | `/var/sandbox/workspaces` | 会话物理工作区 |

### Skill 挂载与 SKILLS_MODE

| 环境 | `SKILLS_MODE` | Agent 挂载 | Sandbox 挂载 | 说明 |
|------|---------------|------------|--------------|------|
| 生产 | `readonly`（默认） | `:ro` | `:ro` | 无 `skill_install` / `skill_edit`；通用工具硬拒绝写 skill 根 |
| 研发 | `development` | `AGENT_SKILLS_MOUNT=...:rw` | `:ro` | 仅 Agent 可写；Sandbox 只执行 |

生产 overlay（`docker-compose.prod.yml`）强制 Agent skill 卷为 `:ro`。

## Health Checks

区分 **liveness**（进程存活）与 **readiness**（依赖就绪）：

| 探针 | 端点 | 成功 | 失败含义 |
|------|------|------|----------|
| Sandbox liveness | `GET /health` | 200 | 进程无响应 |
| Sandbox readiness | `GET /ready` | 200 | **503** = 工作区不可写或数据库不可用 |
| API Server | `GET /api/status` | 200 | BFF 进程未就绪 |
| Frontend | `GET /` | 200 | 静态站/反代不可用 |

```bash
# Frontend
curl -f http://localhost:3000/

# API Server（仅 node-agent；无 Python/双 Runtime）
curl -f http://localhost:4000/api/status
# {"status":"ok","version":"4.0.0","agent_runtime":"node-agent"}

# Sandbox liveness（进程存活；公开路由，无需 API key）
curl -f http://localhost:8083/health
# {"status":"ok","version":"…","workspace_available":true,…}

# Sandbox readiness（依赖就绪；未就绪时 curl -f 因 503 失败）
curl -f http://localhost:8083/ready
# {"status":"ok","workspace_available":true,…}  或 HTTP 503 status=not_ready

# Nginx (生产)
curl -f https://localhost/nginx/status
```

容器 `healthcheck` 当前使用 `/health`（liveness）。编排侧若需“可接流量”语义，应对 Sandbox 使用 `/ready`。

### Compose smoke path（多轮 / 审批 / 二进制 / 取消 / 产物）

**无真实 LLM key（CI / 本地）：**

```bash
# 启动 deterministic fake OpenAI + Sandbox + Agent + BFF
node scripts/smoke-cross-service.mjs
```

`AGENT_ENABLE_FAKE_LLM` 仅允许 `NODE_ENV`/`DEPLOYMENT_ENV` 非 production；生产启用会在 Agent 配置加载时 fail-closed。

**完整栈（需有效 `LLMIO_*` 或测试用 fake 指向可路由地址）：**

1. `docker compose up --build -d` → 等待 `curl -f localhost:4000/api/status` 与 `curl -f localhost:8083/ready`
2. 浏览器打开 `http://localhost:3000`，发送多轮消息（同一 conversation）
3. 触发高风险 bash → UI 出现审批 → approve/reject
4. 上传二进制文件 → 下载校验字节一致
5. 生成中点击停止 → 流结束且无悬挂执行
6. Agent `submit_artifact` 后出现可下载交付物（非 `write` 自动下载）

Node 运行时与 CI 统一 **Node 22**（`api-server` / `agent` / `frontend` 镜像与 `.github/workflows/test.yml`）。

## Backup

以下脚本用于常规已上线环境的人工运维，不属于当前研发阶段的全量 reset。执行 [Development reset](runbooks/development-reset.md) 时不得先创建备份或快照。

```bash
# Full backup
bash scripts/backup.sh
# Output: ./backups/sandbox-backup-20260401_120000.db
#         ./backups/sandbox-backup-20260401_120000.env
#         ./backups/sandbox-backup-20260401_120000-workspaces.tar.gz

# Restore
bash scripts/restore.sh ./backups/sandbox-backup-20260401_120000
```

## Monitoring

### Prometheus Metrics

Sandbox 暴露 `/metrics` 端点：

| Metric | Type | 说明 |
|--------|------|------|
| `sandbox_execution_total` | Counter | 按状态统计的执行总数 |
| `sandbox_execution_failed_total` | Counter | 失败执行数 |
| `sandbox_execution_timeout_total` | Counter | 超时执行数 |
| `sandbox_active_sessions` | Gauge | 活跃会话数 |
| `sandbox_workspace_bytes` | Gauge | 工作区磁盘使用量 |
| `sandbox_rate_limited_total` | Counter | 速率限制触发数 |

### 容器监控

```bash
# 资源使用
docker stats pi-enterprise-frontend pi-enterprise-api pi-enterprise-sandbox

# 日志
docker compose logs -f --tail=100 sandbox
docker compose logs -f --tail=100 api-server
docker compose logs -f --tail=100 frontend

# 生产日志（含 Nginx）
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f nginx
```

## Let's Encrypt (Production SSL)

```bash
# 安装 certbot
apt-get install certbot

# 生成证书
certbot certonly --webroot -w /var/www/certbot -d your-domain.com

# 复制到 nginx volume
docker cp /etc/letsencrypt/live/your-domain.com/fullchain.pem nginx:/etc/nginx/ssl/
docker cp /etc/letsencrypt/live/your-domain.com/privkey.pem nginx:/etc/nginx/ssl/

# 重新加载 nginx
docker exec pi-enterprise-nginx nginx -s reload
```

自动续期 cron：
```bash
# /etc/cron.d/certbot-renew
0 3 * * * root certbot renew --quiet && docker exec pi-enterprise-nginx nginx -s reload
```

## Scaling

| 场景 | 推荐方案 |
|------|----------|
| 单实例开发 | 空库 SQLite + Docker Compose |
| 生产 | PostgreSQL 17 + Compose prod overlay |
| 多实例 | PostgreSQL + 共享工作区存储 (NFS/EFS) |
| 高可用 | 负载均衡器 + PostgreSQL 复制 |

## Troubleshooting

### Sandbox 容器无法启动

```bash
docker compose logs sandbox
docker compose run --rm sandbox python -c "import fastapi; print('ok')"
```

### API Server 状态异常

```bash
# 检查 API Server 健康
curl http://localhost:4000/api/status

# 检查 API Server → Sandbox 通信
docker exec pi-enterprise-api curl -f http://sandbox:8081/health

# 重启服务
docker compose restart api-server
```

### API Token 认证错误

```bash
# 检查 token 是否设置
docker exec pi-enterprise-sandbox env | grep SANDBOX_API_TOKEN

# 检查 API Server 是否传递 token
docker exec pi-enterprise-api env | grep SANDBOX_API_TOKEN

# 直接测试
curl -H "X-API-Key: ***" http://localhost:8083/sessions
```

### 数据库问题

```bash
# 重置数据库（⚠️ 删除所有数据）
docker compose down -v
docker compose up -d

# 备份数据库
docker exec pi-enterprise-sandbox cp /sandbox/data/sandbox.db /tmp/sandbox-backup.db

# 运行 SQL 查询
docker exec -it pi-enterprise-sandbox sqlite3 /sandbox/data/sandbox.db
```

## Docker 命令参考

```bash
# 开发
docker compose up --build -d            # 启动所有服务
docker compose logs -f                  # 跟随日志
docker compose down                     # 停止所有服务
docker compose restart                  # 重启所有服务

# 生产
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

# 重建单个服务
docker compose build api-server
docker compose up -d api-server

# 清理
docker compose down -v                  # 移除 volumes (⚠️ 删除数据!)
```
