# 技术设计：生产边界闭环与可信验收

## 总体策略

维持现有四服务拓扑：

```text
Frontend → Node BFF → Node Agent → Python Sandbox → PostgreSQL
```

本轮是研发阶段的破坏性大版本。部署采用停机式全量切换，不维护旧数据库、旧 workspace API、旧 Skill 或混合版本兼容。Sandbox 继续在单容器内执行受控子进程；不新增 runner，不申请 Docker/Kubernetes/namespace 高权限。

## R1：清库、PostgreSQL 基线与未来 Migration

新增明确的 deployment environment 标识。reset 只允许在 `development` 且收到精确确认串时执行，列出并清理项目拥有的数据库/volume、workspace 和 attachment；拒绝模糊路径、空根目录和 production 标识。

生产 schema 以 PostgreSQL 空库为 v1 基线，使用 `schema_migrations(version, checksum, applied_at)` 记录未来 migration。Migration 在事务中执行；DDL/回填/索引分阶段、校验 checksum、重复执行无副作用。SQLite 只验证空库开发路径，不承担旧 schema upgrade。

## R2：相对 Workspace 契约

公共标识从路径改为 opaque `workspace_id`。所有 Agent/Skill/tool path 必须相对 Session 根；绝对路径一律拒绝。内部引入仅 service/repository 可见的 `WorkspaceRef { workspace_id, physical_root }`，router/model/SSE 不序列化 `physical_root`。

删除：

- `AGENT_WORKSPACE_PATH` 公共语义；
- `/home/sandbox/workspace/...` 特殊解析；
- `workspace_path` API/SSE 字段；
- `_physical_workspace` metadata 对外返回；
- 文档、fixture 和 Skill 中的固定 workspace 绝对路径。

命令输出、异常和审计摘要统一通过 path sanitizer，把已知 workspace root 替换为 `<workspace>`。真实 cwd 仍是内部物理目录，不作为公共契约。同 Unix UID 的恶意代码隔离限制写入 residual risk。

## R3：事件原子顺序

PostgreSQL 在 `agent_runs` 保存 `next_sequence`，单事务执行 `UPDATE ... SET next_sequence = next_sequence + 1 RETURNING next_sequence` 后 INSERT event；`event_id` 唯一用于幂等。SQLite 使用 `BEGIN IMMEDIATE` 或等价写事务，并对 busy/unique conflict 做短、有界重试。

恢复接口继续使用 `after=N`，测试严格单调、无重复/缺口、取消/完成单终态。Event append 失败不得被静默日志吞掉；Run 必须得到可观察的 degraded/failed 状态。

## R4：Trellis 可信完成状态

在 archive 前执行统一 completion validator：

1. 解析 PRD/implement checkbox；
2. 校验 manifest 非空、非 `_example`、JSONL 可解析；
3. 拒绝 planning/blocked/paused 状态；
4. 要求 validation evidence 包含命令、commit、exit code、结果；
5. Parent 必须完成 integration AC；
6. 未完成项只能匹配结构化 deferred 记录。

Deferred 记录至少包含 `acceptance_id/reason/risk/followup_task/approved_by/approved_at`，状态写 `completed_with_deferred`。Journal generator 不再默认把“未记录验证”与 Completed 组合。增加仓库外层回归测试，Trellis update 覆盖本地脚本时 CI 会失败。

## R5：Retention、Legal Hold 与 Trace Auth

由 PostgreSQL 租约保证清理作业单执行者。作业按依赖顺序处理 draft → conversation/attachment/workspace → agent events/executions → audit，并支持 dry-run、分页、有界批次、重试和 metrics。Legal Hold 查询必须位于所有删除入口的共同 repository/service 层。

Trace 查询先解析 Actor，再通过关联 Session/Conversation 的 owner/org 过滤 execution/audit；跨用户/跨组织返回相同 404。管理员只可访问同组织。

## R6：生产配置与内置认证

增加明确 `DEPLOYMENT_ENV=development|production`。Production validator 在服务监听前检查：

- Agent/Sandbox service token 非空且不是示例值；
- auth 必须开启；
- JWT secret 独立、高熵，issuer/audience 非空；
- CORS origin 显式且不能为 `*`；
- MCP 对外开放时 token 非空；
- Agent/Sandbox 无宿主端口映射。

