# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **read 工具支持图片（模型可以直接看工作区里的图）**: `read` 命中图片时返回 Pi `ImageContent` 而不是 `{binary:true}` 空壳——对齐 Pi 原生 read 的做法（Pi 没有独立 vision 工具，图片能力就做在 read 里）。此前一轮 Run 渲染出来的图表、截图、PDF 转页对模型完全不可见，唯一出路是 OCR。Sandbox 侧按**内容**嗅探类型（`image_sniff.py`，png/jpeg/gif/webp/bmp；工作区路径是模型自己写的，扩展名不作数），在 2MiB 预算内随响应回传 base64；超预算返回 `imageOmitted: IMAGE_TOO_LARGE` 并告诉模型先降采样再读，而不是静默给空。Agent 侧复用 SDK 导出的 `convertToPng` / `resizeImage` / `formatDimensionNote` 归一化并压到 Pi 的内联预算，且对到达的字段独立复核（base64 形状、类型白名单、解码后长度）——Sandbox 是跨网络的另一个服务，不能只凭它说了算。

- **Ctrl+V 粘贴图片为附件（前端）**: 输入框支持从剪贴板粘贴图片/文件。剪贴板图片没有文件名，按嗅探到的 MIME 命名为 `pasted-image-<时间戳>-<序号>.<ext>`——附件白名单按扩展名判定，不改名会被当作禁止类型拒收。与上传按钮、Ctrl+U 共用同一道「Run 运行中不可附加」门禁；剪贴板只有文本时不拦截事件，正常落进输入框。

- **Sandbox MCP bash 执行工具**: `sandbox-mcp` 新增 `sandbox_shell_execute`，在与 `sandbox_python_execute` 相同的 Bubblewrap 隔离工作区里执行 bash 命令（`execution_manager.run_command` 既有路径：网络黑名单预检 + `--unshare-net`、非 root、ulimit/seccomp 全套生效）。安全增量接近零——Python 本就能等价 spawn shell。命令长度上限 `SANDBOX_MCP_MAX_COMMAND_LENGTH`（默认 20000，Sandbox 桥侧同名上限 200000）；返回字段与 python 工具对齐（status/exit_code/stdout_preview/stderr_preview/duration_ms/truncated）。`sandbox/config.py` 热点预算 1488→1491（新增一个配置项的三行）。

- **消息气泡操作与滚动体验（前端）**: 助手气泡 hover 后出现 Copy（复制全文纯文本）与 Regenerate（仅最后一条助手气泡、且无活跃 Run 时显示，取前一条用户回合文本重发为新 Run——语义是追加一轮而非原地改写）；距底部超过 120px 时右下角出现「回到最新」浮标（sticky 定位，smooth 滚动）。流式渲染性能：`MessageBubble` 改为 `React.memo` + 内容指纹比较（投影层每个 SSE tick 都重建气泡对象，身份比较永远失效；气泡内不再订阅 chat context，否则 memo 被穿透），流式中的气泡照常更新，已完成气泡不再随每个 token 重新解析 markdown。

