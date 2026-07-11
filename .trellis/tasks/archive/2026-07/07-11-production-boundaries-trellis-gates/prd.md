# 下一轮生产边界闭环与 Trellis 验收强化

## Goal

把当前“核心能力可运行”推进到“生产边界可验证、任务完成状态可信”。下一轮同时关闭会阻断升级/隔离/审计的运行时缺口，并强化 Trellis 的验收、归档与 journal 证据门槛，避免再次把部分完成或未记录验证的任务标为 `completed`。

## Background and Confirmed Facts

- 当前唯一目标拓扑是 `Frontend → Node BFF → Node Agent → Python Sandbox`；Python Agent 已删除，不恢复双 Runtime。
- 2026-07-11 共归档 17 个 Trellis task，全部标为 `completed`，但历史记录仍有 72 个未勾选 PRD 验收项、11 个未勾选 implementation 项、7 个空/示例 `check.jsonl`，三个 journal 均曾写入 `Validation was not recorded`。
- `.trellis/scripts/common/task_store.py:435-520` 的 archive 流程直接将状态改为 `completed`，没有检查 PRD checkbox、placeholder context、验证证据或 `blocked/paused` notes。
- `sandbox/database.py:408-419` 在旧 ownership 字段迁移前执行完整 `SQLITE_SCHEMA`；旧库会在新字段索引处先失败。
- `sandbox/security/safe_env.py:33-35` 明确说明真实 `os.getcwd()` 仍是物理目录；`sandbox/services/execution_manager.py:209` 以物理 workspace 为 cwd，API 文档仍公开 `_physical_workspace`。
- `sandbox/repositories.py:773-805` 使用 `MAX(sequence)+1` 后 INSERT；真实并发 Agent 运行已复现 `(run_id, sequence)` 唯一键冲突。
- `sandbox/main.py:47` 的生产清理循环只调用 session cleanup；`cleanup_expired_drafts()` 未接入，`cleanup_expired_audit_stub()` 是 no-op。
- `sandbox/routers/traces.py:13-26` 按 trace ID 直接返回 execution/audit 数据，没有按用户、组织或关联资源授权。
- 开发 Compose 允许空内部 token 并公开服务端口；生产配置缺少完整 fail-fast。`sandbox/main.py:127-128` 同时使用 wildcard CORS 和 credentials。
- CI 使用 Node 20，而 Agent/BFF Docker 基线为 Node 22；缺少无真实 LLM key 的完整跨服务 smoke。
- BFF session helper、只读 Skill 执行和网络命令 token 误判已在上一轮修复，不再作为本任务实现项，但必须进入回归矩阵。

## Requirements

### R1 — 清库切换与新迁移基线（P0）

- 本轮是破坏性大版本切换：现有 SQLite/PostgreSQL 业务数据和运行状态全部清空，不迁移历史 conversation、session、event、audit、user、workspace 或 attachment 数据。
- PostgreSQL 是全新生产基线；SQLite 只从空库用于开发/测试，不提供旧 schema 升级兼容。
- 从新基线开始建立有版本、幂等、可观察的 migration 流程，未来变更遵循新增列 → 回填 → 索引/约束。
- 提供明确列出数据库、volume、workspace 和 attachment 清理范围的 reset/preflight/runbook，避免误删范围外资源。
- 新 schema 初始化、重复启动和未来 migration 失败必须可测试；本轮不建设旧数据导出/导入工具。
- 当前为研发阶段，reset 前不创建快照、不保留回滚数据，脚本必须要求显式环境标识和二次确认以避免误对非研发环境执行。

### R2 — 相对 Workspace 契约（P0）

- Agent、Skill 和文件工具只使用相对路径；Session workspace 是隐式根，公共 API 使用 opaque `workspace_id`，不再承诺统一绝对路径。
- 外部 API、SSE、模型上下文、工具输出、普通日志和活跃文档不得泄露 `_physical_workspace`、`/var/sandbox/workspaces` 或其他内部物理根；命中时统一脱敏为 `<workspace>` 或 `.`。
- 保持 conversation workspace 持久化、session 重绑、并发隔离和单写租约。
- `/home/sandbox/workspace/...` 输入、`workspace_path` 公共字段和相关兼容解析在本版本一次性删除；不得恢复全局 symlink。
- `pwd`、`os.getcwd()`、`process.cwd()` 的物理结果不属于公共契约；同容器、同 Unix UID 无法提供恶意代码强多租户隔离，必须作为发布残余风险明确披露。

