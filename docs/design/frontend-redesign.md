# 前端重设计：线性对话流与管理控制台

- 状态：设计定稿，待实施
- 日期：2026-09-25
- 原型：<https://claude.ai/artifact/Gwf3xxP65CaJWjtkGT2iCz>（第 3 版，私有链接，需由作者共享后他人可见）
- 范围：`frontend/` 全部表现层；第 3 期涉及 `agent/` 与 `api-server/` 新增接口

## 1. 背景

后端接口已基本完整，但前端多处与能力不匹配（2026-09-25 在运行中的栈上逐页核对）：

| 位置 | 问题 |
|---|---|
| 对话 | 一轮回复的多段文字被拼在一起，工具调用单独收进顶部 “Agent Execution Steps” 树，**文字与工具的先后顺序丢失**；子代理展开后直接铺出整段 prompt |
| 工具适配 | `delegate_to_remote_agent` 无任何渲染（`frontend/src` 引用数为 0）；`job_*` 只在事件归一化里识别；`subagent` / `delegate_to_agent` 有卡片但只显示 prompt 原文 |
| 信息架构 | Approvals、Runs 放在 “Settings” 下，普通用户也看得到；定时任务、产物库没有像样的入口 |
| 能力页 | 大卡片网格，信息密度低；仍有已不存在的 Extension 概念（`/api/extensions/diagnostics`） |
| Agents 页 | 列表、新建、编辑堆在同一长页；工具权限是 20 多行 “Inherit platform” 下拉框；看不出当前编辑基于哪个版本 |
| Runs 页 | 截断的 ULID 作主列，Model/Tokens 多为空，每行三个按钮 |
| 工程 | `shared/styles/app.css` 单文件 4669 行，改样式易互相影响 |

参照对象：Codex、opencode 的线性对话流；DeepSeek Harness web 的设置模态框与 Agent 预设卡片；Grok web 的侧栏导航与“自动化任务”页。

## 2. 设计定稿

以原型为准，这里只记录结构性决定。

### 2.1 信息架构

- **普通用户**只有：新建会话 / 定时任务 / 产物 三个一级入口 + 会话列表 + 设置模态框。
  审批就地出现在会话流里，侧栏用黄点标出等待审批的会话，不设单独的审批中心。
- **管理员**额外有独立全屏的“管理控制台”（用户菜单进入）：运行（含 Run 详情 = Trace）、智能体、能力、A2A 接入。
- 路由（旧路径保留重定向）：

| 路径 | 页面 | 可见 |
|---|---|---|
| `/`、`/c/:conversationId` | 会话 | 全部 |
| `/schedules` | 定时任务（tab：任务 / 运行） | 全部 |
| `/artifacts` | 产物库 | 全部（依赖后端，第 3 期） |
| `/admin/runs`、`/admin/runs/:runId` | 运行列表、Run 详情 | admin |
| `/admin/agents`、`/admin/capabilities`、`/admin/a2a` | 配置 | admin |
| `/settings/*`、`/runs`、`/approvals` | 重定向到新位置 | — |

设置是模态框，不是路由页：账户 / 通用 / 我的 Skills。

### 2.2 侧栏

品牌行（右侧收起按钮）→ 线性图标导航（新建会话 ⌘L、定时任务、产物）→ 搜索框（输入即过滤，⌘K 打开全局命令面板）→ 可折叠“会话”分组（标题右侧智能体筛选图标）→ 底部用户菜单。

会话行右侧显示所属智能体标签（每个智能体固定颜色，组织默认智能体不显示）；运行中蓝点、等待审批黄点。
会话 DTO 已有 `agent_id`，名称来自 `/api/agents` 目录。

### 2.3 线性对话流

一轮回复按事件顺序渲染为以下条目，已完成的轮次默认紧凑（可在设置里改为展开）：

