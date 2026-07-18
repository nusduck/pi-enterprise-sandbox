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
curl -f http://localhost:4000/health/ready  # BFF + dependencies
curl -f http://localhost:4100/health      # Agent
curl -f http://localhost:8083/health      # Sandbox liveness
curl -f http://localhost:8083/ready       # Sandbox readiness (workspaces + DB)
```

| 服务 | 端口 | 容器内端口 |
|------|------|-----------|
| Frontend (Nginx) | `3000` | `80` |
| API Server (BFF) | `4000` | `4000` |
| Agent | `4100` | `4100` |
| Sandbox API | 内网仅 | `8081` |

## 生产部署

```bash
# 使用生产 overlay（Nginx + SSL + 资源限制）
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d

# 验证
curl -sf https://localhost/health/ready
curl -sf https://localhost/nginx/status
```

### Workspace / temp disk quota (production)

Positive `SANDBOX_WORKSPACE_QUOTA_MB` / `SANDBOX_TEMP_QUOTA_MB` claim multi-tenant
disk isolation. Production validation requires **both**:

1. `SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT=true` — in-process **monitoring**
   (bounded fail-closed tree sample; kills children on over-quota or measure failure).
   This is **not** a hard total: inter-sample races and multi-file writes under
   `RLIMIT_FSIZE` remain.
2. `SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED=true` — **operator assertion**
   that workspace/temp roots sit on an external hard quota (XFS project quota,
   volume size, filesystem project, etc.). The process does **not** auto-detect
   this. Keep `false` in compose defaults until a live gate verifies the backend,
   then set explicitly.

Child monitor codes: `workspace_quota_exceeded`,
`workspace_inode_limit_exceeded`, `workspace_quota_enforcement_failed`.



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
                  │   MySQL 8 (formal topology)    │
                  └──────────────────────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │   redis:7.2 (Agent-only)      │
                  │   Queue · Lease · Stream      │
                  │   (not fact authority)        │
                  └──────────────────────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │ External MCP Gateway/Servers │
                  └──────────────────────────────┘
```

## 环境变量

### Auth

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_API_TOKEN` | — | Sandbox API 令牌。生成: `openssl rand -hex 32`。所有 API 调用需带 `X-API-Key` header |
| `MCP_SERVERS_JSON` | `[]` | Agent Runtime 外部 MCP Server 配置；凭据使用环境变量引用 |

### Execution policy profile

| 变量 | 开发 Compose 默认值 | 生产值 | 说明 |
|------|-------------------|--------|------|
| `SANDBOX_POLICY_PROFILE` | `balanced` | `strict` | `balanced` 只在 required Bubblewrap 生效时放行常见包管理器命令的审批前置门；网络仍由 `SANDBOX_NETWORK_MODE` 决定 |
| `SANDBOX_ISOLATION_BACKEND` | `bubblewrap` | `bubblewrap` | `balanced` 的必要隔离后端 |
| `SANDBOX_ISOLATION_REQUIRED` | `true` | `true` | 隔离 preflight 失败即不 Ready |

`strict` 是代码默认值，也是生产唯一允许的 profile。`balanced` 不放宽 session/path
归属、Skill 根只读、最小环境、能力丢弃、设备/namespace hard-deny 或审批开关；它只
减少 `pip/npm/yarn/pnpm install` 等常见开发命令的重复审批。若 `network_mode=disabled`
（生产唯一允许值），进程启动器拒绝网络类命令，且 Bubblewrap 子进程使用
`--unshare-net`（空 netns）。`allowlist` / `unrestricted` 仅可在研发显式开启，且
**不得**当作生产隔离：当前没有 per-child 受控 egress proxy，生产校验 fail-closed。
metadata/link-local 目的地阻断始终开启。

迁移与回滚：开发环境可先设置 `SANDBOX_POLICY_PROFILE=strict`，验证 `/ready` 和审批
流后再切换到 `balanced`。出现异常时把该变量改回 `strict` 并重启 Agent/Sandbox；不需要
迁移 workspace 或数据库。生产 overlay 固定为 `strict`，不能通过 `.env` 覆盖。

### 入站网络（监听 vs 来源白名单）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `SANDBOX_BIND_HOST` | `0.0.0.0` | **仅控制监听接口**。`0.0.0.0` 不等于允许任意来源。旧名 `SANDBOX_HOST` 仍可用 |
| `SANDBOX_ALLOWED_CLIENT_CIDRS` | loopback + Docker 私网 | Sandbox HTTP 来源 CIDR 白名单。空列表 = 拒绝全部（失败关闭） |
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

外部 MCP 由 Agent Runtime 直接连接，不经过 Sandbox。凭据由 `authTokenRef` 指向的环境变量注入。

**命名分离：** `SANDBOX_ALLOWED_CLIENT_CIDRS` 只约束 **入站** HTTP 客户端；
`SANDBOX_NETWORK_MODE` 只约束 **出站执行** 策略。已移除 container-wide iptables
与 `SANDBOX_ALLOWED_CIDRS` / 端口 union allowlist 作为隔离权威的设计。

### 出站执行网络（与入站 CIDR 无关）

| 变量 | 开发 | 生产 | 说明 |
|------|------|------|------|
| `SANDBOX_NETWORK_MODE` | 可显式 `unrestricted` | 固定 `disabled` | 生产禁止 `allowlist`/`unrestricted` |

Compose 拓扑：`backend_internal`（`internal: true`）供 mysql/redis/sandbox/api/frontend；
`agent`/`agent-worker` 同时接入 `service_egress` 以访问 LLM；Sandbox 不挂 egress 网。

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

### Database（MySQL 8）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MYSQL_DATABASE` | `sandbox` | MySQL database name |
| `MYSQL_USER` | `sandbox` | MySQL application user |
| `MYSQL_PASSWORD` | 开发占位 `sandbox_dev_only`；生产无默认 | 应用用户密码（生产必填强 secret） |
| `MYSQL_ROOT_PASSWORD` | 开发占位；生产无默认 | root 密码（生产必填强 secret） |
| `AGENT_DATABASE_URL` | `mysql://…@mysql:3306/sandbox` | Agent 事实库（仅 `mysql://` / `mysql2://`） |
| `SANDBOX_DATABASE_URL` | `mysql+pymysql://…@mysql:3306/sandbox` | Sandbox 持久化（`mysql+pymysql://` 或 `mysql://`） |

