# WebUI Guide

## 概述

v4 前端是一个**纯 UI SPA**，零 Agent 逻辑。Agent 运行在独立 Node Agent 服务；BFF 负责 Run API 与序列化 SSE relay，前端通过 SSE 消费事件流并渲染。

架构：

```text
React Workbench -> Nginx /api proxy -> Node BFF -> Node Agent -> Sandbox
                     <- serialized SSE <-         <- runtime events <-
```

## 目录结构

```
frontend/
├── src/
│   ├── main.tsx             ← React 入口
│   ├── app/                 ← Router 与 Workbench shell
│   ├── entities/            ← 规范化 runtime entity store
│   ├── features/chat/       ← Chat controller、event bridge、projections、upload queue
│   ├── shared/api/          ← /api fetch 与 URL 构造
│   ├── shared/sse/          ← SSE parser/manager/Agent event adapter
│   ├── shared/state/        ← UI state + run reducer
│   ├── widgets/             ← turn-stream（线性对话流与卡片）、conversation-sidebar、
│   │                          conversation-header、composer、message-list、markdown、
│   │                          context-inspector（资料抽屉）、process-console 等
│   └── pages/
│       ├── workbench/       ← 主工作台（会话 + 线性对话流）
│       ├── runs/            ← 运行列表、概况与 Trace（admin）
│       ├── approvals/       ← 审批（admin）
│       ├── schedules/       ← Cron 任务管理
│       └── settings/        ← Capabilities、Agents 与 A2A 管理
├── test/                    ← node:test + tsx
├── index.html
├── nginx/                   ← /api/* 反代模板（`API_UPSTREAM`，SSE buffering off）+ 启动前后校验脚本
├── vite.config.ts           ← dev proxy → localhost:4000
├── package.json
├── Dockerfile
└── dist/                    ← Vite 构建产物
```

## 核心架构

### 模块边界

| 模块 | 职责 |
|------|------|
| `features/chat/ChatContext.tsx` | 用户流程、conversation focus、transport 与 UI side effects |
| `features/chat/controllers/` | Run cancel/steer/follow-up/resume/interaction 控制器 |
| `entities/store.ts` | runtime 实体唯一 source of truth 与 selectors |
| `shared/state/runReducer.ts` | RuntimeEvent 的唯一归约器 |
| `features/chat/entityBridge.ts` | Agent SSE 适配、历史事件重放、per-run transport、UI projection |
| `features/chat/projections/` | 会话消息投影；`turnItems.ts` 把一个 Run 投影为线性条目，`turnFields.ts` 解析各卡片字段 |
| `shared/state/messageEvents.ts` | `message.*` / `thinking.*` 事件归约（从 runReducer 拆出），负责隐式分段与 `seq` |
| `features/chat/uploads/` | 附件上传并发队列（最多 3 个） |
| `shared/state/chatState.ts` | 非 runtime UI snapshot、上传草稿和 transport 控制 |
| `shared/api/client.ts` / `runs.ts` | Run、upload/download、approval、conversation 协议 |
| `shared/sse/parser.ts` | SSE 分片、CRLF、尾缓冲和 abort |

依赖：

- 生产构建：`npm run build --prefix frontend`（Vite）

### 状态管理

Runtime 状态只写 `EntityStore`：Run、增量 Message、Tool、Process、Approval、Artifact、trace 和
AgentSession 都由 `agentEventAdapter -> runReducer` 单次归约。`ChatState` 不含 `currentMsg`、
`pendingTool`、`pendingApproval` 或 `readyFiles`，只保存服务端历史快照、选择状态、上传草稿、布局、
认证与 transport 控制。`activeRunId` 直接从 EntityStore 读取，不维护 React 镜像 state。

### Capabilities / Skills 与 Drafts 上传

