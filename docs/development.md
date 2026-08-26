# Development Guide

## 本地开发

### 前置要求

- **Python 3.11**（次版本固定；`runtime-versions.json` / `.python-version`；`requires-python = ">=3.11,<3.12"`）
- **Node.js 22**（主版本固定；`runtime-versions.json` / `.node-version`；`engines.node = ">=22.19.0 <23"`，与 Pi SDK `0.80.3` 一致）
- **Pi SDK** `@earendil-works/pi-coding-agent` / `@earendil-works/pi-ai` **精确** `0.80.3`（仅 `agent/`；禁止 `^`/`~`）
- **Docker** / Docker Compose
- **Git**

版本声明的权威源是仓库根目录 `runtime-versions.json`；一致性由 `tests/test_runtime_versions.py` 机器校验。升级 SDK 见 [runbooks/sdk-upgrade.md](./runbooks/sdk-upgrade.md)。

### 干净安装（CI 同款）

从仓库根目录执行。自动化环境优先 `npm ci`（需 lockfile）；本地首次可用 `npm install`。

```bash
# 0. 环境模板（勿提交真实 .env）
cp .env.example .env
# 编辑 .env：至少填入 LLMIO_BASE_URL / LLMIO_API_KEY；可选 SANDBOX_API_TOKEN
# 多用户归属（默认关闭）: SANDBOX_AUTH_ENABLED=true + AUTH_ENABLED=true + SANDBOX_JWT_SECRET
# 关闭鉴权即回退 open 单用户模式；ownership 列与 bootstrap 回填结果保留

# 1. Python（Sandbox + pytest）
uv sync --extra test

# 2. Node BFF + Agent + Frontend（Node 22）
npm ci --prefix api-server
npm ci --prefix agent
npm ci --prefix frontend
# 无 lock 或本地开发也可用：npm install --prefix <pkg>
```

### 权威验证命令（与 `.github/workflows/test.yml` 对齐）

```bash
# Python（含 runtime-versions 一致性）
uv run pytest tests/ -q --tb=short
# 仅版本钉：uv run pytest tests/test_runtime_versions.py -q

# Node BFF（含 import/listen smoke）
node --test api-server/tests/*.test.js
# 或：npm test --prefix api-server

# Node Agent（含 sdk-compat、fake OpenAI、listen smoke）
node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js
# SDK 精确版本：npm ls --prefix agent @earendil-works/pi-coding-agent
# 升级流程：docs/runbooks/sdk-upgrade.md · ADR：docs/adr/0001-pi-coding-agent-sdk.md
# SSOT：runtime-versions.json

# Frontend
npm test --prefix frontend
npm run build --prefix frontend

# Compose 文件合法性（需要 .env；可用 .env.example 复制）
test -f .env || cp .env.example .env
docker compose config -q

# 无真实 LLM key 的四服务协议 smoke（deterministic fake OpenAI；生产禁用）
node scripts/smoke-cross-service.mjs
```

### 本地运行态目录

宿主机生成的运行态统一位于 `.runtime/`，不得再在仓库根目录新增
`workspaces/`、`tmp-workspaces/`、`artifacts/`、`control/` 或散落的
smoke/gate 临时目录。

```text
.runtime/
  sandbox/{workspaces,tmp,artifacts,control}
  agent/pi-agent-home
  smoke/
  release-gates/
  pytest-cache/
  worktrees/
```

`.runtime/` 由 Git 和 Docker build context 共同忽略。容器内路径仍为
`/var/sandbox/*` 与 `/app/pi-agent-home`，因此这一整理不改变运行协议。
旧目录只为无损升级继续保持忽略；确认数据已迁移后可由维护者手动清理。

### 运行（本地四进程）

