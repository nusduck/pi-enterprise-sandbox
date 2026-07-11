# 下一迭代：生产边界闭环与可升级性

**状态：** 建议进入规划，尚未开始实现  
**审查基线：** `main` 的 `e6dfa407`；未纳入工作区中未提交的 `api-server/routes/chat.js` 改动  
**需求基线：** `.trellis/tasks/archive/2026-07/` 下已归档 PRD，优先采用后续确认的目标拓扑：`Frontend → BFF → 独立 Node Agent → Python Sandbox`。

## 结论

上一轮已完成核心拆分、归属、工具策略、附件和前端韧性建设，自动化质量门禁在当前基线上通过。但有四项生产承诺仍未闭环：旧库升级、逻辑工作区隔离、数据留存、以及多用户下的追踪访问控制。下一迭代应先关闭这些边界，再投入新的产品能力。

历史 `07-11-python-agent-production-cutover` 与父 PRD 中的“Python-first”表述已经被后续 `07-11-independent-node-agent-runtime`、README 和 ADR 否定；本迭代不得重新引入 Python Agent 或双 Runtime 开关。

## 审查证据

| 验证项 | 结果 |
|---|---|
| Python | `uv run pytest tests/ -q --tb=short`：316 passed |
| BFF | `node --test api-server/tests/*.test.js`：21 passed；语法检查通过 |
| Agent | `node --test agent/tests/*.test.js agent/tests/sdk-compat/*.test.js`：102 passed；语法检查通过 |
| Frontend | `npm test --prefix frontend`：51 passed；`npm run build --prefix frontend` 通过 |
| Compose | `docker compose config -q` 通过 |
| 旧 SQLite 升级复现 | 失败：旧 `conversations` 表缺少 `owner_user_id` 时，`Database.initialize()` 在 schema 创建索引阶段报 `sqlite3.OperationalError: no such column: owner_user_id` |
| 逻辑路径复现 | 临时工作区中 `bash -c pwd` 和 Python `os.getcwd()` 都返回物理目录；与逻辑根 `/home/sandbox/workspace` 不一致 |

## 本迭代范围

### P0 — 数据库升级必须可执行、可回滚

**问题。** `sandbox/database.py` 的 `SQLITE_SCHEMA` 会在旧 `conversations` 表尚未补齐 `owner_user_id` / `organization_id` 前创建相关索引；后置的 `migrate_ownership_schema()` 无法执行。升级已部署的旧 SQLite 数据库会阻断 Sandbox 启动。

**交付。**

- 引入有版本号、幂等、可观察的 schema migration 流程，不再依赖启动期间隐式的混合建表/ALTER 顺序。
- 将“新增列 → 数据回填 → 索引/约束”作为可重复的 expand migration；为 SQLite 和 PostgreSQL 建立同一迁移契约。
- 在迁移前执行备份/空间检查，记录 migration ID、执行时间和结果；失败时保持原库可恢复。
- 提供旧版本数据库 fixture，覆盖启动升级、重复执行、失败恢复和 SQLite/PostgreSQL 一致性。

**验收。** 任一受支持历史 schema 可启动并升级；重复启动不改变业务数据；故意注入迁移失败后可从备份恢复；CI 至少运行 SQLite 的升级矩阵，并在服务容器中运行 PostgreSQL 合同测试。

### P0 — 兑现唯一逻辑工作区契约

**问题。** API 的 `SessionResponse.metadata` 仍公开 `_physical_workspace`，`docs/api.md` 也把物理根作为公开契约；更关键的是 `ExecutionManager` 以物理目录作 `cwd`。`safe_env.py` 只设置 `PWD`，其注释明确说明 `os.getcwd()` 仍会暴露物理路径。此行为不满足“Bash/Python/Node/文件/Artifact/MCP 均只观察逻辑路径”的已归档 PRD。

**交付。**

- 从所有外部响应、SSE、模型上下文、审计摘要与活跃文档移除 `_physical_workspace` 和物理根；内部存储改为私有字段或仅由 service 层解析。
- 选定并实现真正的每执行环境路径映射方案（例如每 Session 隔离运行容器，或经安全评审的 mount namespace runner）；不得恢复全局 workspace symlink。
- 保持 Conversation workspace 持久化、重绑与单写租约；为 Bash、Python、Node、MCP、文件、Artifact 和错误路径加入实际运行级断言。
- 增加全仓物理路径泄露扫描，覆盖 API body、SSE fixture、日志与文档；扫描命中仅允许内部部署说明中的显式、非 API 示例。

**验收。** 三种运行时的 `pwd` / `os.getcwd()` / `process.cwd()` 都返回 `/home/sandbox/workspace`；并发 conversation 不串目录；外部响应和普通日志不含 `/var/sandbox/workspaces`；session 重绑后文件仍完整。

### P1 — 留存、审计与追踪授权闭环

