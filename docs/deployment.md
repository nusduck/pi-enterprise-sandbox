# Deployment Guide

> 生产部署指南 — 三容器 + Nginx 反向代理 + SSL + 资源限制 + 持久化存储

## 快速启动（开发模式）

```bash
# 1. 配置
cp .env.example .env
vi .env  # 填入 LLMIO_BASE_URL 和 LLMIO_API_KEY

# 2. 构建并启动
docker compose up --build -d

# 3. 验证
curl http://localhost:3000           # Frontend
curl http://localhost:4000/api/status # API Server
curl http://localhost:8083/health     # Sandbox (MCP 端口)
```

| 服务 | 端口 | 容器内端口 |
|------|------|-----------|
| Frontend (Nginx) | `3000` | `80` |
| API Server | `4000` | `4000` |
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
                  │   api-server (Node:4000)      │
                  │   pi-coding-agent SDK          │
                  │   LLM proxy (直连, 无代理层)    │
                  └───────────────┬──────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   sandbox (FastAPI:8081)       │
                  │   Execution · Files · Auth     │
                  │   SQLite / PostgreSQL         │
                  │   MCP:8091                    │
                  └──────────────────────────────┘
```

## 环境变量

### Auth

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_API_TOKEN` | — | Sandbox API 令牌。生成: `openssl rand -hex 32`。所有 API 调用需带 `X-API-Key` header |
| `SANDBOX_MCP_AUTH_TOKENS` | — | MCP 端点认证令牌，逗号分隔 |

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
| `SANDBOX_DATABASE_URL` | `sqlite:////sandbox/data/sandbox.db` | SQLite（开发）或 PostgreSQL（生产） |

**开发（SQLite）:** 无需额外配置，自动创建。

**生产（PostgreSQL）:**
```yaml
# 添加到 docker-compose.yml:
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: sandbox
      POSTGRES_PASSWORD: <secure-password>
      POSTGRES_DB: sandbox
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U sandbox"]
    restart: always

volumes:
  postgres_data:
```

```env
SANDBOX_DATABASE_URL=postgresql://sandbox:***@postgres:5432/sandbox
```

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
| `./skills` | `/sandbox/skills:ro` | 内置技能（只读） |
| `./workspaces` | `/sandbox/workspaces` | 会话工作区 |

## Health Checks

```bash
# Frontend
curl -f http://localhost:3000/

# API Server
curl -f http://localhost:4000/api/status
# {"status":"ok","version":"4.0.0"}

# Sandbox
curl -f http://localhost:8083/health
# {"status":"ok","version":"0.1.0",...}

# Nginx (生产)
curl -f https://localhost/nginx/status
```

## Backup

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
| 单实例 | SQLite + Docker Compose（默认） |
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