```bash
# Terminal 1: Sandbox
# Inbound allowlist defaults to loopback + private ranges; see SANDBOX_ALLOWED_CLIENT_CIDRS.
# SANDBOX_BIND_HOST only sets the listen address (0.0.0.0 ≠ allow any client).
uv run uvicorn sandbox.main:app --host 127.0.0.1 --port 8081 --reload

# Terminal 2: Agent（需要 Sandbox + LLM 配置）
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix agent

# Terminal 3: API Server / BFF（需要 Sandbox + Agent）
SANDBOX_BASE_URL=http://localhost:8081 AGENT_BASE_URL=http://localhost:4100 \
  npm run dev --prefix api-server

# Terminal 4: 前端（Vite 热更新，dev proxy → localhost:4000）
npm run dev --prefix frontend
# 访问 http://localhost:5173
```

或使用 Docker：

```bash
# 完整栈
docker compose up --build

# 仅 Sandbox（用于 Agent / BFF 本地开发）
docker compose up --build sandbox -d
# 然后本地运行 Agent + BFF：
SANDBOX_BASE_URL=http://localhost:8081 npm run dev --prefix agent
SANDBOX_BASE_URL=http://localhost:8081 AGENT_BASE_URL=http://localhost:4100 \
  npm run dev --prefix api-server
```

## 开发流程

### 新增 API 端点 (Sandbox)

1. 在 `sandbox/routers/` 创建或更新 router
2. 在 `sandbox/services/` 添加业务逻辑
3. 在 `sandbox/main.py` 注册 router
4. 如需新模型，在 `sandbox/models.py` 添加 Pydantic schema
5. 编写测试 `tests/`
6. 更新 API 文档 `docs/api.md`

### 新增技能（零 Skill 仍可启动）

Agent **可以在零 Skill package 下启动**并使用基础工具（read/write/edit/bash/ls/find/grep/submit_artifact 等）。仓库 `skills/` 当前可挂载共享 Skill package（如文档/办公类技能）；它们不是运行时硬依赖。

每个 Run 先扫描系统层和调用者自己的用户层。若
`AgentVersion.configJson.skills` 非空，它作为 allowlist 进一步收窄模型可见
的 Skill；模型与运营侧的最终权威清单来自 **session-scoped capability
registry** 与模型工具 `capabilities`（list/search/describe），而不是模型对
prompt 的记忆。

**方式 A — 手工放置（仍建议只读挂载）**

1. 在 `skills/your-skill-name/` 创建目录
2. 添加 `SKILL.md`（YAML frontmatter：`name` + `description` 必填）
3. 添加脚本到 `skills/your-skill-name/scripts/`
4. `skills/` 默认只读挂载到 Agent / Sandbox skill 根
5. Agent 通过 Pi ResourceLoader 发现 Skill，再应用可选的 `AgentVersion.skills` allowlist；工作区始终从空目录起步，Skill 不复制进 workspace
6. 重新构建服务或创建新 session 以刷新系统层 registry

**方式 B — 用户对话安装**

Skill 分两层：

| 层 | 路径 | 可见范围 | 可写 |
|----|------|----------|------|
| 系统 | `/home/sandbox/skill`（仓库 `./skills`） | 所有人 | 否 |
| 用户 | `/home/sandbox/skill-user/<orgId>/<userId>` | 仅该用户 | 是 |

每个 Run 只扫描 `[系统层, 自己的用户目录]`，系统层优先。用户目录在 named volume
上，所以装过的 skill **跨对话、跨容器重建都在**，但**不跨用户** —— 别人（哪怕同组织）
的 agent 上下文里看不到，Sandbox 执行时也只 bind 调用者本人的目录。

Skill 生命周期在所有部署环境中使用同一套行为，不读取开发/生产模式开关。安全性来自
用户目录隔离、当前回合附件绑定、归档校验，以及所有变更工具的审批。

```bash
# .env
SKILLS_ROOT=/home/sandbox/skill
SKILLS_USER_ROOT=/home/sandbox/skill-user
# 可选审计文件
# SKILLS_AUDIT_LOG=/tmp/skill-audit.jsonl
```