**问题。** lifespan 清理循环只调用 `session_manager.cleanup_expired()`；`cleanup_expired_drafts()` 没有被生产循环调用，`cleanup_expired_audit_stub()` 明确是 no-op，90 天 Conversation 与 180 天 audit/event 留存配置实际上未生效。`GET /traces/{trace_id}` 也没有归属校验；在启用认证时，持有服务令牌的调用方可以读取任意可猜测/泄露的 trace。

**交付。**

- 将 draft、Conversation、agent event、audit log 的留存任务纳入受监控的后台作业；legal hold 必须在所有删除路径生效。
- 建立 orphan run / workspace / attachment 的修复策略和 dry-run 报告，定义多副本下的单执行者/租约。
- 让 trace 查询按 actor、organization 和关联资源做授权；默认仅返回调用者可见的数据，管理员权限仅限同组织。
- 明确保留、删除、legal hold、审计导出与失败重试的运维 runbook。

**验收。** 使用可控时钟的测试证明各 TTL 实际删除或保留数据；legal hold 无法被清理；跨用户和跨组织 trace 查询返回不泄露存在性的 404；清理作业可重试且有指标/审计记录。

### P1 — 生产部署安全默认值

**问题。** 开发 Compose 默认公开 Agent 端口，`AGENT_INTERNAL_TOKEN`、`SANDBOX_API_TOKEN`、JWT auth 均可为空；生产 overlay 没有 fail-fast 检查。Sandbox CORS 同时配置 `allow_origins=["*"]` 和 credentials，缺少生产来源白名单。这些选择适合本地开发，但不应被误用为生产配置。

**交付。**

- 分离 development 与 production 配置；生产启动时强制内部 Agent token、Sandbox service token、JWT/外部身份配置、非空 MCP token（如 MCP 对外开放）和显式 CORS origin allowlist。
- 在生产 Compose 中保持 Agent/Sandbox HTTP 为内部网络；增加配置预检，禁止空密钥、开发默认值和不安全端口暴露。
- 将用户身份验证、服务身份验证、acting headers 与 trace 归属的边界写成端到端契约测试。

**验收。** 缺任何必需生产安全配置即启动失败；浏览器跨源与伪造 acting header 均被拒绝；BFF 能正常代表有效用户访问 Agent/Sandbox；Agent 不能从宿主或非授权容器直接调用。

### P2 — 文档、CI 与可演练交付

**问题。** 活跃文档和 Trellis spec 仍有多处已删除 Python Agent/旧 BFF 文件路径、`agent_runtime: node | python`、物理 workspace API 示例；CI 使用 Node 20，而项目架构声称 Node 22，且未声明唯一受支持版本。当前自动化主要为单元/集成测试，关键的升级、路径映射和完整 BFF→Agent→Sandbox 流仍缺少可重复演练。

**交付。**

- 以独立 Node Agent 拓扑为唯一当前事实，修正 README、API、部署、ADR 和 `.trellis/spec/`；归档资料保留历史标记，不作为实现规范。
- 将 CI Node 版本与 Dockerfile/SDK 支持范围统一并显式锁定；增加 lint/type/coverage 的决策记录，而非把建议误称为门禁。
- 加入不依赖真实 LLM 密钥的端到端 smoke（fake provider 或协议 fixture），覆盖登录、对话、SSE 重连、审批、附件、取消、Artifact、重启恢复和数据库升级。

**验收。** 活跃文档不存在已删除 runtime/文件的“当前实现”描述；CI 与运行镜像使用同一 Node 主版本；每次合并可运行一条无真实密钥的跨服务 smoke；生产部署前的配置/迁移/回滚演练有可审计证据。

## 执行顺序与切分

1. **数据库迁移与备份恢复**（P0）：先保护已有数据，产出历史库 fixtures 和回滚 runbook。
2. **工作区真实映射与泄露清理**（P0）：这是容器权限/运行模型决策，完成设计评审后实施。
3. **留存与 trace 授权**（P1）：依赖 1 的稳定 schema；可与 2 的实现阶段并行。
4. **生产安全配置**（P1）：依赖已确定的路径运行模型和认证契约。
5. **文档、CI、全链路演练**（P2）：最后作为跨层验收，阻断遗留漂移重新进入主分支。

建议将以上五项分别建立 Trellis 子任务；父任务只保存本文件、跨任务验收标准和发布/回滚决策。

## 非目标

- 不重建或恢复 Python Agent runtime，也不维护 Node/Python 双路由。
- 不新增复杂 RBAC、SSO/SCIM 或资源共享产品能力；本轮只落实既有 `user/admin + organization` 的授权边界。
- 不扩展新的模型、SDK fork、npm/OCI Skill 来源或 RAR/7z 附件支持。

## 发布门槛

在完成前不得宣称“生产就绪”。发布需要：P0 全部验收、P1 安全/留存测试通过、升级与回滚演练通过、完整 CI + compose 校验通过，并由维护者确认生产环境变量和存储拓扑。