`/settings/capabilities` 的 Skills 页按当前登录用户投影三层：Drafts、My Skills、System Skills。
- **Drafts 上传**：在 Drafts 区域提供专属拖拽与点击上传卡片，支持用户直传 `.zip` 与 `.skill` 归档包（单包上限 50MB）。上传成功后包自动落入用户草稿根目录并即时在 Drafts 列表中以 `Draft` 状态卡片呈现。上传瞬间**不自动启用**。
- **人机闸门**：草稿卡片提供高亮 **Enable** 按钮；点击后平台校验结构、按内容摘要发布一份只读版本至用户已启用根，并写入 MySQL 账本；My Skills 按账本列出核对通过的已启用用户 Skill 并提供 **Disable** 按钮；系统 Skill 为只读不可变更。
- **启用后草稿不再重复列出**：启用是**复制字节**，草稿本身留在草稿根（停用只删账本行，已发布字节留给仍在运行的 Run，过宽限期回收）。Agent 因此给已发布过的草稿打 `published: true`，Drafts 区只列 `published !== true` 的那些——否则同一个包名会在页面上出现两次，而且草稿那张卡还带着一个按了也没有新效果的 Enable。My Skills 里对应的卡片显示 `from draft` 小标签；要重新发布改过的草稿，先 Disable，草稿会回到 Drafts。分层规则在 `pages/settings/skillHelpers.ts`（纯函数，可测）。
- **三层卡片同构**：Drafts / My Skills / System Skills 共用 `SkillCards`，同一张 meta 表（Source / Enabled / Dynamic），操作按钮统一收在卡片底部的 `.mgmt-card-actions` 行里靠右对齐。卡片是 flex-column，直接把 `<button>` 放进去会被拉伸成整行宽的大色块，草稿卡因此和系统卡不是一个形状。
- **Composer 拼图按钮移除**：取消了聊天输入框原本的拼图安装按钮，Skill 安装全面收敛至 Capabilities 页面。

### 多 Agent 选择

一个 org 下可以并列存在多个智能体，用户在**建会话**时选一个。

- **选择器只在两个条件同时成立时渲染**：org 内多于一个智能体，且当前还没有
  `conversationId`（即下一条消息会新建会话）。单智能体的 org 完全看不到它，
  体验与多 Agent 上线前一致。位置在 Composer 的模型行（`widgets/composer/AgentPicker.tsx`），
  用原生 `<select>`——选项是短名字，没有每项的价格/上下文窗口要排版。
- **会话开始后选择器消失**，会话头部改为显示一个只读的 Agent chip
  （`widgets/conversation-header/ConversationHeader.tsx`）。这是刻意的：一个会话
  绑定一个智能体，绑定在建会话时完成、此后不可变，换智能体要**新建会话**。
  留着一个中途可点的控件只会让用户以为能换。
- **前端只记 `agentId`，不记 `agentVersionId`**。哪个版本活跃由服务端在建会话的
  事务内解析；前端缓存 versionId 会在 admin 切版本的瞬间过期。
- `features/chat/useAgentSelection.ts` 持有目录与选择，`shared/api/agents.ts` 是
  `/api/agents` 的封装。目录拉不到时静默降级为空列表——单智能体的既有流程不能
  因为一个新面板的失败而中断。
- 同一次拆分把模型选择挪进了 `features/chat/useModelSelection.ts`：`ChatContext.tsx`
  贴着结构棘轮的行数预算，新增能力要先按职责拆分而不是把它继续撑大。

**`/admin/agents`（仅 admin）** — `pages/settings/AgentsPage.tsx`，管理控制台的「智能体」。
左侧是 org 内的智能体列表（有未保存草稿的显示黄点）与「新建智能体」，右侧是一个编辑器：
顶部固定栏显示「编辑基于 vN」、未保存标记、校验状态和「放弃修改 / 仅保存为新版本 / 保存并启用」，
下方按「基本信息 / 模型 / 工具权限 / MCP / 协作 / 版本历史 / JSON」分页（`AgentConfigEditor` 的 `section`
参数一次只渲染一类，样式在 `agents.module.css`）。工具权限按类别分组（`groupToolsForPermissions`），
每个工具是「继承 / 允许 / 审批 / 禁止」四段选择，可只看已覆盖项；新建智能体复用同一个编辑器。
顶栏显示「N 处未保存修改」（`configDiff`：草稿与启用版本逐字段比较，键顺序不算修改，空对象不算叶子），
保存按钮写出目标版本号（「仅保存为 v4 / 保存并启用 v4」）；「工具权限」「MCP」「协作」tab 上显示覆盖工具数、所选服务数与委派对象数；
版本历史顶部列出「vN → 草稿」的逐字段差异（− 旧值 / + 新值）。版本行显示创建时间；创建者接口未返回，暂不显示。

- 页面反复说明的一件事是**保存 = 建新版本**：`agent_versions` 不可变，编辑配置
  产生下一个版本，旧版本保留；切换活跃版本**只影响新建的会话**，正在跑的 Run 与
  已存在的会话继续用它们钉住的版本。只写"保存"而不解释，用户会以为是原地修改，
  然后困惑于"为什么改了配置老会话没变"。两个按钮因此分开：
  「保存并启用」与「仅保存为新版本」。
