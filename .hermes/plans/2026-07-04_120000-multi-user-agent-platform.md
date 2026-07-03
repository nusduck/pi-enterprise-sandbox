# Multi-User Agent Platform — Implementation Plan

> 将 pi-web-ui + pi-core-agent + pi-enterprise-sandbox 集成为生产级多用户 Agent 平台
> 基于容器部署，支持认证、多租户隔离、生产加固

**目标：** 构建一个可直接部署的生产级多用户 Agent 平台，每个用户拥有独立的隔离会话、持久化对话、安全的代码执行环境。

**当前状态：** 已有 pi-agent BFF + sandbox 双容器架构，前端通过 `@earendil-works/pi-web-ui` + `@earendil-works/pi-agent-core` 集成，但：
- ❌ 无用户认证系统
- ❌ 无多用户隔离
- ❌ 无 HTTPS/反向代理
- ❌ 单 SQLite 实例，无 PostgreSQL 备选
- ❌ 无容器资源限制生产配置

**目标架构：**
```
                     ┌───────────────────────┐
                     │   Nginx (HTTPS/SSL)    │
                     │   反向代理 + 限流      │
                     └──────┬────────────────┘
                            │
              ┌─────────────▼──────────────┐
              │   pi-agent:3000 BFF         │
              │   JWT 验证 + 用户上下文       │
              │   对话管理 (按用户隔离)        │
              └─────────────┬──────────────┘
                            │
              ┌─────────────▼──────────────┐
              │   sandbox:8081              │
              │   JWT 中间件                 │
              │   按用户隔离 Session/Workspace │
              │   PostgreSQL/SQLite 双后端    │
              │   用户级限流 + Rate Limit     │
              └────────────────────────────┘
```

**技术栈：**
- 前端：`@earendil-works/pi-web-ui` + `@earendil-works/pi-agent-core`
- BFF：Node.js 20 (server.js)
- Sandbox：Python 3.11+ / FastAPI
- 数据库：SQLite (WAL) / PostgreSQL (psycopg2)
- 认证：JWT (PyJWT / jsonwebtoken)
- 反向代理：Nginx + Certbot (LetsEncrypt)
- 容器：Docker Compose v2

---

## Phase 1: 用户认证系统 (Auth Foundation)

### Task 1.1: Sandbox — 用户模型 + 数据库表

**Objective:** 在 sandbox 数据库中添加 users 表，支持注册和登录。

**Files:**
- Modify: `sandbox/models.py` — 添加 User Pydantic 模型
- Modify: `sandbox/database.py` — 添加 users 表初始化
- Modify: `sandbox/repositories.py` — 添加 UserRepository
- Create: `sandbox/auth.py` — 密码哈希 + JWT 工具函数
- Create: `sandbox/routers/auth.py` — 注册/登录端点
- Modify: `sandbox/main.py` — 注册 auth 路由

**Design:**

```python
# Users table
CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT,
    role TEXT NOT NULL DEFAULT 'user',  # 'admin' | 'user'
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
);
```

JWT 使用 HS256，过期时间可配置（默认 24h）。

**API:**
- `POST /auth/register` — 注册 `{username, email, password, display_name?}`
- `POST /auth/login` — 登录 `{username, password}` → `{token, user}`
- `GET /auth/me` — 获取当前用户信息

### Task 1.2: Sandbox — JWT 鉴权中间件

**Objective:** 保护所有 sandbox API 端点，要求有效 JWT。

**Files:**
- Modify: `sandbox/auth.py` — 添加 `verify_token()` + `AuthMiddleware`
- Modify: `sandbox/main.py` — 注册中间件，排除 `/health`, `/auth/*`, `/metrics`

**Design:**
所有 `/sessions/*`, `/approve`, `/traces/*` 和文件操作端点都需要 `Authorization: Bearer <token>` header。
中间件提取 token → 验证 → 注入 `request.state.user_id` + `request.state.user_role`。

