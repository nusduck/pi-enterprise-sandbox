# 一线问题与架构演进需求厘清

## Goal

以 `docs/field-issues-and-evolution-requirements.md` 为需求底稿，将 F-01、A-01、A-02、A-03、S-01、S-02、S-03、T-01、R-01 一次性规划为可独立实施、验证和回滚的 Trellis 任务；本父任务只负责路线图与集成验收，不授权实现。

## Confirmed Repository Facts

- 当前生产 Agent 编排内嵌于 `api-server/routes/chat.js`，使用 `@earendil-works/pi-coding-agent@^0.80.3`；该 SDK 是 MIT、Node >=22.19 ESM 包，无 Python SDK 入口。
- `sandbox/agent/` 是自研 OpenAI-compatible Python loop，从未启用或承载生产流量，可直接移除。
- 当前上传在 `frontend/src/main.js:480-507` 成功后自动发送；BFF `readBodyBuffer()` 与 Sandbox chunks list 均完整缓冲文件；同名文件会覆盖。
- 当前代码声明 `/home/sandbox/workspace`，但仍存在全局 workspace link、物理 workspace API/日志和 `_physical_workspace` 依赖。
- SDK Extension 支持 fail-safe `tool_call`、`tool_result`、Session hooks/custom entries；SDK SessionManager 只提供内存或本地 JSONL 持久化，无 PostgreSQL adapter。
- SDK 自带 ls/find/grep，但 SDK 本身不是安全 Sandbox；生产必须覆盖为远程 Sandbox 工具。

## Requirements and Decisions

### Scope and Topology

- 全部 9 项均纳入本轮并规划到实施就绪；另重新启用 `07-11-user-ownership-auth` 作为独立前置任务。
- 目标拓扑：`Frontend → Node BFF → 独立 Node Agent Service → Python Sandbox`。
- Agent 继续直接使用官方 Node SDK，不做全 Python、不开发 binding、不 fork/完整复刻。
- API Server 为薄 BFF；Agent 负责 SDK/Run/Session/Extension/Skill/tool；Sandbox 只负责受控执行。

### Identity, Persistence and Storage

- 第一阶段可信身份含 `user_id`、预留 `organization_id`、`user/admin` 两角色；所有资源具有可验证归属。
- `conversation_id` 1:1 拥有稳定 `workspace_id` 和活动 Agent Session；Sandbox Session 可轮换重绑，同一时刻单写者。
- 生产支持多副本；PostgreSQL 是业务事件唯一事实源，Redis 仅可选协调，本地 SQLite 仅开发。
- SDK JSONL 从 PostgreSQL 已提交事件重建，本地文件仅运行缓存。
- 用户消息先提交，Assistant 增量持久化；崩溃保留 partial 并标记 interrupted，不自动续写/重放。
- 在线 workspace 使用共享 POSIX 卷；对象存储只用于归档、备份和 Artifact。
- 默认保留：草稿/空会话 24h、Conversation 90 天无活动、审计 180 天；支持 legal hold 与孤儿回收。

### Attachments

- 选择后创建/复用 Conversation/Sandbox Session并后台上传，不发送；点击发送时文本与附件 IDs 组成同一回合。
- 状态可重试/移除；同名不覆盖；重试幂等；主动重复选择不去重。
- 默认 10 个/回合、50 MB/文件、200 MB/回合、500 MB/workspace，可配置；超限 413。
- 使用扩展白名单；支持常见文本/办公/代码/图片及 `.zip/.tar/.tar.gz/.tgz/.gz`，RAR/7z 延期。
- 压缩包不自动解压；显式原子解压限制 2,000 files、500 MB 展开、50 MB 单文件并防路径逃逸。
- 回合持久化系统附件 manifest；模型按需读取，视觉模型可内联允许图片。
- 发送后取消只停止 Agent/工具，不撤回用户消息和附件。

### Paths and Execution Isolation