注册的工具（`skill-lifecycle` 扩展，per-Run 绑定调用者身份）：

| 工具 | 作用 |
|------|------|
| `skill_list` | 列出两层可见 package（含 tier / description / 是否可编辑） |
| `skill_install` | 安装单个 package：当前回合上传的 `.zip`（`source="attachment"`，默认），或模型自己在沙盒里搭好并打包的 `.zip` / `.skill`（`source="sandbox"`，传 `path` 与 `source_digest`） |
| `skill_create` | 把与用户确认后的说明和文本文件原子生成成一个 package |
| `skill_uninstall` | 删除自己装的 package（系统层不可删） |
| `skill_edit` | 修改已安装用户 package；不能用来新建 package |

上传流程复用聊天附件：前端把 ZIP 作为 Dataset 上传到当前 Sandbox session，Run 中保留
结构化 `attachment_id`。Agent 只把当前回合的 attachment id 交给 `skill_install`；审批通过后，
Worker 使用 owner-scoped Sandbox client 下载内容，在 Agent 用户 Skill 卷内的临时目录安全解压、
校验唯一 `SKILL.md`、原子替换并自动 reload。URL 不是工具参数。

`source="sandbox"` 是给「模型自己写一个 Skill」用的：模型用普通 `write` / `bash` 在
workspace 或 `/tmp` 里搭包、跑通、打成 ZIP，然后把**归档路径**交给 `skill_install`。
路径先过 `sandbox-bridge` 的 `normalizeLogicalPath`（Skill 根被显式拒绝——只读挂载不能
既是安装源又是安装目标），再由 Sandbox 的 `parse_sandbox_path` 二次限定在该 session 的
workspace/temp 根内。取回字节走已有的 owner-scoped `GET /sessions/{id}/files/download`，
之后与上传路径**汇流到同一个** `installSkillArchive`：同样的解压、校验、原子替换。
换句话说，这条路增加的是「够得着一个归档」的方式，不是第二条写入 Skill 根的路径。

`source="sandbox"` 另外**必须**带 `source_digest`（归档的 sha256，64 位小写十六进制）。
原因是两条来源锚定字节的方式不同：attachment 由用户本回合上传的 attachment id 锚定，
而沙盒路径只是一个位置——`skill_install` 是 high risk，参数先入账本、审批通过后**重放**执行，
而这期间 workspace 一直可写。没有 digest，用户批准的归档与最终安装的归档可以不是同一份。
下载完成后按字节重算 sha256，不等即拒绝安装并同时给出两个摘要，不会"安装当前那一份"。
模型自己提供摘要并不削弱这一点：想装别的包它本来就可以直接提议，审批要挡的正是那个；
digest 挡住的是**批准之后掉包**。

`skill_create` 是“和 Agent 交互生成”的安装入口：Agent 收集并确认需求后，在一次高风险
工具调用中提交 `name`、`description`、`instructions` 与可选文件；用户批准后才落盘。

#### Bundled Skill dependencies

The Sandbox Docker image owns the runtime for bundled office Skills. Keep
dependency installation in `sandbox/Dockerfile` and
`sandbox/requirements.txt`; do not add first-run `npx`, `npm install`, or
`pip install` steps to a Skill that must work under production's disabled
execution network. BaoYu's two TypeScript converters use the image-provided
`/usr/local/bin/baoyu-format-markdown` and
`/usr/local/bin/baoyu-markdown-to-html` wrappers, whose source and lockfiles are
copied and installed at image build time.
Mermaid rendering uses the image-provided `baoyu-chromium` launcher through
`BAOYU_CHROME_PATH`; it calls the Chromium binary directly because the
production Bubblewrap child intentionally does not expose Debian's full
`/etc/chromium.d` launcher configuration.

When changing one of these Skills, rebuild `sandbox` before testing it. A
normal execution still sees the read-only `/home/sandbox/skill` bind mount for
instructions and source inspection, while the wrapper runs the corresponding
build-time copy under `/usr/local/lib/pi-skill-runtime`.