- 「回滚」不是一个单独功能，就是在版本历史里激活一个旧版本——无需数据修复。
- 配置编辑器的结构化分页和「JSON」页写入同一份草稿，结构化控件
  只修改它负责的字段，未知字段、旧字段和旧格式仍留在 JSON 中。`modelPolicy`、
  `toolPolicy`、`mcpServers` 与 `delegation` 的形状不合法时，结构化控件暂停，避免一次点击把
  无法理解的配置覆盖掉；当前能力目录不可达时保留已知草稿值，并阻止依赖该目录
  的发布。平台管理的 `skills`、`extensions`、`sandboxPolicy` 与 `a2a` 只显示
  为继承状态，不提供保存后不会影响运行时的假开关。
- 配置校验由 Agent 服务的 `config/options` 与 `config/validate` 提供：选项 DTO 使用
  `schemaVersion`、`fieldSupport`、`platformConstraints`、`capabilityRevision`，
  校验结果必须带 `valid`、字段级 `errors`/`warnings`；有效结果还带
  `normalizedConfig` 与 `effectiveSummary`。警告只提示，不会被当作错误；服务端
  归一化差异在发布前以可展开的对比显示。前端仍把写入即校验作为最终权威。
- 前端为目录、版本请求和草稿校验做了请求代次保护；React StrictMode 的开发期重复
  effect 不会把页面留在 Loading。切换 Agent 或刷新期间，晚到的响应不会覆盖当前
  选择；未提交的草稿按 Agent 暂存。发布和激活携带当前活跃版本的期望值，遇到
  `409` 并发冲突时刷新版本线、保留草稿并要求重新检查。
- 「读不到」和「是空的」在界面上是两件事：MCP 目录 `unknown` 时明说不可用并挡住
  依赖它的修改，不渲染成"零授权"。草稿里启用了、但当前目录已经没有的 MCP 工具仍
  会渲染成一行并标注「当前目录中已没有」，否则那条
  `mcpServers[i].enabledTools[j]` 的错误就没有可以落脚的控件。
- MCP 分类里，已选中的 Server 若在 `MCP_SERVERS_JSON` 声明了宿主参数（`platformConstraints.mcpServers[].hostArguments`），
  卡片下方出现「平台参数」输入框（`McpArgumentFields.tsx`、`mcpArgumentHelpers.ts`），写入 `mcpServers[i].toolArguments`：
  清空即删键、全空删整个对象；原值是数字或布尔时按原类型保存。草稿里有而当前未声明的键显示为「已保留」行、只能移除，
  `toolArguments.<key>` 的错误挂在该行；`toolArguments` 不是对象时该区暂停。模型看不到这些参数，
  工具要求而留空时该工具在对话中不可用。审批卡显示的就是实际发出的参数，不单独标注哪些由平台填入
  （见 [design/mcp-per-agent-arguments.md](design/mcp-per-agent-arguments.md) §9）。
- 「协作」分类（`DelegationFields.tsx`、`delegationHelpers.ts`）编辑 `delegation`：两组勾选，
  同组织智能体（候选即页面的智能体列表，排除正在编辑的智能体自身，非 active 的只能取消）与
  远端 A2A 智能体（候选是 `config/options` 的 `platformConstraints.remoteAgents`，只有
  id / 名称 / 描述，固定标「需审批」）。每行的描述就是进模型系统提示的文本。新勾选追加到末尾，
  清空的名单删子键、全空删整个 `delegation`；草稿里有而候选里没有的名字显示为「已保留」行，只能
  移除，`delegation.<key>[i]` 的错误挂在该行。远端清单只能由运维在 `A2A_REMOTE_AGENTS_JSON`
  登记，页面不提供登记入口。设计见 [design/agent-delegation-config-ui.md](design/agent-delegation-config-ui.md)。
- Thinking level 只列**当前适配器真的接受**的 reasoning effort（`deepseek-official`
  是 `off|low|high|max`）。历史配置里存着不再支持的值时保留原值并标为「不支持」，
  要求改掉后才能发布，不静默降级到别的档位。
- legacy 配置升级到 `schemaVersion: 1` 时，无法映射的模型引用和非空的
  `skills`/`extensions`/`sandboxPolicy`/`a2a` 会阻止发布并列出待处理字段：
  表单与 JSON 往返都不会把它们悄悄删掉。