- **子 Run 不再注册 `ask_user`**: 子 Run 的对话被刻意排除在会话列表外，任务提示按契约自包含，也没有任何路径把子 Run 的提问送到发起父 Run 的人面前——注册这个工具只会让它停在 WAITING_INPUT 等一个没人看得见的问题。现在直接不注册，模型自行决定或失败，而不是挂死。extension 本身仍然装载（registry 对 AgentVersion 的 extension 列表是精确校验）。
- **停泊 Run 的取消回收对齐**: `run-recovery-service` 处理 WAITING_APPROVAL 的 cancel intent 已久，但 WAITING_INPUT 分支从不检查它——interaction 还是 PENDING 就直接跳过。带 cancel intent 的停泊 Run 因此可能永远卡住。两条分支现在共用一条路径（`run-recovery-parked-cancel.js`），WAITING_INPUT 的就地了结逻辑也从 `CancelRunService` 抽到 `parked-interaction-cancel.js`，与既有的 `parked-approval-cancel.js` 对称，由直接取消与恢复共用。
- **子 Run 级联取消**: 取消父 Run 会为其所有存活后代写入持久 cancel intent（沿 `parent_run_id` 深度有界遍历）并发出 Redis 取消信号（子 Run id 列表随取消响应返回）。这里只写 intent：`execute-run-service` 在进入 runtime 前及每步前后都会检查它（先读 MySQL，Redis 仅为加速），所以排队中的子 Run 在被捡起时就地终止、运行中的子 Run 走它自己那条已有的取消路径——无需为每个子 Run 复刻 WAITING_INPUT/WAITING_APPROVAL 的停泊终结逻辑。已终态的父 Run 同样会回收其存活子 Run（父 Run 失败后子 Run 仍在烧预算）。子 Run 自己更早的取消原因不会被父级覆盖（first-writer-wins）。`spawn_subagent` 现在拒绝在已终态或已请求取消的父 Run 下创建新子 Run——父行的 `FOR UPDATE` 让取消与创建串行，两种先后顺序都安全。
- **子 Conversation 不再进入会话列表**: `conversations.parent_run_id`（migration `20260822000003`）标记子 Run 自己的 Conversation，`listForOwner` 默认过滤掉它们（`includeSubagent: true` 可取回）。`getById` 不过滤——子任务的 transcript 仍可按 id 读取，这正是当初否掉"创建即 archive"方案的理由。
- **子 Run（sub-agent）**: 新增可选 extension `subagent-spawn`，注册 `spawn_subagent` / `check_subagent`。子 Run 是普通 Run——同一张 `runs` 表、同一个 `agent-runs` 队列、同一套 worker 与恢复路径，只多了 `source='subagent'` / `parent_run_id` / `subagent_depth` 血缘（migration `20260822000001`）。每个子 Run 有自己的 Conversation 与 AgentSession（父 Run 整个生命周期持有其执行 fence，共用会话必然死锁），继承父 Run 的 AgentVersion、`trace_id` 与父 span。`toolCallId` 作幂等键保证一次 tool call 只产生一个子 Run；深度与并发上限在父行加锁后于事务内复查，可用 `AGENT_SUBAGENT_MAX_DEPTH` / `AGENT_SUBAGENT_MAX_CONCURRENT` 或 AgentVersion `configJson.subagent` 收紧。
- **持久任务状态**: 新增可选 extension `task-state`，注册 `todo_write` / `todo_read`（按 AgentSession 整体替换的计划清单）与 `memory_write` / `memory_search`（owner 级、跨对话的追加式备忘）。两张表 `task_todos` / `task_memories`（migration `20260822000002`）全程 org+user 作用域。
- **Provider 并发闸门与 429 冷却**: 每个 Agent 进程一个闸门（不是每个 Run 一个——那样只会限制本已串行的单个 prompt 循环），在 `before_provider_request` 取号、`after_provider_response` 归还；等待有界，超时后降级直通并交回**空操作**的 release，所以降级调用方不会释放别人的名额。连续 429 按 key 指数延长冷却窗口，非 429 响应立即清除。`AGENT_PROVIDER_MAX_CONCURRENT` / `AGENT_PROVIDER_COOLDOWN_MS` 可调。
- **OTel 工具 span**: 配置了 OTLP endpoint 时，每次工具执行产生一个 CLIENT span（`agent.tool.<name>`），挂在当前 Run span 下；失败只记录结果的稳定 code，绝不把工具输出带进链路。Run 中断遗留的 span 与 provider 名额都在 `session_shutdown` 收口。
- **A2A v0.3 对齐**: Agent Card 发布 skills；streaming status 事件符合 SDK schema；发出官方 task-lifecycle 流。
- **用户 Skill 生命周期**: 新增可选第一方 extension `skill-lifecycle`，支持上传安装、Agent 生成、编辑与卸载，全部限制在 per-user Skill 根内并走审批。Sandbox 执行侧的 read/bind 认可用户 Skill 路径。
- **模型能力**: 模型选择、视觉输入与 thinking UI；MCP 发现到的 schema 投射给模型。
- **工作区搜索工具**: 新增 `ls` / `find` / `grep` 三个 sandbox-bridge 工具，走 `/internal/v1/files/{ls,find,grep}` HMAC 内部平面。此前 SDK 同名工具因会读 Agent 容器文件系统而被永久排除，却没有替代品——模型只能用 `bash` 探索工作区（串行、无结构、无预算）。三者只读、可与 `read` 并行、有默认与上限预算，并把截断和跳过的目录如实报给模型。`SANDBOX_TOOL_NAMES` 由 10 增至 13。
- **Run 收敛保护**: 为每个 Pi Run 增加模型回合、总工具调用和相同工具/参数调用上限；达到上限后禁止继续调用工具，并要求模型依据已有结果作答。三个上限均可通过 `AGENT_RUN_MAX_*` 配置。
- **MCP 启动发现**: Agent 启动时连接每个启用的 MCP Server 并执行 `tools/list`；发现到的工具以 `mcp__{serverId}__{toolName}` 注册，对应的连接与工具数量会出现在 readiness/diagnostics。