所有变更工具（install/create/edit/uninstall）默认 high risk。ZIP 解压拒绝 traversal、链接、
特殊文件、重复路径、加密条目和 zip bomb；通用 `write` / `edit` / `bash` 不能写 Skill 根。

### 配置工具风险等级与审批

审批**只由风险等级决定**——没有单独的「这个工具要不要审批」开关。风险表分两层，
下层只能收紧、不能放宽：

| 层 | 来源 |
|----|------|
| 平台 | `config/agent/tool-risk.json`（或 `TOOL_RISK_POLICY_PATH` / `TOOL_RISK_POLICY_JSON`） |
| AgentVersion | `configJson.toolPolicy` + `configJson.mcpServers[].toolPolicy` |

平台表结构：

```jsonc
{
  // 每个风险等级要付出的代价
  "riskApproval": {
    "low": "allow", "medium": "allow",
    "high": "require_approval", "critical": "deny"
  },
  // 没有显式条目时按分类兜底
  "classRiskLevels": {
    "local_low": "low",           // sandbox-bridge 工具
    "external_readonly": "medium", // 显式标记只读的 MCP 工具
    "external_high": "high",       // 其它 MCP 工具（有外部副作用）
    "internal_interaction": "low"  // ask_user
  },
  // 单个工具：完整名、server::tool，或以 * 结尾的前缀（最长前缀优先）
  "tools": { "bash": "low", "mcp__github__delete_*": "critical" },
  // 整个 MCP server 的默认风险 + 单工具覆盖
  "mcpServers": { "github": { "riskLevel": "high", "tools": { "search": "low" } } }
}
```

AgentVersion 侧（同一份语义，只能收紧）：

```jsonc
{
  "toolPolicy": {
    "riskLevels": { "bash": "high" },
    "riskApproval": { "medium": "require_approval" },
    "tools": { "mcp__github__merge": "deny" }   // 显式决定，覆盖该工具的风险映射
  },
  "mcpServers": [
    { "serverId": "github",
      "toolPolicy": { "riskLevel": "high", "toolRiskLevels": { "search": "low" } } }
  ]
}
```

配置文件写错会在启动时抛错（不会静默退回默认值）。每条策略审计记录里带
`riskLevel` 和 `riskSource`（例如 `tool:bash`、`mcpServer:github`），
可以直接定位是哪一行配置生效的。`/settings/capabilities` 页面展示的
`risk_level` / `Approval` / `Risk from` 就是这张表的回读。

未被分类器识别的工具始终 `UNKNOWN_TOOL_DENIED`，把它配成 `low` 也不会放行；
参数守卫（路径逃逸、敏感环境变量等）同样不受风险等级影响。

### 上下文压缩（compaction）

自动压缩由 Pi SDK 负责，默认开启：上下文 token 超过
`contextWindow - reserveTokens` 时触发。默认 `reserveTokens=16384`、
`keepRecentTokens=20000`。每次压缩会产生一条 `session.compacted` 事件。

按 AgentVersion 覆盖：

```jsonc
{ "contextPolicy": { "autoCompact": true, "reserveTokens": 16384, "keepRecentTokens": 20000 } }
```

`autoCompact: false` 关闭自动压缩（上下文溢出时会直接失败，而不是压缩后重试）。

### 修改前端

1. 从 `frontend/src/main.tsx` 和 `frontend/src/app/` 的 React Workbench 入口开始定位功能
2. Runtime 实体与归约逻辑在 `frontend/src/entities/`、`frontend/src/shared/state/`；API/SSE 适配在 `frontend/src/shared/`
3. 组件与页面分别位于 `frontend/src/widgets/`、`frontend/src/features/`、`frontend/src/pages/`
4. Vite 热更新自动生效；使用 `npm test --prefix frontend` 与 `npm run build --prefix frontend` 验证

### 修改 API Server（BFF）