- config 仍可直接编辑 JSON。解析规则在 `pages/settings/agentHelpers.ts`（纯函数，
  可测）：空文本 = 空配置而不是错误；数组与标量被拒；比较的是**解析后的 JSON
  语义**，对象键顺序不会诱导创建相同内容的新版本，数组顺序仍算配置变化。服务端
  仍会把同一份 config 再校验一遍，前端这层解析只是让用户在按下按钮之前看到语法
  与字段错误。

### 界面结构

设计与分期见 [design/frontend-redesign.md](design/frontend-redesign.md)。

- **侧栏**（`widgets/conversation-sidebar/`）：品牌行 → 图标导航（新建会话 ⌘L、定时任务、产物库；
  定时任务在有新运行结果时显示小圆点：任意任务的 `last_run_at` 晚于本机上次打开定时任务页的时间，
  打开该页即清除，每 5 分钟检查一次；`last_run_at` 只在按计划触发时更新，「立即运行」不算新结果）→ 搜索框（输入即过滤会话）→ 可折叠的「会话」分组，按今天 / 昨天 / 近 7 天 / 更早分组。会话行标注
  所属智能体（组织默认智能体不打标签，颜色按 `agentTone` 固定），运行中蓝点、等待审批黄点，
  分组标题右侧可按智能体筛选。**⌘K 命令面板**（`widgets/command-palette/`）：
  同时搜索会话（本地）、产物（产物库接口，取前 5 条）与操作（新建会话、定时任务、产物库、设置、管理控制台、
  主题切换），↑↓ 选择、Enter 打开、Esc 关闭；产物跳到所在会话，对不上会话时打开产物库。底部账户菜单：设置（打开设置弹窗）、管理控制台（admin，`/admin/*`）、主题切换、退出登录。
  分组、过滤与标签颜色是 `sidebarModel.ts` 里的纯函数。
- **标题栏**（`widgets/conversation-header/`）：会话标题 + 绑定的智能体（组织默认智能体也显示；侧栏才省略 default 标签），
  会话数据带版本号时一并显示；运行中或等待审批时
  显示状态与耗时，中断时给「继续运行」；右侧「资料」按钮开关资料抽屉。
- **资料抽屉**（`widgets/context-inspector/`）：右侧滑出，默认关闭，四个 tab：产物、文件、数据集、
  进程。会话内不再显示 Trace 与工具明细（工具已在对话流内联）。
- **输入框**（`widgets/composer/`）：见下文「键盘快捷键」；「＋」菜单可上传文件或图片，或引用其他
  会话的产物（对话框基于产物库：默认列出全部会话的产物并可按文件名搜索，左侧选会话只是缩小范围；
  `POST /api/conversations/{id}/artifact-imports`，会话开始后可用）；
  待上传图片用本地 blob URL 显示缩略图；历史消息里的图片附件经 `/api/files/download` 显示缩略图（不含 SVG）。
  审批与提问在对话流内处理，输入框只提示当前状态。
- **模型选择**：未选择时按模型目录里标记 `default` 的模型处理（`features/chat/effectiveModel.ts`，优先级：
  智能体版本固定的模型 → 用户所选 → 目录默认），选择器显示「<模型名>（默认）」。附带图片而当前模型不支持
  看图时，输入框直接提示并禁用发送。

- **定时任务**（`/schedules`，`pages/schedules/`）：顶部「定时任务 / 运行」两个 tab 与「新建定时任务」；
  最近 30 天运行条一天一根（成功 / 有失败 / 无运行），数据来自一次 `GET /api/cron-jobs/runs?since=<30 天前本地零点>`（不再逐任务请求）；
  表格列为任务、日程、下次运行、状态，立即运行 / 编辑 / 暂停 / 删除收在 ⋯ 菜单（删除需二次确认）。
  「运行」tab 列出所有任务的执行记录，可打开该次运行产生的会话。新建 / 编辑对话框用频率构造器
  （仅一次 / 每天 / 每周 / 每月 / 自定义 cron）拼出表达式，按任务自己的时区实时预览接下来 3 次
  触发；预览与 Agent 的 cron 语义一致（`scheduleModel.ts`，测试直接对照 Agent 的 `nextCronOccurrence`）。
  一次性任务按所选时区换算成带偏移的 `run_at`。

