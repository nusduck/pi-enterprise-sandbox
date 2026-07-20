# 2026-07-20 代码审查与修复报告

## 范围与结论

审查范围是当前工作区未提交的 Agent、Sandbox transport 与前端对话改动，重点覆盖对话事件流、Skill/MCP 装配、正确性、安全性、性能和回归测试。

结论：本轮已修复本地可验证的对话、Skill 读取/脚本执行约束和内部传输问题；剩余 JSONL 浮点语义与列表 N+1 为后续改进项，不阻塞本次修复提交。用户提出的“MCP 没有自动注入”不能由代码证实；现有真实适配器集成测试证明在 `AgentVersion.configJson.mcpServers` 已配置、注册表可解析时，MCP 工具会自动装入会话。

## 已确认问题

| 优先级 | 问题 | 证据 | 状态 |
| --- | --- | --- | --- |
| P0 | Skill 元数据提示与实际文件读取脱节 | `read` 工具接受 `/home/sandbox/skill/**`，但生产 transport 之前没有 `readSkill`；现有 `/internal/v1/files/read` 也明确拒绝 skill 路径。模型会收到“可读取 SKILL.md”的提示，却得到 `SKILL_READ_UNSUPPORTED`。 | **已修复**：新增独立签名路由/Scope，并复用执行账本、防符号链接与分页协议。 |
| P1 | 并发发送时 optimistic user 消息会被错误绑定到 Run | 原逻辑在 create-run 返回后标记“最后一个未绑定 user”；两个请求交错返回时，先返回的请求会标记后发送的消息，导致回复顺序反转。 | **已修复** |
| P1 | 历史消息没有 run ID 时，同文本 assistant 回复会被错误覆盖或排序 | 只按 assistant 的数组槽位合并，无法识别重复文本和交叉完成的 Run。 | **已修复** |
| P1 | toolResult 被当作 assistant 文本渲染 | Pi 可产生 `toolResult`/`tool` 的 `message.completed`，其 JSON（`stdout`、`exitCode` 等）曾污染对话气泡。 | **已修复** |
| P1 | 内部 HMAC 请求的报文头契约被破坏 | 当前改动移除了部分请求的 `Content-Length`，并改变了已有单元测试依赖的 `Authorization` 头键；4 个 transport 回归测试失败。 | **已修复** |
| P1 | AgentVersion 空系统提示会落入不适合企业 sandbox 的默认提示 | SDK 默认提示会指向产品/安装目录；运行时没有稳定地指向逻辑 workspace/skill 根。 | **部分修复**：企业提示和 Skill 元数据加载路径已接入；正文读取仍受 P0 阻塞。 |

### 对话修复说明

- `ChatContext` 为本地 user turn 生成 `_messageId`，只给该消息绑定 create-run 返回的 Run ID，消除了异步回包竞争。
- `conversationMessages` 仅在历史严格为“每个 Run 一条 user + 一条 assistant、且未带 run ID”时按顺序恢复关联；混合或不完整历史不会猜测关联。
- 实时 token 投影继续逐帧替换同一 Run 的 assistant 槽位；tool 事件和自然语言分离显示。

### MCP 结论（纠正原始假设）

“MCP 没有自动注入”目前不是已证实事实。`PiRuntimeFactory` 在 `mcpServers` 非空时解析 `pi-mcp-adapter` 绑定，传入 `additionalExtensionPaths`、flag values，并在 session 建立后绑定扩展。真实 stdio MCP 集成测试验证了 `mcp__mock__echo` 被注册且可调用。

更可能的运行时原因是以下配置之一缺失或失败：

1. AgentVersion 的 `configJson.mcpServers` 为空；空配置按设计不会加载 MCP。
2. `MCP_SERVERS_JSON` 不含引用的 serverId，或 secret reference 无法解析。
3. MCP 子进程/远端服务器无法启动；当前应从运行诊断中读取具体失败码，而不是假设“未注入”。

建议在部署环境采集一次 `mcpBinding.enabled`、已注册 `mcp__*` 工具名和 ResourceLoader diagnostics；不要为“空配置也自动加载所有 MCP”放宽现有 allowlist 与显式 AgentVersion 绑定。

### MCP 配置现状

`.env` 可提供全局服务器注册表 `MCP_SERVERS_JSON`（当前包含 Exa 的远程 MCP 定义），但它不是自动启用开关。每个 AgentVersion 仍必须在 `configJson.mcpServers` 显式引用允许的 server id；若该数组为空，运行时按设计不加载任何 MCP。`AGENT_PROFILES_JSON` 是额外的 allowlist/策略层，不能替代 AgentVersion 引用。