1. `api-server/server.js` — HTTP 入口与路由分派
2. `api-server/src/routes/runs.js` — Run 创建、控制与序列化 SSE relay
3. `api-server/src/services/agent-client.js` — BFF → Agent HTTP 客户端
4. `api-server/src/config.js` — `AGENT_BASE_URL` / 内部令牌等
5. 语法检查: `node --check api-server/server.js`
6. 单元测试: `npm test --prefix api-server`

### 修改 Agent 服务

1. `agent/server.js` / `agent/worker.js` — HTTP 与 Worker 入口（仅装配 `src/bootstrap/*`）
2. `agent/src/bootstrap/` — ServiceContainer、HTTP factory、BullMQ worker（MySQL Create/Get/Cancel/Execute）
3. `agent/src/application/` — Run / Session recovery / Event SSE / A2A services
4. `agent/src/infrastructure/pi/` — Pi Runtime Factory + Session Adapter
5. `agent/src/extensions/` — 注册表内置必需 Extension（含 sandbox、审批、审计和交互）及用户级 `skill-lifecycle`
6. `agent/src/infrastructure/mcp/` — `pi-mcp-adapter`（禁止自研 MCP Client 主路径）
7. `agent/src/infrastructure/sandbox/sandbox-client.js` — Sandbox 内部 HMAC HTTP（`/internal/v1/*` 执行/文件/artifact submit；**不** dual-write Run）
8. 语法检查: `node --check agent/server.js && node --check agent/worker.js`
9. 单元测试: `npm test --prefix agent`

> 历史的进程内 Run manager、Python Agent runtime、双写 Session runtime 和自研 MCP connection manager 均已删除；Agent 的生产实现仅位于 `agent/src/`。

### 数据库操作

正式拓扑为 **MySQL 8**（`AGENT_DATABASE_URL` / `SANDBOX_DATABASE_URL`）。启动时 persistence 在单事务中应用不可变 migration，并在 `schema_migrations` 记录 version/checksum。不升级或回填研发阶段的旧数据库；需要清空旧状态时遵循 [Development reset runbook](runbooks/development-reset.md)。

正式服务的事实状态在 Agent-owned MySQL 中。Sandbox 不再包含 SQLite
`database`/repository 兼容层，也不拥有 Run/Conversation；调试 durable 状态
应使用 MySQL 客户端或 Agent repository，并遵守 owner scope：

```bash
docker compose exec mysql mysql -usandbox -p"$MYSQL_PASSWORD" sandbox \
  -e 'SELECT run_id, status FROM runs ORDER BY created_at DESC LIMIT 20;'
```

Sandbox 测试不建立数据库连接；需要覆盖拒绝逻辑时，可以显式构造非 MySQL
`Settings`，但不得把它作为应用启动或服务 fixture。

重置数据库（⚠️ 删除 MySQL volume 数据）：

```bash
docker compose down -v
docker compose up -d mysql
# 或按 runbook 做 development reset
```

### Redis 操作（Agent-only 协调）

正式协调拓扑为 **Redis 7**（`redis:7.2`；`AGENT_REDIS_URL` / `REDIS_URL`；可选 `TEST_REDIS_URL`）。Agent 依赖 Redis health；BFF 不持有 Redis 权威配置。Sandbox 另起 **sandbox-replay-redis**（独立密码/volume，DB0）仅作 internal HMAC jti 防重放，**不得**复用 Agent Redis 凭据。

- 默认 AOF + `redis_dev_data` volume：容器重建后协调数据仍在。
- **清空 Redis**（`FLUSHALL` 或删 volume）只丢失 queue/lease/stream 等运行态，**不**删除 MySQL 事实。
- Redis 暂停或清空后：Outbox publisher 从 MySQL `domain_outbox` 重试；事件历史从 `run_events` 重放。