### Task 1.3: WebUI — 登录页面 + JWT 管理

**Objective:** 添加登录/注册页面和 token 持久化。

**Files:**
- Create: `webui/src/login.js` — 登录页面组件
- Create: `webui/index.html` — 登录/注册界面
- Modify: `webui/server.js` — 添加 `/api/auth/*` 代理到 sandbox
- Modify: `webui/src/main.js` — 启动时检查 token，无 token 显示登录页

**Flow:**
1. 用户访问 → 检查 localStorage 中 token
2. 无 token → 显示登录页
3. 用户登录 → 后端验证 → 返回 JWT → 存入 localStorage
4. 所有 API 请求自动附带 `Authorization: Bearer <token>`
5. token 过期 → 自动跳转登录页

### Task 1.4: WebUI — 会话 + 对话按用户隔离

**Objective:** 每个用户的对话、sandbox session 按 user_id 隔离。

**Files:**
- Modify: `webui/server.js` — conversation 存储增加 user_id 字段
- Modify: `webui/src/main.js` — sandbox session 创建时传入 user_id

**Design:**
- Conversations 存储增加 `userId` 字段，查询时按 userId 过滤
- Sandbox session 创建时传 `caller_id=user_id`
- Sandbox 侧 session 记录 `user_id` 字段

---

## Phase 2: 多用户隔离 (Multi-Tenant Isolation)

### Task 2.1: Sandbox — 按用户分组 Session

**Objective:** session 表增加 user_id，查询接口支持按用户过滤。

**Files:**
- Modify: `sandbox/models.py` — SessionModel 增加 user_id
- Modify: `sandbox/repositories.py` — 按 user_id 查询
- Modify: `sandbox/services/session_manager.py` — 创建/查询时绑定 user_id

### Task 2.2: Sandbox — Workspace 按用户隔离

**Objective:** workspaces 目录结构改为 `workspaces/<user_id>/<session_id>/`。

**Files:**
- Modify: `sandbox/services/workspace_manager.py` — 路径加入 user_id

### Task 2.3: Sandbox — 用户级限流

**Objective:** 每个用户有独立的 API 调用频率限制。

**Files:**
- Modify: `sandbox/auth.py` — 添加 rate limiter (基于 user_id + 滑动窗口)
- Modify: `sandbox/main.py` — 注册限流中间件

**Design:**
- 默认：60 请求/分钟 per user
- `/auth/login`：10 请求/分钟（防止暴力破解）
- 管理员不受限流限制

---

## Phase 3: 生产部署基础设施

### Task 3.1: Nginx 反向代理 + SSL

**Objective:** 添加 Nginx 容器，处理 HTTPS、静态资源缓存、WebSocket 代理。

**Files:**
- Create: `nginx/nginx.conf`
- Create: `nginx/Dockerfile`
- Modify: `docker-compose.yml` — 添加 nginx 服务

**Nginx 配置要点：**
- SSL 终止 (LetsEncrypt)
- 反向代理到 pi-agent:3000
- SSE 支持 (`proxy_buffering off`)
- 静态资源缓存 (`Cache-Control`)
- 限流 (`limit_req_zone`)
- 请求体大小限制 (10M)

### Task 3.2: PostgreSQL 数据库后端

**Objective:** 使数据库后端可切换：SQLite (dev) / PostgreSQL (prod)。

**Files:**
- Modify: `sandbox/database.py` — 复用现有 `DatabaseBackend` 抽象
- Modify: `sandbox/repositories.py` — 确保所有 repository 兼容 PostgreSQL
- Create: `docker-compose.prod.yml` — 添加 PostgreSQL 服务 + Sandbox 连接

**当前代码已支持：** DatabaseBackend 抽象类 + SQLiteBackend + PostgreSQLBackend（有 _ConnectionWrapper 转换占位符）。主要工作是确保 repositories 的统一 SQL 语法兼容。

### Task 3.3: Docker Compose 生产配置