目前 registry loader 实际消费 `id`、`url` 或 `command`、`timeoutMs`、`authTokenRef`、`envRefs`、`headerRefs` 等字段。现有 `.env` 中的 `transport`、`retries`、展示 `name` 不会改变当前适配器连接行为；应避免据此误判远程 MCP 已被启用或会自动重试。

### Skill 读取与脚本执行设计

- Pi SDK 继续只负责扫描 Skill 元数据并把摘要放进提示；真实正文通过 `read` 工具读取。
- 新增 `POST /internal/v1/skills/read`，使用专属 `sandbox.skills.read` scope。Agent transport 与 Sandbox contract 都只接受规范化的 `/home/sandbox/skill/<package>/...` 路径；请求哈希仍只绑定 `path/offset/limit/maxBytes`，与 `read` 的 ledger 语义一致。
- Sandbox 从只读 Skill 挂载用 fd-relative `O_NOFOLLOW` 打开普通文件，拒绝路径逃逸、符号链接、目录和非普通文件；结果仍受 256 KiB 分页上限。
- Skill 脚本不新增任意代码执行工具，而是复用 `bash`/`process_start`。当命令触及 Skill 根时，策略只允许无 shell 操作符的 `python|python3 <skill>/scripts/*.py` 或 `sh|bash <skill>/scripts/*.sh` 形式；挂载本身保持只读。脚本包是受信任的软件供应链输入，安装/更新前仍需审核，不能把该约束误解为脚本内容沙箱。

## 其他审查发现

| 优先级 | 发现 | 风险/建议 |
| --- | --- | --- |
| P1 | `pi-jsonl-codec` 将全部非整数以 `toPrecision(15)` 重写 | 这会改变合法浮点 usage/cost 值，而不只是消除 MySQL round-trip 差异；可能改变账务、重放或哈希语义。应以跨 MySQL 的原始 JSON/哈希回归用例证明必要性，或采用不改变业务值的稳定序列化策略。发布前需要处理。 |
| P2 | `ConversationService.list()` 对每个 conversation 单独查询 session | 列表页成为 N+1 查询；会随会话数线性增加数据库往返。应为 session repository 增加 owner-scoped 批量查询，并按 conversation ID 映射。 |
| P2 | 首屏 JS 压缩后约 683 KB | Vite 已报警超过 500 KB。非功能性阻塞，但建议按路由/管理面板拆分动态 chunk。 |
| P2 | tool-envelope 识别使用几个 JSON 字段的启发式 | 对旧数据是兼容性兜底，不是长期协议。应确保后端事件始终带明确 role/type，并在数据迁移后删除启发式。 |

## 本次已做修改

- 修复 optimistic user 消息和 Run 的竞态绑定。
- 修复重复 assistant 文本、历史缺 run ID 时的稳定合并。
- 恢复内部 execution/process 请求的认证与 body-length 传输契约。
- 将 Pi Runtime 系统提示改为明确的 enterprise sandbox 提示，并传入正式 Skill 根供 ResourceLoader 发现 Skill 元数据。
- 让生产 bridge 自动注入 `readSkill` signed transport，并在 Sandbox 装配对应 runtime；Skill 正文不再退化为 `SKILL_READ_UNSUPPORTED`。
- 将 Skill 路径命令策略真正接入 enterprise-policy，限定到 package `scripts/` 中的直接 Python/Shell 脚本调用。
- 更新 Runtime 测试以验证新的系统提示和 skill path 契约。

## 后续改进建议

1. 处理 JSONL 浮点 canonicalization 的语义风险，补跨数据库回归测试。
2. 为 conversation/session 查询消除 N+1。
3. 在带真实 HMAC/MySQL/Redis 的 Compose 环境跑一次 `/internal/v1/skills/read` 集成测试，并验证目标 Skill 脚本的供应链审核流程。

## 验证记录

- `frontend`: `npm test -- --run` — 200/200 通过。
- `frontend`: `npm run build` — 通过；保留上述 chunk size 警告。
- `agent`: `npm test -- --run` — 1102/1102 通过。
- `sandbox`：读取相关 98 项通过；另有 1 个 legacy API-key 测试因本机无法解析 `sandbox-replay-redis` 未运行（不是断言失败）。Python 模块也已用项目虚拟环境编译，并完成 `InternalSkillReader` 的临时只读根冒烟读取。
- 已运行 `git diff --check`，无空白错误。

未做真实浏览器交互或连通真实 MCP 服务的手工部署验证；MCP 的本地真实 stdio 集成测试已包含在 Agent 测试集。