| 条目 | 来源 | 呈现 |
|---|---|---|
| 思考 | message.thinking | 一行“思考了 N 秒”，折叠 |
| 文字段 | assistant 文本 | Markdown |
| 工具组 | 相邻的普通工具（read/write/edit/glob/grep/bash/skill/mcp__*） | 一行摘要“读取 1 个文件，运行 2 条命令 · 1.9s”，展开见每个工具的输入输出 |
| 任务清单 | `todo_write` 的 **arguments** | 原地更新的清单卡；同一轮只保留最新一张 |
| 子任务 | `subagent`、`delegate_to_agent`（相邻的合成一张卡） | 每行：标题、执行者（同一智能体 / 委派给谁）、状态、步数、耗时；展开见任务简述、步骤摘要、结论。完整 prompt 只在 Trace 里 |
| 远程委派 | `delegate_to_remote_agent` | A2A 标签；需审批时就地显示审批卡（发给谁、会发送什么），批准后收成一行 |
| 审批 | approval | 就地审批卡，批准 / 拒绝 |
| 提问 | `ask_user_question` | 选项卡片，回答后显示所选项 |
| 后台任务 | `bash` 后台进程 + `job_output`/`job_list`/`job_kill` | 一张实时刷新的任务卡（状态、耗时、输出末几行、停止）；查看类调用并入该卡，不单独成行 |
| 产物 | `submit_artifact` | 文件卡片，点开右侧抽屉预览；图片产物直接显示大图 |
| 页脚 | Run 统计 | 耗时、工具数、子任务数、tokens、复制、重新生成；admin 多“在 Trace 中查看” |

用户消息：图片附件显示缩略图（点开大图），其他文件显示文件条。

输入框：`＋` 菜单（上传文件或图片 / 引用其他会话的产物）；待发送附件显示缩略图与上传进度；运行中不锁定，Enter 排队追问（follow-ups）、⌘Enter 立即改向（steer），默认行为可在设置切换。
智能体只在新会话首条消息前可选，此后在标题栏只读显示。

移除：`InlineRuntimeSteps` 步骤树、右侧 `ContextInspector`、会话内 `TracePanel`。

### 2.4 定时任务

参照 Grok：顶部“定时任务 / 运行” tab + 右上主按钮；30 天运行条（一天一根，颜色表示当天结果）；表格列为任务、日程、下次运行、状态，其余操作收进 ⋯ 菜单。

新建表单字段与 `/api/cron-jobs` 一一对应：名称、智能体、指令、频率（仅一次 / 每天 / 每周 / 每月 / 自定义 cron）、时间或日期、时区、错过策略（`misfire_policy`）、并发策略（`concurrency_policy`）、启用；表单底部实时显示接下来几次触发时间与生成的 cron 表达式。

### 2.5 设置模态框

- **账户**：显示名称、邮箱（用于运行完成通知）可编辑；用户名、机构、用户类型、登录方式、账户状态、注册时间只读。
- **通用**：外观、语言、对话显示（紧凑 / 展开）、运行中按 Enter 的行为、运行完成邮件通知。
- **我的 Skills**：草稿上传（.zip / .skill，50 MB）、启用 / 停用；系统 Skills 只在管理端出现。

### 2.6 管理控制台

- **运行**：统计条（今日运行、失败、等待审批、耗时中位数、7 天趋势）+ 筛选 + 整行可点的表格（状态、会话标题、用户、智能体、模型、工具数、tokens、耗时、开始时间）。
- **Run 详情 = Trace**：左侧 span 瀑布图（模型轮次、工具、子任务、审批等待），右侧选中节点的内容。
  持久 trace 按设计只存元数据（`trace-span-projections.ts` 的属性白名单），**内容由前端从事件回放与工具台账按 `toolCallId` 拼接**，不改 trace 契约。
- **智能体**：左列表右编辑器；顶栏固定显示“编辑基于 vN”、未保存修改数、放弃 / 仅保存 / 保存并启用；tab 为基本信息、模型、工具权限、MCP、版本历史、JSON。
  工具权限按类别分组，每行“继承 / 允许 / 审批 / 禁止”四档分段控件，已覆盖行高亮，可只看覆盖项。版本历史带与活跃版本的差异。
- **能力**：Skills / MCP / 工具 / 模型 四个 tab，表格呈现，去掉 Extension。
- **A2A 接入**：功能不变，统一表格样式。

