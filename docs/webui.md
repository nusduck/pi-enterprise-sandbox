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

Runtime 状态只写 `EntityStore`：Run、增量 Message、Tool、Process、Approval、Artifact 和 trace 都由 `platformEventNormalize -> runReducer` 单次归约。`ChatState` 不含 `currentMsg`、
`pendingTool`、`pendingApproval` 或 `readyFiles`，只保存服务端历史快照、选择状态、上传草稿、布局、
认证与 transport 控制。`activeRunId` 直接从 EntityStore 读取，不维护 React 镜像 state。

### Capabilities / Skills 与 Drafts 上传

`/settings/capabilities` 的 Skills 页按当前登录用户投影三层：Drafts、My Skills、System Skills。
- **Drafts 上传**：在 Drafts 区域提供专属拖拽与点击上传卡片，支持用户直传 `.zip` 与 `.skill` 归档包（单包上限 50MB）。上传成功后包自动落入用户草稿根目录并即时在 Drafts 列表中以 `Draft` 状态卡片呈现。上传瞬间**不自动启用**。
- **人机闸门**：草稿卡片提供高亮 **Enable** 按钮；点击后平台校验结构、按内容摘要发布一份只读版本至用户已启用根，并写入 MySQL 账本；My Skills 按账本列出核对通过的已启用用户 Skill 并提供 **Disable** 按钮；系统 Skill 为只读不可变更。
- **启用后草稿不再重复列出**：启用是**复制字节**，草稿本身留在草稿根（停用只删账本行，已发布字节留给仍在运行的 Run，过宽限期回收）。Agent 因此给已发布过的草稿打 `published: true`，Drafts 区只列 `published !== true` 的那些——否则同一个包名会在页面上出现两次，而且草稿那张卡还带着一个按了也没有新效果的 Enable。My Skills 里对应的卡片显示 `from draft` 小标签；要重新发布改过的草稿，先 Disable，草稿会回到 Drafts。分层规则在 `pages/settings/skillHelpers.ts`（纯函数，可测）。
- **三层卡片同构**：Drafts / My Skills / System Skills 共用 `SkillCards`，同一张 meta 表（Source / Enabled / Dynamic），操作按钮统一收在卡片底部的 `.mgmt-card-actions` 行里靠右对齐。卡片是 flex-column，直接把 `<button>` 放进去会被拉伸成整行宽的大色块，草稿卡因此和系统卡不是一个形状。
- **Composer 拼图按钮移除**：取消了聊天输入框原本的拼图安装按钮，Skill 安装全面收敛至 Capabilities 页面。

### 交付策略（智能体配置页）

智能体配置页新增「交付策略」分类（`pages/settings/DeliveryPolicyFields.tsx`，纯函数在
`deliveryPolicyHelpers.ts`）：两个单选——直接交付 / 交付物需人工审核。两条容易写错的规则：

- 选 `direct` 时**删掉整个 `deliveryPolicy` 键**：contract 的「省略即 direct」是既有版本
  `config_hash` 不变的保证，写回 `{ "mode": "direct" }` 会平白改掉哈希；
- 结构不对（`deliveryPolicy` 不是对象、`mode` 不是字符串）时**暂停这个分类**，让用户去 JSON 修，
  而不是覆盖掉原值；选 review 且草稿里配了委派时给出「服务端会拒绝」的联动提示。

### 多 Agent 选择

一个 org 下可以并列存在多个智能体，用户在**建会话**时选一个。

- **智能体选择采用 chip + Popover 形态**（`widgets/composer/AgentPicker.tsx`）：
  在 Composer 工具栏左侧渲染 32px 胶囊 chip（包含固定音调 `agentTone` 首字头像 + 名称 + 下拉箭头），与模型选择之间以竖分隔线隔开。
  - 点击打开 Popover 浮层：候选 > 6 个时顶部显示过滤搜索框；每项展示「头像 / 名称 / 默认徽标 / 描述 / 选中勾」；底部固定提示「会话开始后智能体不可更换」。
  - 键盘：打开时焦点移入浮层（有搜索框给搜索框，否则给当前选中项）；↑/↓/Home/End 在选项间移动；Esc 关闭（焦点在 chip 上也生效）并把焦点还给 chip；点外部关闭不抢焦点（`shared/ui/Popover.tsx`、`popoverFocus.ts`）。
  - **单智能体时显示不可点 chip**：组织内只有 1 个可用智能体时，chip 仍正常渲染展示当前智能体身份，但省略下拉箭头且禁用点击交互。
  - **会话开始后变为只读**：一旦产生了 `conversationId`（会话已建立），chip 自动转为只读标签形态（遵守 multi-agent-selection D2 绑定不可变原则），换智能体必须**新建会话**。
  - **新会话欢迎区联动**：未发送首条消息时，MessageList 欢迎区域动态展示当前所选智能体的头像、名称及描述。