```bash
# 仅重启 Redis（保留 volume）
docker compose up -d redis

# 清空协调状态但保留 MySQL（⚠️ 运行态 job/lease 丢失）
docker compose exec redis redis-cli -a redis_dev_only FLUSHALL
# 或：docker compose stop redis && docker volume rm <project>_redis_dev_data
```

生产启动前必须设置强 `REDIS_PASSWORD`；prod overlay 在缺失时 fail-fast。

## 测试

### 运行测试

```bash
# Python — 快速全部（CI 同款）
uv run pytest tests/ -q --tb=short

# 详细 / 定向
uv run pytest -v
uv run pytest tests/test_integration.py -v

# 覆盖率（可选；非 CI 强制门禁）
uv run pytest --cov=sandbox --cov-report=term-missing
uv run pytest --cov=sandbox --cov-report=html

# Node API Server（node:test，含 sdk-compat）
node --test api-server/tests/*.test.js
npm test --prefix agent
npm test --prefix api-server

# Frontend（node:test，见 frontend/test/*.test.js）
npm test --prefix frontend
npm run build --prefix frontend
```

### 测试结构

| 位置 | 测试内容 |
|------|----------|
| `tests/test_sandbox_mysql_import.py` | MySQL-only 启动、删除模块与公开路由回归 |
| `tests/test_formal_session_runtime.py` | 正式 Session/Workspace 运行时契约 |
| `tests/test_formal_execution_runtime.py` | 正式 Python/命令执行运行时契约 |
| `tests/test_file_manager.py` | 文件读写/列表/预览/二进制 |
| `tests/test_formal_artifact_runtime.py` | Artifact 显式提交、恢复与归属 |
| `tests/test_policy_checker.py` | 风险等级分类 |
| `tests/test_path_validation.py` | 路径逃逸防护 |
| `tests/test_internal_plane_lifecycle_batch_b.py` | 内部控制面生命周期 |
| `tests/test_sandbox_mysql_unit.py` | MySQL DSN/SQL 约束与拒绝路径 |
| `tests/test_sandbox_mysql_integration.py` | 真实 MySQL integration gate（需测试 DSN） |
| `tests/test_mysql_topology_config.py` | MySQL 拓扑/compose/config 静态校验 |
| `tests/test_redis_topology_config.py` | Redis 拓扑/compose/env 静态校验（PR-03） |
| `tests/test_builtin_skills.py` | 零 Skill 发行基线 |
| `tests/test_auth.py` / `test_internal_auth*.py` | 公开路由、API key/JWT 与内部 HMAC |
| `tests/test_python_agent_removed.py` | 确认 Python Agent Runtime 已删除 |
| `tests/test_container_startup.py` | Docker entrypoint, compose 配置 |
| `api-server/tests/*.test.js` | BFF agent-client / chat relay / listen smoke |
| `agent/tests/*.test.js` | Run API、fake OpenAI、listen smoke、SDK compat |
| `frontend/test/*.test.js` | SSE 解析、state、security/a11y |
| `scripts/smoke-cross-service.mjs` | 无真实 LLM key 的 BFF↔Agent↔Sandbox smoke |

### 编写测试

```python
from fastapi.testclient import TestClient
from sandbox.main import app

client = TestClient(app)

def test_my_endpoint():
    # Public Sandbox session creation was removed. Exercise a formal internal
    # contract with an injected fake repository/runtime instead.
    response = client.get("/health")
    assert response.status_code == 200
```

## 代码质量

### Linting

推荐 `ruff`：

```bash
pip install ruff
ruff check sandbox/ tests/
ruff format --check sandbox/ tests/
```

### Type Checking

```bash
pip install mypy
mypy sandbox/ --ignore-missing-imports
```

### 安全扫描

```bash
# 检查硬编码密钥
grep -rn "sk-[A-Za-z0-9]" --include="*.py" --include="*.js" --include="*.json"
grep -rn "api_key\s*=\s*['\"]" --include="*.py" --include="*.js" --include="*.json"
```

## Git 工作流