## 3. 保留与重写边界

**保留（数据正确性核心，只做必要扩展）**：`entities/`、`shared/state/runReducer.ts`、`shared/sse/`、`shared/api/`、`shared/schemas/`、`features/chat/entityBridge.ts`、`features/chat/controllers/`、`features/chat/uploads/`。

**重写**：`app/`（路由与布局壳）、`widgets/`、`pages/`、`shared/styles/`、`shared/ui/`。

**删除**：`widgets/runtime-steps/InlineRuntimeSteps.tsx`、`widgets/context-inspector/`、`widgets/trace-panel/`（逻辑迁入管理端 Trace）、`widgets/tool-call-panel/`、`app/layout/SettingsSubnav.tsx`、`pages/settings/`（拆入 `pages/admin/` 与设置模态框）。
其中可复用的纯函数（`subagentFields.ts`、`taskStateFields.ts`、`interactionFields.ts`、`formatToolDisplay.ts`、`agentHelpers.ts`、`skillHelpers.ts`）迁移保留，连同其测试。

## 4. 技术约束

- **零新依赖**：内网部署无法保证 npm 源，不引入 Tailwind 或组件库。样式用 Vite 原生 CSS Modules（`*.module.css`）加重写的 `shared/ui/tokens.css`；弹层用原生 `<dialog>` 与 `popover`；图标继续用内联 SVG（改为线性图标）。
- **结构棘轮**：`tests/test_repository_layout.py` 只统计 `.ts`/`.tsx`，生产文件默认 ≤1000 行；`ChatContext.tsx`（1454）、`entityBridge.ts`（1176）、`runReducer.ts`（1492）、`InlineRuntimeSteps.tsx`（1011）钉在当前行数，只能减。
  线性流需要的扩展必须通过拆分落地，不能抬预算；删除 `InlineRuntimeSteps.tsx` 后同步移除它的预算行。
- **源码断言型测试**：`a11y-responsive`、`capabilities-page`、`message-actions`、`approval-decision`、`process-console`、`live-run-replay` 会读源码或类名断言，重写对应组件时同步改写，断言对外行为而非旧类名。
- **中文界面**：本期界面文案为中文；是否做中英双语另议（见 §8）。

## 5. 关键技术风险：事件顺序

线性流依赖“一轮内文字段与工具调用的相对顺序”。现状：

- `MessageEntity` 没有事件序号，一轮的多段文字累积在同一个或相邻的消息实体里，再由 `mergeAssistantTurns` 合并；
- `ToolExecutionEntity` 同样没有记录事件序号。

因此现有 UI 只能把文字和工具分开放。实施第 1 期第一步：

1. 在 `runReducer` 为消息段与工具执行记录**首次出现的事件 sequence**；文本在工具调用之后恢复时开新段，而不是追加到上一段。
2. 新增纯函数投影 `projectTurnItems(store, runId)`，按 sequence 输出 §2.3 的条目序列（含工具分组、并行子任务合并、todo 去重、job 聚合）。
3. **先确认历史回放能还原同样的顺序**：刷新页面后走的是 `/api/runs/{id}/events` 重放与会话消息投影，两条路径都必须得到相同序列。若会话消息行（`sequence_no`）不足以交错，需要以事件重放为准，或请 agent 在持久消息里补段落边界。这一项在动 UI 之前先用测试夹具（`tests/fixtures/sse_events.json`）与真实会话验证。

## 6. 分期

### 第 1 期：布局壳与线性对话流（纯前端）