- **默认项去重**：目录里的「通用智能体」与默认占位项合并为「通用智能体（默认）」；
  选择它仍使用空值，由服务端解析租户默认智能体。定时任务的智能体选择复用同一规则。
- **前端只记 `agentId`，不记 `agentVersionId`**。哪个版本活跃由服务端在建会话的
  事务内解析；前端缓存 versionId 会在 admin 切版本的瞬间过期。
- **可见范围**：选择器只列服务端返回的智能体，受限且未授权的不会出现（判定在服务端，
  前端不做过滤）。admin 在「管理控制台 → 智能体」的「可见范围」标签设置全员可用 / 指定员工：
  按工号或姓名搜索成员添加到名单，保存即生效、不生成新版本；默认智能体只能全员可用；
  列表里受限的智能体带「指定」标记（`pages/settings/AgentAccessPanel.tsx`）。
- `features/chat/useAgentSelection.ts` 持有目录与选择，`shared/api/agents.ts` 是
  `/api/agents` 的封装。目录拉不到时静默降级为空列表——单智能体的既有流程不能
  因为一个新面板的失败而中断。
- 同一次拆分把模型选择挪进了 `features/chat/useModelSelection.ts`：`ChatContext.tsx`
  贴着结构棘轮的行数预算，新增能力要先按职责拆分而不是把它继续撑大。

**`/admin/agents`（仅 admin）** — `pages/settings/AgentsPage.tsx`，管理控制台的「智能体」。
左侧是 org 内的智能体列表（有未保存草稿的显示黄点）与「新建智能体」，右侧是分组导航编辑器：
- **左侧分组导航**：横向 tab 收敛为左侧 5 个逻辑分组（`navGroups`）：
  - 基础：基本信息、模型
  - 能力：技能、工具权限、MCP、数据源
  - 协作与交付：协作、交付策略
  - 发布：可见范围、版本历史
  - 高级：JSON
- **未保存标记（黄点）**：某分区内有未保存修改时，对应导航项右侧显示黄色提示圆点（`dirtyDot`）。
- **底部固定保存栏**：保存操作从页头收敛到底部吸底工具栏（`saveBar`）。有修改时显示「N 个分区有未保存修改」以及「放弃修改 / 仅保存为 vN / 保存并启用 vN」；无草稿修改时自动隐藏；新建草稿时提供取消与创建入口。
- 工具权限按类别分组（`groupToolsForPermissions`），每个工具是「继承 / 允许 / 审批 / 禁止」四段选择，可只看已覆盖项；新建智能体复用同一个编辑器。
- 版本历史顶部列出「vN → 草稿」的逐字段差异（− 旧值 / + 新值）。版本行显示创建时间；创建者接口未返回，暂不显示。

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
  的发布。
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
- 「数据源」分类（`DataSourceFields.tsx`、`dataSourceHelpers.ts`）编辑 `dataSources`：从 config-options 的
  `platformConstraints.dataSources` 勾选（只显示名称、id、说明、引擎），写成 `[{ id }]`，清空时删键；
  草稿里有而目录里没有的 id 显示为「已保留」行，只能移除，`dataSources[i]` 的错误挂在该行；结构不合法时暂停该分类。
  目录由运维在 `SANDBOX_DATA_SOURCES_JSON` 登记，页面不提供登记入口。设计见
  [design/sandbox-data-sources.md](design/sandbox-data-sources.md)。