Production 禁用 public register；提供管理员预置/邀请入口。继续 HS256，不增加 OIDC/JWKS/key ring。BFF 仅转发 Bearer，继续剥离浏览器 `X-Acting-*`。

### 统一环境变量配置面

每个服务保留一个配置 schema，Compose 只负责传递，不在多处复制默认值。新增可生成的 config catalog（变量、类型、默认值、范围、是否 secret、适用环境、是否支持 `*_FILE`）。生产启动先验证配置，再监听端口。

建议配置组：

- `DEPLOYMENT_ENV` 与服务端口、URL、镜像、volume/mount；
- Agent provider/model/base URL/context/max tokens/compat、approval、Skill mode/root/audit；
- `AGENT_SYSTEM_PROMPT` / `AGENT_SYSTEM_PROMPT_FILE`；
- Sandbox execution resource、quota、timeout、TTL/retention、database、CORS/auth/MCP/log；
- `SANDBOX_NETWORK_MODE=disabled|allowlist|unrestricted`，allowlist 模式再读取 CIDR/port；
- BFF auth/downstream/trace/upload；Frontend 构建时公开配置只允许非 secret 白名单。

研发 `.env` 明确采用 development profile：Agent Skill mount RW、Sandbox Skill mount RO、Skill tools 开启、Sandbox 出网 unrestricted、研发认证/审批和 system prompt 可配置。Production profile 禁止 unrestricted network、Skill RW/development、fake provider、空 secret、wildcard CORS。

System prompt 固定分层：`AGENT_SYSTEM_PROMPT` / `AGENT_SYSTEM_PROMPT_FILE` 完全控制产品角色、语言和业务规则层；平台层强制追加安全、工具、相对路径、Skill 写保护、Artifact-only 和 secret 处理指令，不提供关闭/替换开关。Hard-deny、路径边界和 Artifact-only 仍由代码强制，不能只依赖 prompt。

## R7：CI 与无密钥 E2E

Node BFF、Agent、Frontend、Sandbox 内 Node runtime 和 CI 统一 Node 22。新增：

- BFF/Agent import + listen smoke；
- 空 PostgreSQL schema/migration contract；
- 100 路 event append 并发；
- relative workspace/file/artifact contract；
- production config negative matrix；
- deterministic fake OpenAI-compatible provider，由测试进程启动，production 配置明确拒绝 fake endpoint/mode；
- 完整 BFF → Agent → Sandbox smoke，覆盖 SSE、工具、审批、附件、取消、Artifact、服务重启恢复。

## R8：零 Skill 与单一事实源

删除 `skills/` 下所有 package，保留目录/loader/manager。Loader 对空目录返回零 Skill 而非失败；Agent 基础 tool allowlist 不依赖 Skill。Development install/edit/reload 继续可用，但初始发行不带内置 Skill。

更新 README、API、architecture、deployment、development、ADR、`.env.example` 和 `.trellis/spec/`。归档文档保留历史但标记 superseded。

## 停机切换顺序

1. 阻止新请求并停止四服务。
2. Preflight 确认 development、项目标识和清理清单。
3. 不可逆清理数据库、volume、workspace、attachment 和 Skill package。
4. 部署完整新版本并初始化空 PostgreSQL。
5. 创建管理员用户，验证生产配置负向/正向矩阵。
6. 运行零 Skill、相对路径、事件并发、retention/trace、跨服务 smoke。
7. 父级 R1-R8 验收全部通过后恢复访问。

任一步失败时保持服务停止，修复后重新从空环境执行；不恢复旧数据。

## 主要风险

- Reset 不可逆：仅允许 development + 精确确认，打印清单并限制路径。
- API 破坏性：全仓调用方同批升级，不允许混合版本。
- 单容器执行不是恶意代码强多租户隔离：明确残余风险，不扩大宣传。
- Trellis 本地脚本可能被 update 覆盖：外层回归测试必须阻断漂移。
- Env 变量过多或互相矛盾：使用单一 schema、组合验证、生成文档和 effective-config 脱敏输出，不允许 Compose/代码重复默认值漂移。