**Objective:** 为生产环境准备的 docker-compose 配置，含资源限制、健康检查优化、日志轮转。

**Files:**
- Create: `docker-compose.prod.yml`
- Modify: `.env.example` — 添加生产相关变量

**生产配置要点：**

| 项目 | 值 |
|------|-----|
| 重启策略 | `always` |
| 资源限制 | sandbox: 1 CPU / 1GB memory |
| 日志 | `max-size: "10m"`, `max-file: "3"` |
| 网络 | 专用 bridge network |
| 健康检查 | 30s interval, 3 retries |

### Task 3.4: 备份与运维脚本

**Objective:** 数据库备份、日志收集、运行状态检查脚本。

**Files:**
- Create: `scripts/backup.sh`
- Create: `scripts/restore.sh`
- Create: `scripts/health-check.sh`
- Create: `Makefile`

---

## Phase 4: 管理与监控

### Task 4.1: 管理员 API

**Objective:** 管理员可管理用户（列表、封禁、删除）。

**Files:**
- Create: `sandbox/routers/admin.py`
- Modify: `sandbox/main.py` — 注册 admin 路由

**管理员端点：**
- `GET /admin/users` — 用户列表
- `PATCH /admin/users/{id}` — 更新用户状态
- `DELETE /admin/users/{id}` — 删除用户
- `GET /admin/sessions` — 所有活跃 session

### Task 4.2: WebUI 管理员面板

**Objective:** 管理员页面展示用户列表、系统状态。

**Files:**
- Create: `webui/src/admin.js`
- Create: `webui/admin.html`

### Task 4.3: 健康监控 + Alert

**Objective:** 集成 Prometheus 指标，设置关键告警。

**Files:**
- Modify: `sandbox/routers/health.py` — 增强 Prometheus metrics
- Create: `prometheus/prometheus.yml`
- Create: `grafana/dashboards/sandbox.json`

---

## 迭代顺序

```
Iter 1 (P0): Auth 基础 — Phase 1 (Tasks 1.1-1.4)
  → 用户注册/登录，JWT 保护所有 API
  → 登录页面，前端 token 管理

Iter 2 (P0): 多用户隔离 — Phase 2 (Tasks 2.1-2.3)
  → 按 user_id 隔离 session/workspace/对话
  → 用户级限流

Iter 3 (P1): 生产部署 — Phase 3 (Tasks 3.1-3.2)
  → Nginx + SSL
  → PostgreSQL 支持 (可选)

Iter 4 (P1): 运维管理 — Phase 4 (Tasks 4.1-4.3)
  → 管理员 API + 面板
  → 监控 + 备份脚本
```

## 验收标准

| # | 标准 | 验证方式 |
|---|------|----------|
| 1 | 用户可注册、登录、退出 | curl 注册/登录端点 |
| 2 | 未登录用户不能访问任何受保护端点 | curl 返回 401 |
| 3 | 用户 A 不能看到用户 B 的对话/workspace | 创建两个用户，交叉查询 |
| 4 | 管理员可查看所有用户和 session | 用 admin token 调 admin API |
| 5 | Nginx 提供 HTTPS | curl https://domain |
| 6 | PostgreSQL 可用 | 切换 DATABASE_URL，重启验证 |
| 7 | `docker compose up -d` 即可全栈启动 | 一键部署验证 |
| 8 | 备份脚本可导出/导入整个数据库 | 运行 backup.sh + restore.sh |

## 待决策问题

1. **用户注册策略：** 是否开放注册还是仅管理员创建？→ **建议：开放注册 + 管理员审核**
2. **JWT 过期时间：** 短期（24h）+ refresh token 还是长期（7d）？→ **建议：24h + refresh token**
3. **PostgreSQL 优先级：** 一期必做还是可选？→ **建议：一期 SQLite 即可，PostgreSQL 延后**
4. **前端 UI：** 用现成登录组件还是自建？→ **建议：自建轻量登录页，因为 pi-web-ui 不提供 auth 组件**