- 「技能」分类（`SkillPolicyFields.tsx`、`skillPolicyHelpers.ts`）编辑 `skillPolicy`（ADR 0015，设计见
  [design/skill-catalog-and-agent-binding.md](design/skill-catalog-and-agent-binding.md)）：三层分开呈现——
  系统层选「全部 / 只选这些 / 不带」（选「只选这些」时从 config-options 的
  `platformConstraints.skills.system` 勾名字）、组织共享层从 `platformConstraints.skills.org` 勾名字并**钉住一个版本**
  （不跟随最新：同一个 AgentVersion 在不同时间必须行为一致）、用户层是一个「带上调用者自己启用的技能」开关。
  字段错误按路径挂到对应控件（`skillPolicy.system.names[i]`、`skillPolicy.org[i].contentDigest`）。
  三个刻意的行为：**没设过这个键时页面照实说「未设置」**，不冒充默认值；保存结果与「省略」等价时**删掉整个键**
  （写回一个等价对象会改变既有版本的 `config_hash`）；`allowlist` 之外**不写 `names`**（服务端对「非 allowlist 带 names」
  报错，不许静默忽略）。名单里已不在当前 release 的名字标为「不在当前平台」而不是静默丢掉。结构不合法时暂停该分类。
- Thinking level 只列**当前适配器真的接受**的 reasoning effort（`deepseek-official`
  是 `off|low|high|max`）。历史配置里存着不再支持的值时保留原值并标为「不支持」，
  要求改掉后才能发布，不静默降级到别的档位。
- legacy 配置升级到 `schemaVersion: 1` 时，无法映射的模型引用会阻止发布并列出待处理字段：
  表单与 JSON 往返都不会把它们悄悄删掉。`skills`/`extensions`/`sandboxPolicy`/`a2a`
  已从 schema 移除，出现即按未知字段报错。
- config 仍可直接编辑 JSON。解析规则在 `pages/settings/agentHelpers.ts`（纯函数，
  可测）：空文本 = 空配置而不是错误；数组与标量被拒；比较的是**解析后的 JSON
  语义**，对象键顺序不会诱导创建相同内容的新版本，数组顺序仍算配置变化。服务端
  仍会把同一份 config 再校验一遍，前端这层解析只是让用户在按下按钮之前看到语法
  与字段错误。

### 界面结构

设计与分期见 [design/frontend-redesign.md](design/frontend-redesign.md)。

- **侧栏**（`widgets/conversation-sidebar/`）：品牌行 → 图标导航（新建会话 ⌘L、定时任务、产物库、交付物审核——最后一项只在 `me.roles` 含 `reviewer` 时出现；判定在服务端，前端只是不引导)；
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
  进程。会话内不再显示 Trace 与工具明细（工具已在对话流内联）。**审核会话（`delivery_mode: "review"`）
  不显示「文件」与「进程」两个页签**，并写明原因（这两个通道在服务端都会 404——E5 工作区字节、E6 进程日志；
  不关的话发起人能绕过审核读到源文件），隐藏而不解释会让人以为文件丢了。
  其他会话里进程列表**拉取失败显示错误态**（404/5xx 与服务端真的返回空列表是两回事，
  `processPanelState` 的四态判定在 `entities/store.ts`），不会渲染成「这个会话还没有后台进程」。
- **进程控制台**（`widgets/process-console/`）：从后台任务卡片或资料抽屉「进程」页签打开。
  打开即加载日志（保留 offset 续读）；进程运行中每 2 秒增量轮询日志并请求 `GET /api/processes/{id}` 刷新状态；
  进入终态后自动停止轮询，关闭或切换进程时清理定时器。发送 signal / cancel / stdin 之后立即重新查询状态与日志，
  并将新状态写回实体 store 使对话流与抽屉卡片同步。取消操作采用应用内「确认取消？ 确认 / 返回」内联确认，无原生弹窗；全界面中文。
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
  一次性任务按所选时区换算成带偏移的 `run_at`。新建 / 编辑表单另有「完成后通知」下拉
  （不通知 / 仅失败时（默认）/ 每次，对应 `notify_policy`），发到任务所有者的邮箱；列表与卡片上不展示该字段。