1. 设计 token 重写、CSS Modules 接入、线性图标集。字体只用系统字体栈（苹方 / 微软雅黑 / Noto Sans SC），不引入字体文件，内网无需额外资源。
2. 路由骨架与旧路径重定向；新侧栏（导航、搜索、⌘K 命令面板、会话分组、智能体标签与筛选）。
3. §5 的事件顺序改造与 `projectTurnItems`，带单测（含重放一致性）。
4. 对话流各条目组件（§2.3 全表），替换 `MessageBubble` 内的步骤树；删除 Inspector / 步骤树 / 会话内 Trace。
5. 输入框：`＋` 菜单、附件缩略图与进度、排队 / 改向提示、智能体选择与标题栏只读标签。
6. 图片预览：本地附件用 blob URL；历史附件与图片产物经 `/api/files/download` / `artifact-download` 渲染为 `<img>`（需真机确认 Content-Type 与大图加载；SVG 只以 `<img>` 方式展示）。
7. 引用其他会话的产物：先选会话、再列该会话产物（`/api/artifacts?session_id=`），调用 `POST /api/conversations/{id}/artifact-imports`。

### 第 2 期：定时任务、设置与普通用户页面（纯前端）

1. 定时任务页（任务 / 运行 tab、30 天运行条、⋯ 菜单）与新建 / 编辑表单（频率构造器、触发预览、试运行）。30 天运行条先由前端聚合各任务的 `/runs`。
2. 设置模态框：账户（先只读展示 `/api/auth/me` 已有字段）、通用、我的 Skills（从能力页迁出草稿上传与启用）。
3. 现有 Agents / 能力 / A2A 页面按新样式迁入 `/admin/*`，行为不变（智能体编辑器的 tab 化与工具权限分段控件在此期完成，接口不变）。

### 第 3 期：需要后端配合的能力

每项先在 agent 落服务与测试，再在 BFF 暴露，最后接前端；接口与鉴权在各自 PR 里写入 `api.md`。

| 能力 | 现状 | 需要新增 | 约束 |
|---|---|---|---|
| 管理员运行列表与统计 | `/api/runs`、`/trace`、`/events`、`/tools` 均按 owner 过滤 | `GET /api/admin/runs`（筛选：状态、智能体、用户、时间；游标分页）、`GET /api/admin/runs/stats`、按 runId 的 admin 作用域详情 / 事件 / 工具台账 / trace | 角色判定 fail-closed；只限本 org，跨 org 一律 404；BFF 只转发 |
| 账户编辑 | `users` 有 `display_name`、`email`、`status`，`/api/auth/me` 只返回 `username`、`display_name` | `me` 返回邮箱、机构名、角色、状态；`PATCH /api/auth/me` 仅允许改显示名称与邮箱 | 邮箱格式校验；与 `run-completion-email.md` 的收件人来源一致 |
| 产物库 | `/api/artifacts` 必须带 `session_id` | 按当前用户跨会话列产物（类型筛选、搜索、分页） | owner-scoped |
| 定时任务 30 天汇总 | 只能逐任务取 `/runs` | 可选：按用户的每日运行汇总 | 任务数量少时可不做 |
| 能力调用统计 | 无 | 可选：Skill 近 7 天调用次数 | 没有就不显示该列 |

## 7. 验证

按 AGENTS.md §4 执行，每期交付时记录代码版本、命令、结果与跳过原因：

- 六套测试、各包类型检查、`npm run build --prefix frontend`；第 3 期另跑 agent / BFF 相关测试。
- 前端每期都做**浏览器实际操作**：重建前端容器（`docker compose build frontend && docker compose up -d frontend`，第 3 期连同 `agent agent-worker api-server`），验证：登录 → 新建会话 → 一轮含工具、子任务、审批、提问、后台任务、产物的 run → 刷新后顺序不变 → 停止与改向 → 跨租户 404（第 3 期管理接口）。
- 线性流的顺序以真实 run 的事件重放为证，不以 mock 夹具代替。
- 深色 / 浅色、手机宽度（~400px）各走一遍核心路径。

## 8. 待决

1. Trace 是否展示“模型收到的完整 prompt”：当前未持久化，涉及存储量与审计，需单独决策。
2. 是否做中英双语。
3. 定时任务的邮件通知是否并入 `run-completion-email.md` 的实现。

## 9. 文档同步

实施各期同 PR 更新：`docs/webui.md`（结构、交互、快捷键全部重写）、`docs/api.md`（第 3 期新接口）、`docs/CHANGELOG.md` `[Unreleased]`；第 3 期若涉及 §32 验收行，同 commit 更新 `docs/STATUS.md`。