### Removed

- **`config/agent/models.json`**: 与 `model-registry.json` 重复的第二份模型目录，全仓库零引用——不被任何代码读取，也不在 pi SDK 查找 `models.json` 的 `AGENT_PI_AGENT_DIR` 下（容器里 `/app/pi-agent-home/` 是空的）。留着只会继续和真实目录漂移。
- **`disabled-test-model` 与 `ZERO_PRICING`**: 前者是只为测试存在却出货在生产 seed 里的假模型，已移进测试自己的 fixture；后者随之失去全部引用（`normalizeModelEntry` 本就把各价格字段内联默认为 0）。

### Changed

- **模型目录对齐真实网关**: registry 此前列的 `gpt-5.5` / `mimo-v2.5` / `mimo-v2.5-pro` / `gemini-3.5-flash` 在实际 LLMIO 网关上都不存在——选中即失败（`mimo-v2.5` 报 "supported API model names are…"，`gpt-5.5` 更早地因 `supports_developer_role: true` 报 `unknown variant 'developer'`）。现在只保留网关真正提供的三个：`deepseek-v4-flash`（默认）、`deepseek-v4-pro`、新增的 `deepseek-v4-flash-vision-exp`（唯一支持图片输入的 id，这也是上面 read 图片能力在本部署里唯一可用的模型）。

  两处都要改才生效：`buildRegistry` 是「源码 seed + 文件」合并，文件只增不减，所以只清 `config/agent/model-registry.json` 会让删掉的模型继续从 `SEED_MODELS` 暴露出来。

- **模型注册表测试改用自带 fixture**: 「registry 是数据驱动而非硬编码」这类机制测试原本依赖 `SEED_MODELS` 里恰好存在的 gemini/gpt 作对照，导致改动出货目录就会打断无关测试。现在用测试文件内的 `FIXTURE_MODELS`，出货目录另有一条断言单独覆盖。

- **一轮 Run 合并为一个助手气泡（前端）**: 同一 Run 的相邻 assistant 行在投影末尾合并成一条消息。此前「出文本 → 调工具 → 再出文本」的一轮会摊成一叠各自带头像和「UPRC Agent」抬头的碎片，读起来像好几个人在说话。身份字段取首行（React key 与回合起始时间稳定），存活状态取末行。步骤树随之挂到该 Run 的**第一个**气泡并渲染在正文之前，**默认折叠**——它在回合顶端，展开会把回答本身顶到屏幕外；折叠态摘要行仍显示步骤数与耗时。

- **`task-state` 默认装载**: `defaultAgentConfigJson()` 发的是 `extensions: []`，而空列表只选必需的四个 + `skill-lifecycle`，所以 `todo_write` / `todo_read` 从来没有真正到过模型手上——表现就是「Agent 不会拆解多步任务」，每一轮都从 transcript 重新推导计划，compaction 之后彻底丢失。现在与 `skill-lifecycle` 同规则：store 就绪且 AgentVersion 未显式列出 extensions 时自动装载。显式列表仍然权威（`pi-runtime-factory` 精确校验 factory 列表，静默追加会把合法 AgentVersion 变成 `PI_EXTENSIONS_COUNT` 错误），因此显式列表也是关闭它的方式。

- **纯文本模型收到图片不再让 Run 失败**: 此前给不支持 vision 的模型附图会直接 `FAILED: does not support image input`，把用户打的字连同图片一起丢掉。现在丢弃图片并在 prompt 里告知模型（文件名、原因、附件仍可当文件读），对齐 Pi 原生 read 对非 vision 模型的降级提示。`read` 读到的图片同理：不支持 vision 时只回文本注记，绝不把图片字节送给收不下的 provider。