- **产物库**（`/artifacts`，`pages/artifact-library/`，侧栏「产物库」）：本人所有会话的产物按今天 / 本周 / 本月 /
  更早分组排成网格，「全部 / 文档 / 图片 / 数据」与文件名搜索在服务端过滤（`GET /api/artifacts` 不带
  `session_id`），「加载更多」按游标翻页。图片直接显示缩略图，其余显示类型标签；点开可预览、下载或打开所在会话。
  产物按其记录的沙箱会话 ID 对应到会话标题；MCP facade 提交的产物记录的是 workspace ID，对不上会话时显示
  「其他会话」，下载也可能不可用。

- **设置弹窗**（`widgets/settings/SettingsDialog.tsx`）：个人设置，三个分类。账户：显示名称、邮箱与「邮件通知」
  小节的四个开关（运行完成、审核结果、定时任务等待处理、待我审核——最后一个只对持有 reviewer 角色的用户显示）
  可编辑（`/api/auth/profile`，校验在 `widgets/settings/accountDraft.ts`，前端先校验、服务端为准，失败时保留草稿；
  服务端 `notifications.email.available` 为假时开关禁用并提示「部署未配置邮件发送」，已打开的仍可关掉；打开任一开关必须保留邮箱，
  服务端的 `NOTIFY_EMAIL_REQUIRED` / `NOTIFICATION_UNAVAILABLE` 显示在开关下方），用户名、机构、用户类型、登录方式、账户状态、注册时间、
  最近登录只读；另有退出登录。保存后侧栏里的名称要到下次加载页面才更新（`ChatContext` 已贴着行数预算，
  没有加刷新 `authUser` 的入口）。通用：外观（浅色 / 深色 / 跟随系统）、对话显示
  （紧凑 / 展开：已完成轮次的工具组是否默认展开）、运行中按 Enter（排队追问 / 立即改向）。偏好存在本机
  浏览器（`shared/ui/preferences.ts`，`usePreference` 跨组件实时同步，读不到时用默认值）。我的 Skills：
  上传草稿（.zip / .skill，50 MB）、启用、停用，分层规则复用 `skillHelpers.splitSkillTiers`。
  每个**已启用**的 Skill 上还有一个「申请共享」（ADR 0015 §7.2/§7.3）：点了就对该版本发起申请并钉住摘要，
  等本 org 管理员处理；同名已有一条 `pending` 时按钮变成「申请中」并禁用——再点一次会把旧申请置为
  `superseded`，那会让「我上次写了什么说明」无声消失。下方「我的共享申请」列出自己的申请与状态，
  `pending` 的可撤回。可操作的拒绝原因就地显示（`SKILL_NAME_RESERVED_BY_ORG` → 说明这个名字已被组织共享层
  占用；`SKILL_NOT_ENABLED` → 只有已启用的版本才能申请），不是一句「操作失败」。申请列表接口不可用时
  显示「申请列表现不可用」，而不是「还没有提交过共享申请」——后者会让人以为申请丢了。

### 路由

| 路径 | 页面 |
|------|------|
| `/`、`/c/:conversationId` | 会话工作台；`/c/<id>` 可直接打开某个会话，新会话发出首条消息后地址自动变为 `/c/<id>` |
| `/schedules` | 定时任务 |
| `/artifacts` | 产物库 |
| `/reviews` | 审核工作台（持有 `reviewer` 角色时主导航出现入口；非 reviewer 打开会拿到 403 `REVIEWER_REQUIRED`） |
| `/admin/runs`、`/admin/approvals`、`/admin/agents`、`/admin/capabilities`、`/admin/skills`、`/admin/a2a`、`/admin/members` | 管理控制台（admin） |
| `/settings/*`、`/runs`、`/approvals` | 旧地址，重定向到对应的 `/admin/*` |

地址与当前会话双向同步（`pages/workbench/WorkbenchPage.tsx`）：地址变化时选中对应会话，建会话、删除
当前会话时更新地址。启动时若地址是 `/c/<id>`，`main.tsx` 先把它写成「上次打开的会话」，由启动恢复加载，
避免与恢复逻辑竞争。

