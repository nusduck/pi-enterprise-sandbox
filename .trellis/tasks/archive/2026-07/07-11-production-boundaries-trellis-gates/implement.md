# 执行计划：R1-R8 全量迭代

## 拆分原则

建议在用户批准后创建 8 个子任务，分别拥有 R1-R8 验收；父任务只负责依赖、停机切换和最终集成门禁。任何子任务不得单独宣称生产就绪。

## 实施顺序

### Phase 0 — R4 Trellis 门禁先行

- [x] 实现 completion/deferred/validation evidence schema 与 validator。
- [x] archive、parent progress、journal generator 接入门禁。
- [x] 增加未勾选 AC、placeholder manifest、paused task、缺验证、合法 deferred 的回归测试。
- [x] 用新门禁管理后续 R1-R8 子任务。

### Phase 1 — R1 清库与 PostgreSQL 新基线

- [x] 定义 `DEPLOYMENT_ENV`、reset preflight、精确确认和清理清单。
- [x] 删除旧数据迁移目标，建立空 PostgreSQL v1 schema 与 `schema_migrations`。
- [x] 保留 SQLite 空库开发/测试路径。
- [x] 测试错误环境、错误路径、重复初始化和 migration checksum/事务失败。

### Phase 2 — R2 相对 Workspace 与 R8 零 Skill 基线

- [x] 引入 opaque `workspace_id`，物理 root 只存在内部 WorkspaceRef。
- [x] 删除 `/home/sandbox/workspace`、`workspace_path`、`_physical_workspace` 公共契约和兼容解析。
- [x] 所有工具仅接受相对路径；增加绝对路径、escape、symlink/hardlink 和脱敏测试。
- [x] 清空所有 Skill package，验证 Agent/loader/基础工具在零 Skill 下运行。
- [x] 更新 Agent/BFF/Frontend/Sandbox/fixture 的同批破坏性协议变更。

### Phase 3 — R3 Agent Event 原子序列

- [x] PostgreSQL `next_sequence` 原子分配 + event_id 幂等。
- [x] SQLite 单机事务和有界 retry。
- [x] 100 路并发、after=N resume、取消/完成单终态和 append failure 可观察测试。

### Phase 4 — R5 留存、Legal Hold 与 Trace 授权

- [x] 接入 24h/90d/180d hard-delete jobs、dry-run、批次、重试、metrics 和单执行者租约。
- [x] 统一 Legal Hold 删除防线和 orphan repair。
- [x] Trace repository/router 按 actor/org/resource 过滤，跨边界统一 404。
- [x] 使用可控时钟覆盖每类保留/删除和失败重试。

### Phase 5 — R6 生产安全默认值

- [x] 建立四服务 env catalog/schema、类型/范围/组合 validator 和自动生成配置文档。
- [x] 清除运行相关硬编码和 Compose 重复默认值；实现 env → env_file → safe default 优先级及 `*_FILE` secret/prompt 读取。
- [x] 收敛 `SANDBOX_NETWORK_MODE`，确保命令策略与 iptables 同源；development unrestricted、production 禁止 unrestricted。
- [x] 参数化 Agent provider/model/context/max tokens/compat、Skill/approval，以及 Sandbox/BFF/Compose 的部署相关配置；system prompt 实现 Env 产品层 + 不可覆盖平台安全层。
- [x] 更新现有 `.env` 为研发 profile：Skill Agent RW/Sandbox RO、Skill development、Sandbox 外网、自定义 system prompt；`.env.example` 保持完整无 secret。
- [x] 增加脱敏 effective-config 和 unknown env 检查，禁止输出 secret/prompt/DSN。
- [x] Production config validator 覆盖 token、auth、JWT、issuer/audience、CORS、MCP 和端口。
- [x] 禁止 public register，增加管理员预置/邀请流程。
- [x] 清除 secret fallback 和开发示例值；验证 acting header 信任边界。
- [x] Compose production negative/positive matrix。

### Phase 6 — R7 CI 与跨服务 Smoke

- [x] 全部 Node runtime/CI 统一 Node 22。
- [x] BFF/Agent import/listen smoke。
- [x] Deterministic fake provider 与 production 禁用保护。
- [x] PostgreSQL、相对路径、事件并发、生产预检和完整四服务 E2E 进入 CI。
- [x] 覆盖对话、SSE、工具、审批、附件、取消、Artifact 和重启恢复。

### Phase 7 — R8 文档、停机演练与父级验收

- [x] 更新全部活跃 docs、ADR、`.env.example`、Trellis specs；历史资料标记 superseded。
- [x] 执行一次完整停机 reset/redeploy/smoke 演练。
- [x] 按 PRD Acceptance Criteria 逐条附证据，不以子任务状态代替父级验收。
- [x] 运行 Trellis finish；不完整项只能走有批准记录的 deferred 流程。

## 权威验证

```bash
uv run pytest tests/ -q --tb=short
npm test --prefix api-server
npm test --prefix agent
npm test --prefix frontend
npm run build --prefix frontend
docker compose config -q
docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q
```

新增门禁还必须提供稳定入口：

```text
trellis completion/deferred unit suite
development reset preflight + empty PostgreSQL bootstrap
PostgreSQL 100-way event concurrency contract
relative workspace + zero-Skill contract
retention/Legal-Hold/trace-auth clock suite
production config negative matrix
env catalog/type/precedence/unknown/redaction/profile matrix
no-real-key four-service smoke
physical-path and stale-topology repository scan
```

## 高风险文件/区域

- `.trellis/scripts/common/task_store.py`、`.trellis/scripts/add_session.py`、task status/progress helpers。
- `sandbox/database.py`、`sandbox/repositories.py`、retention/trace/auth services。
- `sandbox/paths.py`、session/workspace/file/artifact/MCP routers and models。
- `agent/chat-runner.js`、BFF session/file routes、Frontend API/state fixtures。
- Compose、Dockerfiles、CI workflow、active docs/specs、`skills/`。

## 开始实现前门槛

- [x] 用户完成最终 PRD/design/implement 评审并明确批准。
- [x] 创建并链接 R1-R8 子任务，逐个填充真实 `implement.jsonl`/`check.jsonl`。
- [x] 记录 reset 目标清单；确认只针对研发环境且无需备份。
- [x] 不执行 reset、不删除 Skill、不修改代码，直到对应子任务进入 implementation。