- **代码与文档整理**: 删除未接入的 TypeScript contracts 包、历史 approval waiter 与 Sandbox 中未使用的 Agent/审批 DTO；跨语言 golden fixture 统一到 `tests/fixtures/contracts/`，开发与 SDK 升级文档按当前 `src/` 布局和持久化模型修订。
- **Run 与对话投影**: Run 列表/详情补充模型、token usage、规范化生命周期时间及最新 durable event ID；对话历史保留 durable message ID、Run ID 与顺序，且只显示当前用户回合而非整个历史 prompt。
- **运行管理界面**: 按 Agent 的权威状态过滤 Run，支持 `WAITING_INPUT`，并兼容 `completed_at` 与历史 `finished_at` 字段。
- **Artifact 下载**: 对非 ASCII 文件名使用 RFC 5987 `filename*`，同时提供 ASCII fallback，避免下载响应因 HTTP header 编码失败。
- **必需 Extension 增至四个**: `user-interaction` 从 `enterprise-policy` 拆出并成为必需，`ask_user` 由它注册；`enterprise-policy` 回归纯拦截器，不再注册任何工具。仅给出旧的三个名字仍可用，隐含启用 `user-interaction`。
- **Sandbox 公共执行路由删除**: `POST /sessions/{id}/executions/*` 及 Sandbox 侧的 `/approvals`、`/conversations` 全部移除。执行只存在于 `/internal/v1/*` HMAC 平面；审批与 Conversation 的唯一权威是 Agent MySQL。
- **Sandbox 网络**: 开发态给出 egress，生产 overlay 明确剥离。
- **Web UI**: 会话恢复与 Run 生命周期同步；模型选择器改版。
- **行数闸门**: `HOTSPOT_LINE_BUDGETS` 改为钉在各文件当前长度——只能缩不能涨。六个超限文件按职责拆分，闸门自 2026-07-31 以来首次转绿。
- **CI**: 修正 Agent syntax-check 指向的失效路径 `agent/testing/fake-openai-provider.js`（实际位于 `agent/tests/support/`），该 job 因此长期失败。

### Removed

- ADR 0002 / 0003（2026-07-19，`7370220d`）——内容已被 `plan.md` 取代，编号不再复用。

### Fixed

- **输入法组合期回车误发送**：Composer 的回车提交未检查 `isComposing`，中文/日文输入法按回车确认候选词会把拼音原文直接发出去。现在组合期间的 Enter 不再触发提交（`isEnterSubmitKey` 纯函数 + 回归测试）。
- **Ctrl+U 上传快捷键空头支票**：上传按钮文案宣称支持 Ctrl+U，但全局 keydown 里该分支只有注释没有实现。现在由 Composer 旁的监听器真正打开文件选择器（与按钮同一运行中禁用门控），且 `Ctrl/Cmd+L`（新建会话）在 macOS 上也能通过 Cmd 触发；快捷键在输入法组合期间同样不触发。
- **消息日志 aria-live 刷屏**：流式输出时每个 SSE token 都进入整段 transcript 的 live region，读屏软件被逐 token 重读。MessageList 改为显式 `aria-live="off"`——`role="log"` 隐式就是 polite live region，只删显式属性并不会让它安静下来。Run 状态播报继续走 FlashZone 的 `role="status"`。

## [4.0.0] — 2026-07-04

### Added

- **三容器架构 (v4)**: 前端 (Nginx + SPA) + API Server (Node.js + pi-coding-agent) + Sandbox (Python FastAPI)，前端零 Agent，LLM Key 仅存服务端

### Changed

- **文档全面重写**: README.md、docs/architecture.md、docs/deployment.md、docs/development.md、docs/api.md、docs/webui.md 全部基于实际代码重写
- **端口规范化**: 统一 host→container 端口标注格式，修正所有文档中的端口不一致问题
- **API 文档**: 补全三层 API（Frontend → API Server → Sandbox），新增 Conversations、Approvals、Traces、MCP 端点文档，补充 SSE 事件协议完整列表
- **部署文档**: 更新架构图和端口，标注 docker-compose.prod.yml 服务名不匹配问题

### Removed

- **旧设计文档移除**: 早期 system-design 草稿不再保留；以 `plan.md` 与活跃 `docs/*` 为准