**能力页**（`/admin/capabilities`）：Skills / MCP 服务 / 工具 / 模型 四个 tab，均为可搜索的只读表格；
Skills 按**三层**筛选（系统 / 组织 / 用户）并显示来源与「所有者」列：组织共享层列出本 org 已发布的
`active` 版本（`org-skill-root`，所有者显示「本组织」），用户层只返回调用者自己的 Skill，所以所有者
就是当前用户，草稿单独标注「草稿 / 已发布」；管理员另有「近 7 天调用」列（`/api/admin/skill-usage`，
只统计 `skill` 工具调用，接口不可用或字段不合法时不显示该列），悬停显示按层拆分的明细，
MCP 状态以服务端的 `status` 为准（`capabilityFormat.ts`），模型标注目录默认模型
与看图 / 思考 / 工具调用能力。Extension 诊断已移除；个人 Skill 的上传、启用与共享申请在设置弹窗里。

**Skill 共享**（`/admin/skills`）— `pages/settings/SkillAdminPage.tsx`，两个 tab（ADR 0015 §7.1/§7.2）：

- **共享申请**：本 org 的申请队列（默认只看「待处理」，可按状态筛），每张卡是一个被申请的版本——
  用户、名字、摘要、申请说明与时间；「查看清单」在原生模态弹窗展示该版本的文件清单与截断的 `SKILL.md`
  （这是管理员批准前唯一能看到的东西，不看作者的其他 Skill）。批准可同时把该版本设为
  「当前推荐版本」；驳回必须填写原因（没有原因的驳回在审计里等于没解释），输入为空时按钮禁用。
  **批准失败时申请保持「待处理」且这一行不消失**：失败原因（摘要不一致、源缺失、名字被别的作者占用）
  就地报出来，管理员可以再点一次。读取队列失败**不显示成空队列**——那看起来像「没人申请」。
- **组织共享层**：本 org 每个共享名字的版本表（摘要前缀、状态、发布时间、当前指针），
  可「设为当前」（不影响任何已钉住的 AgentVersion）、「弃用」（只挡新绑定）、
  「吊销」（安全动作，立即影响新 Run 的解析；确认弹窗内先填原因）；「清单」在原生模态弹窗展示某个版本的
  文件清单与 `SKILL.md`，以及引用此版本的智能体版本。吊销处理中禁止按钮、Esc 和遮罩关闭；失败时在弹窗内报错并保留原因供重试，空闲时可以关闭。
  吊销成功后展示完整受影响版本集合，支持搜索、每页 10 条和复制全部 ID；分页不代表数据截断，不依据集合条数推断截断。
  顶部可直传 `.zip` / `.skill`（≤50MB）发布新版本，可选同时设为当前推荐版本。
  发布后页面明确提示要去「智能体」的版本配置里引用具体版本，否则没有 Agent 会带上它。

**管理控制台**（`app/layout/AdminShell.tsx`）是独立的全屏布局：左侧「返回对话」与分组导航（运维：运行、
审批；配置：智能体、能力、Skill 共享、A2A 接入），不显示会话侧栏。非管理员访问时只显示「需要管理员权限」；
服务端对管理接口有同样的角色校验——页面隐藏只是不让人撞上死路，不是权限边界。

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

**成员与角色**（`/admin/members`）— `pages/settings/MembersPage.tsx`，管理控制台「配置」分组下：
本 org **已开通**成员账号的表格——成员（显示名为主、用户名为辅）、部门（空值显示「—」）、最近登录、「管理员」/「审核员」
两个开关（列头、筛选页签与变更记录都显示中文角色名，原始代码 `admin` / `reviewer` 放在悬停提示里）。
名单来自成员关系（`memberships`），**不是**「登录过的人」：脚本或部署引导创建、还没走过平台登录的
账号 `last_login_at` 是空，界面显示「—」并带 tooltip 说明，页面说明文字与这个口径一致。
工具栏支持按用户名/显示名搜索与按角色筛选，`next_cursor` 走「加载更多」。
开关**先乐观更新**，失败回滚并显示服务端原因的中文提示（`LAST_ADMIN` →「不能撤销本组织的最后一个管理员」；
`ROLE_PINNED_BY_DEPLOYMENT` →「该管理员由部署锁定，不能撤销」）。`pinned_roles` 里的开关置灰，
tooltip 说明是 `SANDBOX_AUTH_ADMIN_USERNAMES` 锁定。**列表加载失败显示错误态**（附重试），
不会渲染成「无成员」；空态与错误态是两个分支（`pages/settings/memberRoles.ts` 的纯逻辑 + 单测）。
撤销**自己**的 `admin` 要二次确认，成功后重读 `me`，AdminShell 的 `isAdmin` 闸门随即变 false，
界面退出管理控制台。「变更记录」按钮拉 `/api/admin/users/{userId}/role-events` 并用右侧抽屉展示
（按时间倒序；授予/撤销、来源中文化、操作者显示名 → 用户名 →「系统」）。角色权威在服务端，页面只是投影。
**≤900px 换成卡片式行**（表格 `display: none`，不产生重复控件）：768px 下管理控制台侧栏仍占
约 240px，内容区放不下 5 列，「操作」会被挤出屏幕、按钮竖排撑高整行。表格与卡片共用
`MemberIdentity` / `MemberLastLogin` / `RoleCell`，不各写一份。关闭态开关用
`--color-text-muted` 做边界、`--color-text-secondary` 做滑块（浅色下原来的 rgba(0,0,0,0.08) 边界
+ 纯白滑块几乎看不见，非文本对比度不足 3:1）。