**开发:** `docker compose up` 启动 `mysql:8.0`；DSN 默认指向 compose 网络内 `mysql` 服务。占位密码仅用于本地，勿用于共享/生产环境。

**生产:** `docker-compose.prod.yml` 内置 MySQL 8、healthcheck、持久 volume，以及 Sandbox/Agent 对 MySQL 的健康依赖。启动前必须设置强 `MYSQL_PASSWORD` 与 `MYSQL_ROOT_PASSWORD`；production overlay **不**回退 SQLite 或 PostgreSQL。Sandbox 生产配置校验拒绝非 MySQL DSN。

**Triggers / binary log (migration gate):** Agent migrations issue `CREATE TRIGGER`
as the non-SUPER application user. Compose-managed `mysql` services set
`--log-bin-trust-function-creators=1` (dev + prod overlay). Do **not** grant
`SUPER` to `MYSQL_USER`. If `AGENT_DATABASE_URL` points at **external/managed**
MySQL, operators must enable the equivalent platform flag before first migrate;
the Agent fail-closes with `MYSQL_TRIGGER_BINLOG_BLOCKED` and will **not**
`SET GLOBAL` on remote hosts. See
[mysql-partial-migration-recovery.md § Triggers and binary logging](runbooks/mysql-partial-migration-recovery.md#triggers-and-binary-logging).

研发阶段不可逆的空环境切换见 [Development reset runbook](runbooks/development-reset.md)。该流程明确不备份、不迁移、不恢复旧数据。

### Redis 7（Agent-only 运行态协调）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REDIS_PASSWORD` | 开发占位 `redis_dev_only`；生产无默认 | Redis `requirepass`（生产必填强 secret，fail-fast） |
| `REDIS_URL` | `redis://:…@redis:6379/0` | 通用 / plan 别名 DSN |
| `AGENT_REDIS_URL` | 同 `REDIS_URL` 形 | Agent 客户端主 DSN（仅 `redis://` / `rediss://`） |
| `TEST_REDIS_URL` | _(可选)_ | 集成测试 DSN |
| `AGENT_RUNS_QUEUE_NAME` | `agent-runs` | BullMQ Run Queue |
| `AGENT_RUN_LEASE_TTL_MS` | `30000` | Worker lease TTL（ms） |
| `AGENT_RUN_LEASE_RENEW_INTERVAL_MS` | `10000` | Lease 续约间隔（ms） |
| `AGENT_RUN_STREAM_MAXLEN` | `10000` | Run stream 近似 `MAXLEN` |

**开发:** `docker compose up` 启动 `redis:7.2`（AOF + `redis_dev_data` volume）。Agent 依赖 Redis health；默认 DSN 指向 compose 网络内 `redis` 服务。占位密码仅用于本地。

**生产:** `docker-compose.prod.yml` 要求 `REDIS_PASSWORD` 已设置（`${REDIS_PASSWORD:?…}` fail-fast），启用 `requirepass`、healthcheck、持久 `redis_data` volume，Agent 对 Redis `service_healthy` 依赖；**不**对外发布 Redis 端口。BFF **不**获得 Redis 权威环境变量。

**Sandbox internal plane（PR-07 replay-only）:**

| 变量 | 说明 |
| --- | --- |
| `SANDBOX_INTERNAL_PLANE_ENABLED` | 开发默认 `false`；**生产必须 `true`**（启动 fail-closed） |
| `SANDBOX_INTERNAL_REDIS_PASSWORD` | **独立** replay 密码；**禁止**等于 `REDIS_PASSWORD` |
| `SANDBOX_INTERNAL_REDIS_URL` | 指向专用服务 `sandbox-replay-redis:6379/0`（固定 DB0）；仅 jti `SET NX` |
| `SANDBOX_INTERNAL_HMAC_KEYRING` / `ACTIVE_KID` | Agent→Sandbox HMAC；生产必填 |
| `SANDBOX_INTERNAL_DRAIN_TIMEOUT_SECONDS` | 必须 **>0**；超时后先 UNKNOWN reconcile，再关 MySQL |

- Compose 使用 **独立** `sandbox-replay-redis` 服务 + 独立 volume/密码；**不是** Agent `redis` 换 DB 索引。
- 最小权限：键 `sandbox:internal:replay:v1:*`；命令 SET/PING（及握手）；固定 DB0；不授 SELECT。
- Sandbox **不得**获得 Agent Redis 凭据；Agent **不得**获得 replay secret。
- 真实 Redis ACL / 连通性为本仓库最终 gate，离线测试只覆盖配置语义。

**清空 Redis 与恢复:**

- Redis 清空 / 丢失只影响运行态协调（queue、lease、live stream、短期 cache）以及 Sandbox internal jti 防重放窗口，**不**删除 MySQL 中的 Conversation / Run / 审计事实。
- 未成功发布到 Redis Stream 的事件保留在 MySQL `domain_outbox`，Outbox publisher 可在 Redis 恢复后重试。
- 完整事件历史与 SSE 重放以 MySQL `run_events` 为准；Redis Stream 可按长度裁剪。

已提交文档中的 DSN 示例仅使用开发占位或省略密码（`redis://:…@host:6379/0`）；勿把真实生产密码写进仓库。

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
| `./tmp-workspaces` | `/var/sandbox/tmp` | Conversation-owned 持久化 `/tmp`（`tmp_{workspace_id}`） |

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
| Sandbox readiness | `GET /ready` | 200 | **503** = workspace/`/tmp` 不可写、数据库不可用或 Bubblewrap preflight 失败 |
| API Server liveness | `GET /health/live` | 200 | BFF 进程不可用 |
| API Server readiness | `GET /health/ready` | 200 | Agent 或 Sandbox 未就绪（503） |
| Frontend | `GET /` | 200 | 静态站/反代不可用 |

```bash
# Frontend
curl -f http://localhost:3000/

# API Server（仅 node-agent；无 Python/双 Runtime）
curl -f http://localhost:4000/health/ready
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

1. `docker compose up --build -d` → 等待 `curl -f localhost:4000/health/ready` 与 `curl -f localhost:8083/ready`
2. 浏览器打开 `http://localhost:3000`，发送多轮消息（同一 conversation）
3. 触发高风险 bash → UI 出现审批 → approve/reject
4. 上传二进制文件 → 下载校验字节一致
5. 生成中点击停止 → 流结束且无悬挂执行
6. Agent `submit_artifact` 后出现可下载交付物（非 `write` 自动下载）

Node / Python / Pi SDK 版本钉以根目录 `runtime-versions.json` 为准：服务镜像与 CI 统一 **Node 22**（`node:22-slim`、`engines >=22.19.0 <23`）、Sandbox **Python 3.11**（`python:3.11-slim`）、Agent SDK **0.80.3** 精确钉。一致性由 `tests/test_runtime_versions.py` 校验。

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
| 单实例开发 | MySQL 8 + Redis 7 + Docker Compose |
| 生产 | MySQL 8 + Redis 7 + Compose prod overlay（强制 secrets） |
| 多实例 | MySQL + Redis + 共享工作区存储 (NFS/EFS) |
| 高可用 | 负载均衡器 + MySQL 复制 / 托管 MySQL + 托管 Redis |

## Troubleshooting

### Sandbox 容器无法启动

```bash
docker compose logs sandbox
docker compose run --rm sandbox python -c "import fastapi; print('ok')"
```

### API Server 状态异常

```bash
# 检查 API Server 健康
curl http://localhost:4000/health/ready

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
# 重置数据库（⚠️ 删除所有数据，含 MySQL volume）
docker compose down -v
docker compose up -d

# 备份 MySQL（示例；生产请用受控备份链路）
docker exec pi-enterprise-mysql \
  mysqldump -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" > backup.sql

# 运行 SQL 查询（交互）
docker exec -it pi-enterprise-mysql \
  mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"
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