### R3 — Agent event 原子顺序与恢复（P0）

- PostgreSQL sequence 分配必须原子化；SQLite 保持单机兼容，并在唯一键冲突时有有界重试且保持严格单调。
- 并发 `token_batch/tool_start/tool_end` 不得返回 500、丢事件或产生重复 sequence。
- SSE `after=N` 恢复必须无重复、无缺口；取消/完成只能形成一个终态。

### R4 — Trellis 完成状态可信（P0）

- archive 前检查 PRD/implementation 未完成项；未完成项只能显式 deferred、关联后续 task 并记录用户批准，不能静默归档。
- `implement.jsonl` / `check.jsonl` 的 `_example`、空文件和不可解析内容必须阻断需要这些 manifest 的工作流。
- `blocked/paused` task、未完成 parent integration gate、缺少用户批准证据的规划 task 不得变为 `completed`。
- journal 必须记录 commit、验证命令、退出码和结果；不得默认生成 `Validation was not recorded` 后仍标记完成。
- archive/check 行为需要独立单元测试，且 Trellis update 后可检测本地规则是否被覆盖。
- 允许带证据的明确延期：每项必须记录原因、风险、后续 task 和用户批准；状态使用 `completed_with_deferred`，父任务进度分别统计完成与延期。
- 不提供无记录的 `--force` 绕过。

### R5 — 留存、Legal Hold 与 Trace 授权（P1）

- draft、conversation、agent event 和 audit retention 全部进入受监控后台作业，支持 dry-run、重试、指标和审计。
- Legal Hold 在所有删除路径上统一生效；orphan run/workspace/attachment 有修复策略。
- trace 查询必须按 actor、organization 和关联资源授权；跨用户/跨组织统一返回不泄露存在性的 404。
- 留存到期直接硬删除：空白 draft 24h、conversation/workspace/attachment 90d 无活动、agent event/execution audit 180d；不增加软删除、回收站或归档层。
- 清理先支持 dry-run；生产删除记录范围、数量、耗时和失败，但不得复制已删除敏感正文，恢复依赖既有备份窗口。

### R6 — 生产安全默认值（P1）

- production 启动必须校验非空 Agent/Sandbox service token、用户认证配置、显式 CORS allowlist，以及 MCP 对外开放时的 token。
- 保留内置用户库和 HS256 JWT；production 禁止公开自注册，只允许管理员预置/邀请用户，并强制独立高熵 JWT secret 及 issuer/audience/expiry 校验。
- Agent/Sandbox HTTP 在 production 仅位于内部网络；禁止开发默认值、空 secret 和非预期宿主端口。
- acting headers 只能由可信 BFF 生成，浏览器伪造必须被剥离或拒绝。
- 建立统一、类型化的环境变量配置面：所有部署相关参数必须通过 env/`*_FILE` 配置并集中校验，禁止路由、runner 或工具中散落运行时常量。
- 配置优先级固定为显式进程 env → `env_file` → 安全代码默认值；未知/拼错变量在 development 告警、production 启动失败。
- `.env.example` 保存无 secret 的完整配置目录；现有 `.env` 更新为可直接启动的研发配置，并明确：`DEPLOYMENT_ENV=development`、Skill development + Agent RW/Sandbox RO 挂载、Sandbox unrestricted outbound、开发认证/审批、模型和 system prompt 配置。
- 网络配置收敛为单一 `SANDBOX_NETWORK_MODE=disabled|allowlist|unrestricted`，同时驱动命令策略和 iptables，避免两个层级状态不一致；production 禁止 `unrestricted`，研发 `.env` 使用 `unrestricted`。
- Agent 可配置 provider/base URL/model、context window、max tokens、常用 compat、approval、Skill mode/root/audit、system prompt；Sandbox 可配置资源/配额/TTL/retention/network/CORS/auth/MCP/database/log；BFF/Frontend/Compose 可配置端口、下游 URL、认证和镜像/挂载。
- System prompt 采用分层合成：Env/`*_FILE` 完全控制产品、角色、语言和业务规则层；平台安全、工具、路径、Skill 写保护、Artifact-only 和 secret 处理层不可被配置覆盖。
- 提供脱敏的 effective-config 检查/启动日志，显示来源和非敏感最终值，不输出 token、secret、完整 prompt 或连接凭据。
- 算法常量和不可审批 hard-deny 等安全不变量不属于“可参数化”范围，不能通过 env 关闭。