**审批**（`/admin/approvals`）：默认显示待审批；每条一张卡片（工具、风险、状态、原因、命令，可展开参数），
待审批的卡片支持展开填写可选的原因输入（限制 ≤2000 字，超长禁用提交；提交失败保留草稿并展示错误），批准 / 拒绝效果与对话内审批卡相同；已决定的审批在列表与卡片上展示决策原因。

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
  │     platformEventNormalize -> RuntimeEvent -> runReducer -> EntityStore
  │       run.accepted/started/…       → Run 生命周期与身份（agentSessionId / conversationId）
  │       message.delta/completed      → MessageEntity
  │       tool.execution.* / approval.* / artifact.ready → 对应规范化实体
  │       artifact.released / review.rejected → 交付物审核结论（挂在原 Run 上，刷新重放同样拿到）
  │       run.completed/failed/cancelled → 终态
  │     （只认平台事件：带持久序号与 event_id 的点分类型；无法规范化的帧直接丢弃）
  ├── projections/projectConversationMessages（用户行 + 每个 Run 一个助手行）
  └── React 最终渲染（助手行的正文一律由 TurnStream 从 EntityStore 渲染）
```

### 消息区的唯一渲染路径

`ChatState.messages` 只保存用户回合（服务端历史 + 乐观发送）；服务端转录里的 assistant 行、
`thinking` 字段不进前端状态。每个 Run 恰好对应一个助手行，其思考、文本、工具、审批、产物
全部由 `TurnStream` 从 EntityStore 按事件顺序渲染，失败原因（`run.error`）与「运行已中断」
也来自 Run 实体。不存在「转录气泡 → 时间线」的二次切换，也不再有按文本/序号猜测合并
转录行与实时投影的逻辑。创建 Run 只发送当前用户回合（服务端只取最后一条用户消息）。

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

### 交付卡片三态（交付物审核）

AgentVersion 的 `deliveryPolicy.mode = "review"` 时，交付物先进入审核池，卡片按 `reviewStatus`
显示三态，**投影在 `widgets/turn-stream/artifactView.ts`（纯函数，可单测）**：

| `reviewStatus` | 卡片 | 有没有下载 URL |
|---|---|---|
| `pending` | 「已提交审核」+ 一句「审核通过后可下载」 | **没有**——服务端本来 404（E2），留着按钮等于引导用户点一个必然失败的链接 |
| `rejected` | 「未通过审核：<反馈>」 | **没有** |
| `released` | 「已交付」/「已交付 · 经审核员修订」 | 有 |
| `null`（direct 会话） | 不显示审核字样，与以前完全一致 | 有 |

修订后放行时卡片显示**修订版**的大小与下载地址：`artifact.released` 负载里的 `size` 会写回实体，
下载 id 用 `reviewReleasedId`（原件已 `withdrawn`，拿原件 id 拼链接必然 404）。

**三个渲染点都要按状态挡下载**（漏一个就会出现「卡片说待审、chip 却能下载」）：
对话流卡片（`TurnCards`）、产物抽屉的 chip（`DeliverablesPanel`，待审/驳回渲染成状态 chip 而不是链接）、
产物面板（`ArtifactPanel` 沿用既有的「暂不可下载」分支）。

事件侧：`artifact.created` 读 `artifact.ready` 负载里的 `review_status`；放行与驳回分别由
`artifact.released` / `review.rejected` 归约（事件挂在**原 Run** 上）。

**Run 终态后审核结果怎么到达**（T1）：Run 一到终态，Run SSE 就关了，而放行/驳回事件是审核员
之后才追加到这个已结束 Run 上的。所以只要当前会话里还有 `reviewStatus === 'pending'` 的交付物，
前端每 20 秒调一次 `entityBridge.pollReviewDecisions(conversationId)`——**只拉一次会话事件、
只归约 `artifact.released` / `review.rejected`**（不碰 `rehydrateRun` / `listRunTools` /
`loadDurableTrace` / `connect`，20 个 Run 的会话不会每轮发 40 多个请求，也不会重放正在流式的 Run）。
可见性迁移在 `features/chat/reviewResultPolling.ts` 的 `createReviewResultPoller`：**只要还有待审
交付物就装 `visibilitychange` 监听**（不能因为此刻不可见就整体不注册，否则「发起任务 → 切走 →
后台结束 → 切回来」永远不会开始轮询），切回前台立即拉一次，没有待审交付物或组件卸载时停表。

**审核工作台**（`/reviews`，`pages/reviews/`）：列表分待领取 / 我领取的 / 历史（游标分页；
历史传 `status=APPROVED,REJECTED` 多值，不再列出待领取与审核中的任务）。
列表行以**交付物名**（多件时「首件名 等 N 件」）与**智能体名**区分任务，列头是
「交付物 / 智能体 / 发起人 / 状态 / 运行结果 / 提交时间」。
三态**错误优先**——加载失败显示错误与重试，绝不渲染成「没有待审任务」（与 `RunsPage` 同一套
空态/错误态样式）；详情标题用交付物名或「智能体名 · 发起人」，任务 ID 降级为可复制的小字；
详情给出提问（触发本次的那条标「本次」，更早的收进可折叠的「上文」）与附件清单、
材料快照（`snapshot_status = unavailable` 时明确提示）、交付物版本链（「版本 / 上传者 / 时间 / 大小 / 下载」，
artifact ID 收进悬停提示；非当前版本的大小来自 exec 的元数据端点，取不到显示「—」）与审计时间线
（事件详情按类型格式化，未知结构不显示 JSON）。
动作是领取 / 释放 / 上传修订（原始字节 body）/ 通过 / 驳回（反馈必填，与 422 `REVIEW_FEEDBACK_REQUIRED` 对齐）。
任务状态与交付物状态共用同一套颜色语义（`reviewStatusTone` / `deliveryTone`：通过/已交付同色，
驳回/未通过同色）；详情面板吸顶并可独立滚动，长列表里点下面的行不必滚回顶部。
两栏布局是 `minmax(0, 1fr) minmax(420px, 0.95fr)`，**≤1200px 单栏**：详情要放得下版本表的 5 列，
窄屏下两个 `minmax` 的下限会把面板顶出视口。详情里的表格单元格一律 `white-space: nowrap`
（否则「下载」会竖排成「下 / 载」）。**审核面的时间一律是带 `Z` 的 ISO**（`formatDateTime`），
列表/详情/审计时间线与版本表显示同一种本地时间。
**409 版本冲突刷新任务但保留已选择的待上传文件**；错误码到中文的映射在 `pages/reviews/reviewErrors.ts`。

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
`run.status.changed` 等），经 `platformEventNormalize` 直接进入 reducer；没有持久序号 / `event_id` 的
旧式事件（`token`、`tool_start` …）不再被适配，直接丢弃。事件契约见 [API 文档](api.md#sse-事件协议)，
真实线上帧回放见 `frontend/test/fixtures/live-run-sse.json`。

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
  | 产物 | `submit_artifact` | 文件卡（审核会话里按三态显示，见上文「交付卡片三态」），图片产物在流里显示大图；点卡片或图片在右侧抽屉预览（图片、Markdown 渲染、其他文本前 200 KB，其余类型给下载），抽屉下方列出本会话的其他产物（`ArtifactDrawer.tsx`）；下载经 URL allowlist |
  | 审批 | 审批实体 | 挂在对应工具条目后；审批先于工具到达时，工具名保留在 `approval.command`；决策时可展开填写可选原因（≤2000 字，超长禁用提交，失败保留草稿），已决定的审批展示原因 |

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

### 登录页与身份边界（独立路由 `/login`）

登录表单全面移出侧栏，新增独立全屏路由 `/login`。未登录时访问受保护页面自动重定向到 `/login?return_to=<当前路径>`（未登录状态下不渲染会话侧栏）；已登录状态访问 `/login` 则自动回跳 `return_to`（仅放行以 `/` 开头且不以 `//` 或 `/\` 开头的站内相对路径，严格防范开放重定向）或主页 `/`。