- **产物库**（`/artifacts`，`pages/artifact-library/`，侧栏「产物库」）：本人所有会话的产物按今天 / 本周 / 本月 /
  更早分组排成网格，「全部 / 文档 / 图片 / 数据」与文件名搜索在服务端过滤（`GET /api/artifacts` 不带
  `session_id`），「加载更多」按游标翻页。图片直接显示缩略图，其余显示类型标签；点开可预览、下载或打开所在会话。
  产物按其记录的沙箱会话 ID 对应到会话标题；MCP facade 提交的产物记录的是 workspace ID，对不上会话时显示
  「其他会话」，下载也可能不可用。

- **设置弹窗**（`widgets/settings/SettingsDialog.tsx`）：个人设置，三个分类。账户：显示名称与邮箱可编辑
  （`/api/auth/profile`，前端先校验、服务端为准，失败时保留草稿），用户名、机构、用户类型、登录方式、账户状态、注册时间、
  最近登录只读；另有退出登录。保存后侧栏里的名称要到下次加载页面才更新（`ChatContext` 已贴着行数预算，
  没有加刷新 `authUser` 的入口）。通用：外观（浅色 / 深色 / 跟随系统）、对话显示
  （紧凑 / 展开：已完成轮次的工具组是否默认展开）、运行中按 Enter（排队追问 / 立即改向）。偏好存在本机
  浏览器（`shared/ui/preferences.ts`，`usePreference` 跨组件实时同步，读不到时用默认值）。我的 Skills：
  上传草稿（.zip / .skill，50 MB）、启用、停用，分层规则复用 `skillHelpers.splitSkillTiers`。

### 路由

| 路径 | 页面 |
|------|------|
| `/`、`/c/:conversationId` | 会话工作台；`/c/<id>` 可直接打开某个会话，新会话发出首条消息后地址自动变为 `/c/<id>` |
| `/schedules` | 定时任务 |
| `/artifacts` | 产物库 |
| `/admin/runs`、`/admin/approvals`、`/admin/agents`、`/admin/capabilities`、`/admin/a2a` | 管理控制台（admin） |
| `/settings/*`、`/runs`、`/approvals` | 旧地址，重定向到对应的 `/admin/*` |

地址与当前会话双向同步（`pages/workbench/WorkbenchPage.tsx`）：地址变化时选中对应会话，建会话、删除
当前会话时更新地址。启动时若地址是 `/c/<id>`，`main.tsx` 先把它写成「上次打开的会话」，由启动恢复加载，
避免与恢复逻辑竞争。

**能力页**（`/admin/capabilities`）：Skills / MCP 服务 / 工具 / 模型 四个 tab，均为可搜索的只读表格；
Skills 可按系统 / 用户筛选，有「所有者」列（接口只返回调用者自己的用户 Skill，所以用户 Skill 的所有者就是当前用户），管理员另有「近 7 天调用」列（`/api/admin/skill-usage`，只统计 `skill` 工具调用；接口不可用时不显示该列），MCP 状态以服务端的 `status` 为准（`capabilityFormat.ts`），模型标注目录默认模型
与看图 / 思考 / 工具调用能力。Extension 诊断已移除；个人 Skill 的上传与启用在设置弹窗里。

**管理控制台**（`app/layout/AdminShell.tsx`）是独立的全屏布局：左侧「返回对话」与分组导航（运维：运行、
审批；配置：智能体、能力、A2A 接入），不显示会话侧栏。非管理员访问时只显示「需要管理员权限」；服务端对
管理接口有同样的角色校验。