### R7 — CI、启动与跨服务演练（P1）

- Node CI 与 Docker 镜像统一到一个明确支持的主版本。
- 增加 BFF/Agent 模块启动与 import smoke，避免包级单测通过但服务无法启动。
- 增加不依赖真实 LLM key 的 `BFF → Agent → Sandbox` smoke provider/fixture，覆盖对话、SSE、工具、审批、附件、取消、Artifact 和重启恢复。
- 空 PostgreSQL 初始化、相对 workspace、事件并发、生产配置预检必须成为合并门禁。

### R8 — 文档与规格单一事实源（P2）

- README、API、部署、ADR 和 `.trellis/spec/` 只描述独立 Node Agent 当前拓扑。
- 历史归档允许保留旧方案，但必须标明 superseded/deferred，不能作为当前实现规范。
- 每个发布门槛都要能链接到自动化结果或演练记录。
- 删除 `skills/` 下全部现有 Skill package；保留 Skill loader/管理框架，并验证零 Skill 状态下 Agent 可正常启动、对话和使用基础工具。
- 文档不得继续宣称存在任何内置 Skill；未来 Skill 必须通过新的研发/安装流程重新引入。

## Acceptance Criteria

- [x] reset 演练清空所有明确在范围内的旧数据库与 workspace/attachment 状态且不影响范围外资源；全新 PostgreSQL schema 可重复初始化，未来 migration 基线可工作。
- [x] Agent/Skill/工具全链路只需相对路径即可完成文件与 Artifact 流；公共响应使用 opaque `workspace_id`，外部物理路径泄露扫描为零。
- [x] PostgreSQL 至少 100 路同一 run 并发事件 append 无 500、无重复/缺失 sequence；SQLite 单机兼容合同通过。
- [x] Trellis archive 对未勾选 AC、placeholder manifest、paused status 和缺少验证记录分别有失败测试。
- [x] Deferred 项必须包含原因、风险、后续 task 和批准证据，父任务进度不会因此虚假显示 100%。
- [x] 可控时钟测试证明各 TTL 删除/保留行为正确，Legal Hold 不可被任何清理路径绕过。
- [x] 跨用户/跨组织 trace 查询返回 404，同组织授权查询只返回允许的数据。
- [x] 缺任一生产必需 secret/CORS/身份配置时服务启动失败；production 不发布 Agent/Sandbox 端口。
- [x] 配置契约测试覆盖完整 env catalog、类型/范围、优先级、未知变量、`*_FILE`、脱敏和 development/production 矩阵；研发 `.env` 能启用 Skill 编辑、Sandbox 外网和自定义 system prompt，production 对这些不安全组合 fail-fast。
- [x] CI 与运行镜像 Node 主版本一致，且无真实 LLM key 的跨服务 smoke 在干净环境通过。
- [x] 活跃文档不存在 Python Agent、双 Runtime 或物理 workspace 的当前契约表述。
- [x] `skills/` 不包含任何 Skill package，Agent 在零 Skill 状态下启动、对话和基础工具 smoke 通过。
- [x] 完整回归、不可逆 reset/redeploy 演练和 Trellis finish 证据均附在 task research/journal 中。

## Out of Scope

- 新产品功能、模型切换、复杂 RBAC、SSO/SCIM、资源共享。
- 恢复 Python Agent 或 Node/Python 双运行时。
- 提交或恢复此前删除的数据库分析实验 Compose、Skill、种子数据或生成产物。
- 在未完成安全设计评审前直接授予 Sandbox 更宽的容器/宿主权限。
- 新增 execution runner、worker pool、容器运行时管理或动态调度服务。
- 旧数据库 schema/data 迁移、旧 workspace 路径兼容和旧 Skill 保留。

## Release Constraints

- R1–R8 全部属于同一轮发布阻断；可以拆成子任务，但任何一项未验收时不得宣称生产就绪。
- 切换采用停机流程：停止四服务 → 不可逆 reset → 部署完整新版本 → 空 PostgreSQL 初始化 → 全门禁 smoke → 恢复访问。
- 不建设双写、滚动升级、混合版本兼容或旧数据恢复路径；失败时保持服务停止，修复后重新从空环境部署。