页面左栏为深色品牌与能力展示区（窄屏 <900px 自动隐藏），右栏为 380px 的居中表单卡片。按 `GET /api/auth/config` 投影三种认证形态：
- **SSO 开启且可用**：主入口为 44px 品牌蓝「使用公司 SSO 登录」大按钮（整页跳转至 `/api/auth/sso/login?return_to=<路径>`）；账号密码收起为次要按钮「管理员账号登录」，点击后就地展开本地登录表单。
- **SSO 开启但暂不可用**：主按钮置灰禁用并标注「SSO 暂不可用」，本地账号密码表单默认展开。
- **仅本地登录**：直接展示用户名/密码表单；若服务端开启 `registration_enabled`，则同时展示注册入口。

表单遵循无障碍规范：`<label>` 标签在上、密码输入框支持显示/隐藏明文与原生自动填充（`autocomplete`）；提交错误展示在密码框下方（`role="alert"`）；SSO 回调失败带回的 `?sso_error=` 转为固定中文错误并展示在表单顶部，随后从地址栏剥除（不回显 URL 原始文本）。`me` 401 时自动重新进入登录；503/网络故障提示认证服务不可用并保留用户草稿与当前状态。
账户页从 profile.login_method/identity_provider 显示来源，editable_fields 仍决定编辑权。