## [0.2.0] — 2026-07-03

### Added

- **Frontend/Backend Separation**: Modularized monolithic `server.js` into 9 focused modules (`config.js`, `services/sandbox-client.js`, `services/conversation-manager.js`, `services/agent-factory.js`, `routes/status.js`, `routes/conversations.js`, `routes/chat.js`, `routes/static.js`)
- **WebUI Frontend Modules**: Split monolithic `app.js` into ES modules (`js/api.js`, `js/utils.js`, `js/chat.js`, `js/conversations.js`, `js/app.js`)
- **Light Theme**: Added toggleable light theme via `[data-theme="light"]` CSS
- **Code Copy Button**: One-click copy for code blocks in chat messages
- **Collapsible Tool Calls**: Tool execution indicators are now expandable to show arguments
- **Skeleton Loading**: Loading state animations for better UX during initialization
- **Comprehensive Documentation**: Added `CONTRIBUTING.md`, `CHANGELOG.md`, `docs/` directory with architecture, API, deployment, development, and WebUI guides
- **WebUI Test Suite**: Added tests for the WebUI server API (`tests/test_webui_api.py`)
- **Configuration Tests**: Added tests for config defaults and version consistency
- **Entrypoint Tests**: Added tests for the sandbox entrypoint parameter handling

### Changed

- **README.md**: Completely rewritten with detailed architecture, quick start, configuration reference, and project roadmap
- **webui/index.html**: Updated to load ES modules, added theme-color meta tag
- **webui/style.css**: Enhanced with light theme variables, copy button styles, collapsible tool styles, skeleton animations
- **webui/server.js**: Now a thin entry point that delegates to route modules

### Fixed

- **首个管理员无法创建**：注册忽略客户端提供的 role/organization_id（正确），而 `BFF_DEV_ACTING_ROLE` 只在关闭鉴权时生效，导致任何真实部署上 `/api/a2a/config` 等管理员面不可达。新增 `SANDBOX_AUTH_ADMIN_USERNAMES`：名单内用户名注册即晋升 admin。
- **进程控制、取消与上传错误路径**：QA 发现的六处缺陷修复（admin bootstrap、process control、cancel 与 upload 错误处理）。
- **Agent `/internal/*` 平面在 token 未配置时无鉴权**：这些路由直接信任 `X-Acting-*` 头，能触达端口即能冒充任意用户。现在空 token 直接关闭内部平面；无鉴权运行必须显式设置 `AGENT_ALLOW_UNAUTHENTICATED_INTERNAL=true`，生产配置校验拒绝该选项，启动日志明示当前模式；token 比较改为常量时间。
- **api-server 与 agent 容器以 root 运行**：两个 Dockerfile 现在在移交写入路径后降权到基础镜像的 `node` 用户。存量部署注意：`agent_user_skills` 卷是以 root 创建的，需重建或 chown 一次。
- **BFF 全部出站调用无超时**：上游接受连接但不响应时会无限悬挂并钉死浏览器请求与 socket。Agent 调用现受 `AGENT_REQUEST_TIMEOUT_MS`（默认 15s）约束，Sandbox 调用受 `SANDBOX_REQUEST_TIMEOUT_MS`（默认 15s）约束。
- **Sandbox JWT 密钥 fail-open**：`auth_enabled=true` 但未配置密钥时回退到公开默认值，可伪造任意身份 token。现在缺失即启动失败（fail-closed）。


## [0.1.0] — 2026-06-28

### Added

- Sandbox Service with Session/Workspace/Execution management
- ToolPolicyChecker (low/medium/high risk levels)
- Path escape protection
- Non-root execution + safe_env
- stdout/stderr preview limits
- Serial execution per session
- Resource limits (timeout, output size)
- File API (read/write/list/preview/download)
- Artifact API (register/list/download)
- Audit logging
- Prometheus metrics
- Health / Readiness checks
- MCP Server Adapter
- Docker multi-stage build
- EnterpriseToolAdapter with policy pre-check
- SandboxClient SDK
- Pi Extension (TypeScript)
- Approval workflow for high-risk tools
- Trace ID middleware
- SQLite persistence (WAL mode)
- Session restore via enterprise_session_id
- Built-in Skills (document-parser, data-analysis, sql-query)
- WebUI chat interface with SSE streaming