**运行**（`/admin/runs`）：全组织的运行，数据来自 `/api/admin/runs*`（见 [API 文档](api.md#管理端运行查询)）。
统计条（今日运行与较昨日、今日失败与失败率、等待审批 / 回答的数量与最久等待、耗时中位数与 P95、近 7 天运行量；
服务端按浏览器本地零点计算）+ 筛选（搜索会话标题 / Run ID / 用户、状态、智能体、时间范围，均在服务端过滤）+
整行可点的表格（状态、会话、用户、智能体与版本、模型、工具与审批数、Tokens、耗时、开始）。「会话」列主文字是这一轮的用户输入
（去掉附件清单、折成一行），下方小字是「会话标题 · 第 N 轮」，同一会话的多轮不会看起来像重复记录；搜索也匹配用户输入，「加载更多」按游标翻页。
Tokens 恒为「—」：Run 账本还没有采集 token 用量。

**运行详情**（`/admin/runs/:runId`）就是 Trace：面包屑、标题（会话标题，副标题「第 N 轮：用户输入」）与状态、取消 / 打开会话 / 复制 Run ID，元信息行，
下分「时间线 / 工具台账 / 进程日志」。时间线左侧是 span 瀑布图（RUN / QUEUE / LLM / TOOL / SUB / WAIT），
右侧是选中节点的内容：模型轮次的思考、输出与工具调用，工具的参数与结果（bash 分 stdout / stderr），
子任务的完整 prompt 与结论，审批等待的决定与耗时。持久 trace 只有元数据且没有模型 span，所以时间线由
`pages/runs/runTimeline.ts` 从该运行的持久事件（`/api/admin/runs/:id/events`）与工具台账按 `toolCallId`
拼接：`message.completed` 结束一个模型轮次；思考取 `thinking.completed` 的全文（`message.completed` 里的
reasoning 可能被截断）；tool-call 部件持久化后只剩 `type`，调用内容取自该轮的 `tool.execution.started`
（DSH 在本轮 `message.completed` 之前发出它）。模型收到的完整 prompt 未持久化，页面上注明。
进程日志列出该运行沙箱会话里的托管进程，可展开日志；沙箱按用户隔离，别人的运行只显示说明。
「取消运行」「打开会话」走所有者接口，只在自己的运行上出现。

**审批**（`/admin/approvals`）：默认显示待审批；每条一张卡片（工具、风险、状态、原因、命令，可展开参数），
待审批的卡片可直接批准 / 拒绝，效果与对话内审批卡相同。

**A2A 接入**（`/admin/a2a`）：右上角切换智能体；上方是端点、Agent Card、认证方式等摘要，下方分「凭据 / 调用记录 /
审计 / 接入示例」。签发后的一次性凭据只显示一次；吊销需要第二次点击确认。

### 消息格式

```javascript
{
  role: 'user' | 'assistant',
  content: [
    { type: 'text', text: '...' },
    { type: 'tool_use', name: 'bash', input: {...}, status: 'running' | 'complete', isError, result },
  ],
  // P7: 交付物优先 artifact download URL
  _fileLinks: [{
    name: 'file.txt',
    url: '/api/files/artifact-download?session_id=...&artifact_id=art_...',
    path: 'file.txt',
    artifact_id: 'art_...',
  }],
  stopReason: 'aborted'  // 仅用户中断时
}
```

## 请求流

### 发送消息

```
用户输入 → Enter / 点击发送
  ↓
sendMessage(text)
  ├── 添加 user 消息
  ├── POST /api/runs，取得服务端 canonical run_id
  │     首轮（conversation_id 为空）同时带上所选的 agent_id——那一轮就是"建会话"

  ├── EntityBridge.beginRun(run_id) + 注册 per-run AbortController
  ├── React 更新 user message / transport UI
  ├── GET /api/runs/:run_id/events（支持 sequence 续传）
  │     ↓ SSE (sse.readSSEStream)
  │     agentEventAdapter -> RuntimeEvent -> runReducer -> EntityStore
  │       trace/session/agent_session → Run + AgentSession 关系
  │       token                    → MessageEntity delta
  │       tool/approval/file_ready → 对应规范化实体
  │       done/error               → 不可被尾随 session_closed 覆盖的终态
  ├── selectors/projectRunMessages
  └── React 最终渲染
```

### 会话切换与中止

- 侧栏选择历史会话只改变 focus；后台 run 和它自己的 fetch controller 继续运行
- 新对话 → 清空 `conversationId`，下次发送创建新会话
- 停止按钮 → EntityBridge 按 active run abort；不会误停其他 conversation 的后台 run

### 文件附件（草稿生命周期）

```
选择/拖拽/粘贴文件（可多选，同名不去重）
  ↓
ensureSession → POST /api/sessions/ensure（创建/复用 Conversation + Session）
  ↓
attachment draft: queued → uploading → uploaded | failed
  ├── POST /api/files/upload?session_id=xxx (+ Idempotency-Key)
  ├── 不自动发送聊天
  └── 可移除 / 失败重试；上传中或失败时禁用发送
      （剪贴板图片没有文件名，按嗅探到的 MIME 命名为 `pasted-image-<时间戳>-<序号>.<ext>`，
        否则扩展名白名单会直接拒收）
  ↓
用户点击发送 → 文本 + attachment manifest 组成同一 user turn
```

### 文件下载（P7 产物唯一交付）

```
file_ready（仅 submit_artifact 成功后）
  ↓
  getArtifactDownloadUrl(sessionId, artifact_id) → 下载 URL
  ↓
render → security.isAllowedApiUrl 校验后生成 <a class="dl" href="/api/...">
```

## 事件绑定

| 事件 | 触发 | 处理 |
|------|------|------|
| 发送消息 | Enter / 发送按钮 | `sendMessage` |
| 中断流 | 停止按钮 | `abortStream` |
| 新行 | Shift+Enter | textarea 默认 |
| 附件 | 按钮 / Ctrl+U / 拖拽 / Ctrl+V 粘贴 | `handleFilesSelected`（后台上传，不自动发送） |
| 新对话 | 侧栏 New chat | `startNewChat` |
| 切换会话 | 侧栏列表 | `selectConversation` |
| 审批 | 对话流内审批卡的「批准 / 拒绝」 | `resolveApproval`；成功后重新接上事件流 |
| 回答提问 | 对话流内提问卡的选项或输入框 | `respondInteraction`；成功后重新接上事件流 |
| 排队追问 / 改向 | 运行中 Enter / ⌘Enter | `followUpRun` / `steerRun` |
| 复制消息 | 气泡下方「复制」（hover 显示） | 剪贴板写入 `messagePlainText(msg)` |
| 重新生成 | 最后一条助手气泡的「重新生成」（仅 idle 时显示） | 取前一条用户回合文本重发 `sendMessage`（纯文本；不重建附件） |
| 回到最新 | 右下角浮标（距底部 >120px 时出现） | smooth 滚动到底 |

- **轮次页脚**：已结束的轮次在末尾显示「耗时 · N 个工具 · N 个子任务」（`turnSummary`），管理员另有
  「在 Trace 中查看」跳到 `/admin/runs/:runId`；tokens 暂无数据来源，不显示。
- **图片附件**：用户消息里的图片缩略图点开在应用内查看大图（`widgets/image-viewer/ImageViewer.tsx`，
  Esc 或点背景关闭，可下载），不再新开标签页。
- **输入框状态行**：运行中在输入框顶部显示「正在运行 / 正在等待审批 / 等待你的回答 · 已运行 N 分 N 秒」；
  计时取运行的开始时间，刚创建还没有时间戳时取本地进入运行态的时刻。

## SSE 事件消费

解析见 `frontend/src/shared/sse/parser.ts`。Agent 发出的是带点号的平台事件（`message.delta`、
`thinking.delta`、`tool.execution.started`、`approval.requested`、`interaction.requested`、
`run.status.changed` 等），经 `platformEventNormalize` 直接进入 reducer；旧的 `token` / `tool_start`
等无点号事件仍由 `agentEventAdapter` 适配。事件契约见 [API 文档](api.md#sse-事件协议) 与
`tests/fixtures/sse_events.json`。

- **实时与刷新走同一个 reducer**：刷新后 `rehydrateConversation` 拉取会话全部持久事件并重放；重放前
  写入 run 行时不带 `last_sequence`，否则持久事件会被判为重复而跳过。
- **游标只记录已应用的位置**：`RunEntity.lastSequence` / `lastEventId` 是本地已应用的最高事件，
  `rehydrateRun` 不采用服务端的 `last_sequence`；未见过的 run 从 0 开始由事件流重放。
- **决定之后续连**：批准 / 拒绝或回答成功后，调用 `rehydrateInProgress` 把事件流重新接到仍在运行的
  run 上（等待期间刷新过页面时原本没有流）；已有连接时 reducer 按序号去重。

## 渲染机制

- React 组件通过 `ChatContext` 订阅规范化 `EntityStore` 与 UI snapshot；运行时实体只有一条写入路径。
- **线性对话流**（`widgets/turn-stream/`）：助手行只要该 Run 在 store 里有消息、工具、审批或仍在运行，
  就由 `TurnStream` 渲染，同一 Run 的其余助手行跳过。`projectTurnItems` 按实体的 `seq`（首次出现的
  事件序号）交错输出：

  | 条目 | 来源 | 呈现 |
  |------|------|------|
  | 思考 | `message.thinking` | 折叠的一行；相邻多段合并 |
  | 文字 | 助手文本段 | Markdown |
  | 工具组 | 相邻的普通工具 | 「读取 1 个文件，运行 2 条命令 · 1.9s」，展开看每步参数与结果；只思考不出文字的中间轮次作为组内步骤并入 |
  | 子任务 | `subagent`、`delegate_to_agent` | 相邻的合成一张卡，行内显示执行者、状态、耗时，展开看任务简述与结论 |
  | 远程委派 | `delegate_to_remote_agent` | 带 A2A 标记的子任务卡；待审批时是专门的审批卡：目标、任务、发送内容，并说明只发送这段文字（不带附件、工作区文件或对话记录，与 `a2a-remote-client` 只发一个文本 part 一致），批准后收起为「已批准 · 远程委派 <目标>」 |
  | 任务清单 | `todo_write` 的 arguments | 放在首次调用处，显示最新清单 |
  | 提问 | `ask_user_question` | 选项卡片；答案来自工具台账，实时作答时卡片先记住本次提交 |
  | 后台任务 | `bash`（`run_in_background`）及其 `job_output` / `job_kill` | 一张卡；按命令与沙箱进程配对，取真实状态与控制台 |
  | 产物 | `submit_artifact` | 文件卡，图片产物在流里显示大图；点卡片或图片在右侧抽屉预览（图片、Markdown 渲染、其他文本前 200 KB，其余类型给下载），抽屉下方列出本会话的其他产物（`ArtifactDrawer.tsx`）；下载经 URL allowlist |
  | 审批 | 审批实体 | 挂在对应工具条目后；审批先于工具到达时，工具名保留在 `approval.command` |

- DSH 的 `message.*` / `thinking.*` 不带 message_id：一轮是 thinking.delta… → message.delta… →
  thinking.completed → 工具 start → message.completed，下一轮以新的 thinking.delta 开始。没有流式
  消息时，thinking 开启新消息段，不追加到上一轮。
- 只识别 DSH 出厂工具名（判定与 todo 解析在 `features/chat/projections/turnFields.ts`）；旧引擎的
  `spawn_subagent`、`ask_user` 与 memory 卡片已随存量历史清理移除，这类调用会按普通工具显示。
- Markdown 通过 `react-markdown` + `rehype-sanitize` 渲染（`widgets/markdown/Markdown.tsx`）；链接只允许
  http(s) 与同源 `/api/`。

## 测试

```bash
npm test --prefix frontend          # node:test + tsx — test/**/*.test.ts
npm run build --prefix frontend     # 生产构建（CI 同款）
```

覆盖：SSE 分片/abort/错误、会话切换与 generation、URL/HTML 注入防护、基础 a11y 语义。

## 主题

暗色、亮色或跟随系统：`ThemeProvider` 读取 `theme` 偏好（沿用旧的 `app-theme` 存储键），跟随系统时监听
`prefers-color-scheme`，通过 `[data-theme]` 切换；入口在设置弹窗与账户菜单。
配色为中性灰加钴蓝（`shared/ui/tokens.css`），智能体标签用 `--agent-tone-0..5` 六个固定色槽。
内网部署无法加载外部字体，只用系统字体栈。新组件样式用 CSS Modules（`*.module.css`），
`shared/styles/app.css` 只保留仍被引用的旧样式。

## 键盘快捷键

| 快捷键 | 操作 |
|--------|------|
| `Enter` | 空闲时发送；运行中按设置排队追问（默认）或立即改向；等待回答时提交回答（输入法组合期间不触发） |
| `Ctrl+Enter` / `Cmd+Enter` | 运行中执行与 Enter 相反的动作（默认为立即改向） |
| `Ctrl+K` / `Cmd+K` | 打开命令面板（搜索会话、产物与操作） |
| `Shift+Enter` | 换行 |
| `Ctrl+U` / `Cmd+U` | 打开文件选择器上传（Run 运行中与按钮一致被禁用） |
| `Ctrl+V` / `Cmd+V` | 粘贴剪贴板里的图片/文件为附件（同一道 Run 运行中门禁）；剪贴板只有文本时不拦截，正常落进输入框 |
| `Ctrl+L` / `Cmd+L` | 新建会话 |

消息日志区域显式声明 `aria-live="off"`：`role="log"` 本身隐式携带 polite live
region，而流式 token 是在已有文本节点上追加（落在默认 `aria-relevant` 的 `text`
范畴内），不显式关掉就会让读屏逐 delta 重读整段 transcript。Run 状态变化由
FlashZone（`role="status"` + `aria-live="assertive"`）统一播报。