成功切号与退出清空旧身份的流、实体、附件、选中会话和目录，过期响应由身份代次丢弃。
退出失败仍完成本机清理，持续提示“本机已退出，服务端会话撤销未确认”，不自动拿当前 Cookie 重试。
退出不取消正在运行的任务。旧无 sid 会话在升级后失效，需重新登录。

### 版式规范与列表分页（`shared/ui/`）

全站一级页面与管理端遵循统一的设计定稿与共享组件体系（`frontend/src/shared/ui/`）：
- **组件规范**：`PageLayout`（统一样式骨架与左对齐）、`PageHeader`（标题/说明/操作）、`Toolbar`（工具栏控件 12px 间距）、`SegmentedControl`（分段筛选）、`StatusBadge`（状态徽标）、`EmptyState`（empty/error/forbidden 三态）、`FormField`（上标签 16px 间距）、`Popover`（锚定弹层与键盘交互）。
- **增量流式加载（`LoadMoreSentinel`）**：
  - 会话侧栏：首屏拉取 30 条，滚动触底（200px 阈值）由 `LoadMoreSentinel` 自动增量拉取下一页；以 `conversation_id` 去重；新建或有新消息更新的会话即时 unshift 移至列表顶部。
  - 侧栏搜索：输入 250ms 防抖打服务端 `q` 模糊检索，带代次（`searchGenRef`）丢弃乱序过期响应，搜索结果支持增量加载；清空搜索即时恢复完整会话列表。
  - 产物库：网格底部使用 `LoadMoreSentinel` 增量加载下一页，空状态与异常状态统一收敛。
- **管理表格游标分页（`Pager`）**：
  - 运行管理、审批中心、成员与角色、交付物审核、Skill 共享申请队列、定时任务列表接入基于游标的 `useCursorPagination` 与 `Pager`（显示「第 N 页 · 本页 M 条」、每页条数选择及上一页/下一页）。
  - 组件内部维护游标历史栈（`cursorStack`）以可靠支持「上一页」回溯；切换筛选条件或触发搜索时重置分页至第 1 页。
- **能力页前端分页**：
  - Skills / MCP Server / 工具 / 模型目录属于单租户静态集合，采用每页 25 条的前端纯分页（与当前关键字过滤联动，搜索词变化时重置回第 1 页）。