- 双逻辑根：`/home/sandbox/workspace`（Conversation R/W）与 `/home/sandbox/skill`（共享，生产 R/O）。
- 相对路径和 workspace 逻辑绝对路径可接受，其他绝对路径/物理路径/逃逸路径拒绝。
- 每个 Sandbox Session 使用独立执行环境/mount namespace；`pwd/os.getcwd/process.cwd` 返回逻辑路径，禁止全局 symlink。
- 执行环境随 Sandbox Session，workspace 长期保留；独立 Shell 不保存 cd/export，长任务用 execution_id 管理。

### Tools, Policy and Approval

- Extension + Sandbox 双重策略；hook 异常、策略异常 fail-closed。
- 三层策略：安全直行、风险可审批、硬边界永拒绝。
- `APPROVAL_ENABLED=true` 默认开启，生产可显式关闭；关闭后风险命令直行，硬边界仍拒绝。
- approval 开关/bypass 与所有工具调用均审计；不要求额外运行告警。
- 同 workspace 只读工具可并行，写/副作用工具串行；未知工具按写处理。
- ls/find/grep 仅访问 workspace，返回结构化、截断和统计；grep 默认 literal，显式 regex 才启用受限正则。
- 默认限制：ls 1,000/depth 5；find 500/depth 20；grep 500、context 5、file 5 MB、scan 100 MB、timeout 5s。

### Skill and Network

- `SKILLS_MODE=readonly|development` 默认只读；生产只读挂载。
- 单用户研发模式允许普通对话通过专用工具直接修改共享 Skill；后续回合/reload 生效。
- 首期来源为允许本地目录和 HTTPS Git pinned ref；记录 resolved commit，禁止 SSH/凭证 URL/任意脚本，npm/OCI 延期。
- Sandbox HTTP 默认仅本机/内部 Agent；外部 MCP 需显式 client CIDR + API Token。
- 默认忽略代理头；仅 peer 属于 trusted proxy CIDR 时解析；非法网络配置启动失败。

### SDK, Protocol and Cutover

- SDK 精确锁版本并提交 lockfile；升级使用独立任务/PR和黑盒兼容套件。
- BFF-Agent 使用内部 HTTP 创建/取消 Run，SSE event 先持久化并按 sequence 可续传。
- Python Runtime 直接移除，无迁移/灰度。
- Node Agent 拆分使用短暂停写：停止新 Run、排空/取消在途、部署/冒烟、恢复；不维护双 Runtime。

## Task Tree and Dependencies

1. `user-ownership-auth`：所有资源归属前置。
2. `pi-sdk-adoption-adr`：锁定 SDK 和兼容契约，可与 F-01 并行。
3. `file-attachment-upload`：修复一线 P0，协议保持 workspace_id/manifest 前向兼容。
4. `logical-path-workspace-isolation`：S-03/A-03/A-02/T-01 的路径与执行基础。
5. `sandbox-network-allowlist`：可与路径任务并行，A-02 上线前完成。
6. `sdk-extension-security`：依赖身份、SDK ADR、路径契约。
7. `agent-session-persistence`：依赖身份、路径、Extension 事件/执行台账。
8. `independent-node-agent-runtime`：依赖 SDK ADR、S-03、A-03、网络边界。
9. `structured-file-search-tools`：依赖 A-01/S-03，可与 Agent 拆分后段并行。
10. `development-skill-management`：依赖独立 Agent、S-03 和网络策略。

## Acceptance Criteria

- [x] 用户确认全部 9 项一次性规划到实施就绪。
- [x] 所有已决产品/风险/兼容选择已合并为唯一需求版本，无临时 brainstorm 问题。
- [x] 9 个需求任务与认证前置任务均已创建并关联父任务。
- [x] 每个子任务具备 PRD、design、implement、验证命令和回滚点。
- [ ] 用户完成最终规划评审并明确批准某个子任务后，才可 `task.py start` 并进入实现。
- [ ] 所有子任务完成后执行父级跨层集成验收、迁移演练和文档一致性检查。

## Out of Scope

- 全 Python Agent、Python SDK binding、pi-coding-agent fork/完整复刻。
- 首期复杂 RBAC/双人审批、生产动态 Skill 下载、npm/OCI Skill、多用户 Skill 协作、RAR/7z。
- 本规划任务本身不修改产品代码、不部署、不切流。