```bash
git checkout -b feat/your-feature
git add -A
git commit -m "feat: add your feature"
git fetch origin
git rebase origin/main
git push -u origin feat/your-feature
```

### Commit 规范 (Conventional Commits)

- `feat:` — 新功能
- `fix:` — Bug 修复
- `docs:` — 文档
- `test:` — 测试
- `refactor:` — 代码重构
- `chore:` — 构建/配置/依赖

## 调试

### Sandbox

```bash
# 查看日志
docker compose logs -f sandbox

# 交互式 shell
docker exec -it pi-enterprise-sandbox /bin/bash

# 查看 MySQL 表（compose 网络内 mysql 服务）
docker exec -it pi-enterprise-mysql \
  mysql -usandbox -psandbox_dev_only sandbox -e "SHOW TABLES;"
```

### API Server

```bash
# 查看日志
docker compose logs -f api-server

# Node.js inspector
cd api-server && node --inspect server.js
# 浏览器打开 chrome://inspect
```

### Frontend

```bash
# Dev 模式（浏览器控制台）
cd frontend && npm run dev

# 检查 build 产物
cd frontend && npm run build && ls dist/
```

### 常见问题

| 问题 | 解决方案 |
|------|----------|
| `port already in use` | 修改 `FRONTEND_PORT`、`API_PORT`、`AGENT_PORT`，或 `SANDBOX_MCP_HOST_PORT`（Sandbox 本身不映射宿主端口） |
| MySQL 连接失败 / `Can't connect` | 确认 `mysql` 服务 healthy；检查 `AGENT_DATABASE_URL` / `SANDBOX_DATABASE_URL` 与 `MYSQL_*` 一致；勿在日志中打印完整 DSN |
| Redis 连接失败 / `NOAUTH` | 确认 `redis` 服务 healthy 与 `REDIS_PASSWORD`；检查 `AGENT_REDIS_URL` / `REDIS_URL` 与密码一致；勿在日志中打印完整 URL |
| `Connection refused` 访问 Sandbox | 先确认 liveness: `docker compose exec sandbox curl -fsS localhost:8081/health`，再确认 readiness: `docker compose exec sandbox curl -fsS localhost:8081/ready` |
| `/ready` 返回 503 | 检查 `SANDBOX_WORKSPACES_ROOT` 可写与 MySQL（`SANDBOX_DATABASE_URL`）可达；日志仅有 warning，不含连接串 |
| SSE 流中断 | 检查 API Server 和 Sandbox 日志；确认客户端 abort 后执行已取消 |

## 安全治理（SDK Extension + Sandbox 双重强制）

开发时默认开启人审：

```bash
# 全局默认：高风险工具暂停，等待人工决定
APPROVAL_MODE=ask
```

- **Agent 层**：`agent/src/extensions` 固定装配 sandbox、审批、审计和交互能力；用户级 `skill-lifecycle` 的所有变更工具也进入同一 MySQL durable approval ledger。普通 Workspace 工具默认不审批。
- **Sandbox 层**：`policy_checker` 与 `/internal/v1/*` execution handlers 独立执行路径、owner、HMAC claim 和 hard-deny；普通 workspace bash/python/node 不进入审批。
- **审批模式**：`ask`（默认）创建 durable approval 并暂停；`deny` 明确拒绝
  `approval_required` 且不创建审批；`auto_approve` 仅用于明确受控的研发旁路并写
  bypass 审计，生产配置拒绝该模式。旧 `APPROVAL_ENABLED=true|false` 分别映射到
  `ask|deny`。所有模式都保留 hard_deny（如 `sudo`、`rm -rf /`）。
- **定向测试**：

```bash
cd agent && node --test tests/pi/enterprise-policy-layers.unit.test.js tests/pi/enterprise-policy-fail-closed.unit.test.js
uv run pytest tests/test_policy_checker.py tests/test_approval.py tests/test_policy_approval.py -q
```

详见 [architecture.md](./architecture.md)「双重强制」一节。
