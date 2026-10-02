# UI 打磨：登录、智能体选择、分页与版式规范

- 状态：已实施（2026-10-02，B1 后端分页 + F1/F2 前端；真浏览器验收见 PR 描述）
- 日期：2026-10-02
- 原型：<https://claude.ai/artifact/NSZmrMXuzrLhA9J2VvGvaE>（7 张画板，私有链接，需作者共享后他人可见）
- 范围：`frontend/` 表现层；分页涉及 `agent/`、`api-server/` 的列表接口
- 前置：[frontend-redesign.md](frontend-redesign.md) 的信息架构与 token 不变，本文只做打磨

## 1. 现状问题（2026-10-02 在运行中的栈上逐页核对）

| # | 位置 | 问题 | 证据 |
|---|---|---|---|
| 1 | 登录 | 未登录时登录表单塞在侧栏底部：SSO 按钮、两个无标签输入框、一个次要样式的「登录」按钮挤在 260px 宽里，无错误位、无显示密码、主次不分 | `ConversationSidebar.tsx` `onLogin`；`/login` 路由不存在（`*` 重定向到 `/`） |
| 2 | 智能体选择 | 原生 `<select>` 加文字标签「智能体」，与旁边自绘的模型 chip 风格割裂；看不到描述、默认标记；org 只有 1 个智能体时整块不渲染，用户不知道自己在用哪个 | `widgets/composer/AgentPicker.tsx` |
| 3 | 分页 | 会话列表后端 `limit 200` 一次拉完、无 cursor，侧栏搜索只过滤已加载项；审批 `limit 50`、定时任务 `limit 100` 静默截断；能力页 Skills/工具表格一次铺满 | `conversation-service.ts:244`、`approval-repository.ts:38`、`cron-job-repository.ts:11` |
| 4 | 间距 | 相邻卡片/折叠块之间没有间隔或间隔不一（智能体编辑器「基本信息」下的两个折叠块、A2A 表单）；各页内边距不同 | 截图核对 |
| 5 | 版式逻辑 | 页面宽度不一：定时任务/产物库居中窄栏，审核页贴左全宽，管理页贴左 max 920；智能体编辑器 11 个横向 tab 一行排开；A2A 权限用原生复选框；会话里「Deliverables」英文残留；admin 无审核员角色打开「交付物审核」直接红字「需要审核员权限」 | 截图核对；`DeliverablesPanel.tsx:78` |

参照：Dify / Coze / HiAgent 的智能体切换与编排页、ChatGPT / Claude 的新会话与 composer、Linear 的列表工具栏与空状态。

## 2. 设计定稿

以原型为准，这里只记录结构性决定与原型无法表达的行为。

### 2.1 版式规范（画板 07）

所有改动都先落到共享组件，页面只做组装。新增 `frontend/src/shared/ui/` 下的组件（名字固定，便于 review）：

| 组件 | 职责 |
|---|---|
| `PageLayout` | 页面骨架：内边距 `32px 40px`，`width` 变体 `list`(1200) / `form`(760)；**统一左对齐** |
| `PageHeader` | 标题 22px + 一行说明 13.5px + 右侧操作区（至多 1 主 1 次） |
| `Toolbar` | 搜索 / 分段筛选 / 下拉，控件间 12px，可换行 |
| `SegmentedControl` | 替代现有各页自写的筛选 tab |
| `StatusBadge` | 全站唯一状态→颜色映射（运行中/等待审批/成功/失败/已取消…） |
| `EmptyState` | 图标 + 标题 + 说明 + 可选动作；变体 `empty` / `error`（带重试与 trace id）/ `forbidden` |
| `FormField` | 标签在上（13px/550）、控件、说明或错误；字段间 16px |
| `Pager` | cursor 分页页脚：「第 N 页 · 本页 M 条」+ 每页条数 + 上一页/下一页 |
| `LoadMoreSentinel` | 侧栏/流式列表的增量加载：IntersectionObserver 触底 200px 拉下一页；三种尾部状态（加载中 / 失败可重试 / 到底） |
| `Popover` | 锚定弹层：Esc 关闭、点外部关闭、焦点回到触发器、方向键移动选项 |

间距层级：4 图标与文字 · 8 同组按钮 · 12 工具栏/卡片网格 · 16 表单字段与相邻卡片 · 24 页头到工具栏、分区之间 · 32 页面内边距。
控件高度：28 分段项 · 32 导航/composer chip · 34 工具栏与页面按钮 · 36 表单输入 · 40 登录输入 · 44 登录主按钮。
颜色、圆角、字号一律引用 `tokens.css` 变量，**不新增硬编码色值**；深色主题随 token 自动成立。

### 2.2 登录页（画板 01）

- 新增独立路由 `/login`；未登录访问任何页面 → 跳 `/login?return_to=<原路径>`；已登录访问 `/login` → 跳回 `return_to` 或 `/`。
  `return_to` 只接受站内相对路径（复用 `ssoLoginUrl` 的现有校验），防开放重定向。
- 左栏深色品牌区（产品名 + 三条能力说明 + 页脚），右栏 380px 表单。窄屏（<900px）隐藏左栏。
- 按 `GET /api/auth/config` 投影三种形态：
  - SSO 打开：SSO 主按钮（44px）在上；「管理员账号登录」为次要按钮，点击展开用户名/密码表单。
  - SSO 打开但 `available=false`：主按钮禁用 + 说明「SSO 暂不可用」，本地表单默认展开。
  - 仅本地登录：直接显示表单；`registration_enabled` 时显示注册入口（沿用现有注册逻辑）。
- 表单：`<label>` 在上、显示/隐藏密码按钮、`autocomplete`、提交中禁用、错误放在密码框下方（`role=alert`，复用 `localLoginErrorMessage`）。
  SSO 回调带回的错误（`takeSsoError`）显示在表单顶部。
- 从侧栏移除登录表单；未登录时侧栏不渲染（登录页无侧栏）。

### 2.3 智能体选择（画板 02）

- composer 工具栏左侧的智能体 chip：头像（`agentTone` 固定色 + 名称首字）+ 名称 + 下拉箭头，32px 胶囊；与模型 chip 之间一条竖分隔线。
- 点击打开 `Popover`：顶部搜索（>6 个时显示）、每项「头像 / 名称 / 默认徽标 / 一行描述 / 选中勾」、底部提示「会话开始后智能体不可更换」。
- 只有 1 个可用智能体时 chip 仍显示但不可点（无箭头），让用户知道在用谁；会话开始后 chip 变为只读标签（保持 multi-agent-selection D2：绑定不可变）。
- 新会话欢迎区标题改为当前智能体的头像 + 名称 + 描述，随选择切换。原型里的「开场建议」卡片**不在本期**（智能体没有对应字段，需要另行设计配置项）；本期该位置不渲染。
- 选择逻辑沿用 `agentPickerHelpers.ts`（默认智能体、无效选择归一），只换表现层。

### 2.4 分页（画板 03、04）

**接口契约**（dsh 实施，前后端以此为准）：

- 请求：`?limit=<1..100>&cursor=<不透明串>`，外加各接口原有筛选。`limit` 越界 → 400 `VALIDATION_ERROR`；`cursor` 无法解码 → 400 `VALIDATION_ERROR`。
- 响应：`{ <items>: [...], next_cursor: string | null }`；`null` 表示到底。
- keyset 分页：按排序列 + 主键编码（参照 `admin-run-query-service.ts` 的 `encodeCursor`/`decodeCursor`），抽成 `agent/src/application/` 下一个共享工具，现有两处重复实现可一并收敛但不强制。
  查询始终先套 owner/org 作用域，cursor 只是位置，不携带身份。

| 接口 | 默认 limit | 排序 | 变化 |
|---|---|---|---|
| `GET /api/conversations` | 30 | `updated_at desc, conversation_id desc` | 响应从数组改为 `{ conversations, next_cursor }`；新增 `q`（标题模糊匹配，转义 `%`/`_`，≤100 字符） |
| `GET /api/approvals` | 50 | 现有排序 + id | 新增 `cursor`；响应统一为 `{ approvals, next_cursor }` |
| `GET /api/cron-jobs` | 50 | `created_at desc, id desc` | 新增 `cursor`；`{ cron_jobs, next_cursor }` |
| Skill 共享申请队列（admin） | 50 | `created_at desc, id desc` | 新增 `cursor`；保持原 items 键名，加 `next_cursor` |

已有 cursor 的接口（admin 运行、成员、审核、产物库）不改契约，前端统一换用 `Pager` / `LoadMoreSentinel`。
能力页 Skills/MCP/工具/模型是平台目录（几十项），**前端分页**即可：每页 25 + 现有搜索，不改后端。

会话列表的注意点：`updated_at` 会因新消息变化，翻页期间条目可能前移造成重复，前端按 `conversation_id` 去重；新建/更新的会话由现有本地状态插到顶部。
侧栏搜索改为服务端 `q`，输入防抖 250ms，搜索结果同样增量加载；清空搜索恢复原列表。

**前端交互**：侧栏会话、产物库网格 → `LoadMoreSentinel` 自动加载；管理端表格（运行、审批、成员、审核、Skill 共享、定时任务）→ `Pager`。
切换筛选/搜索时回到第 1 页；cursor 栈保存在组件状态里以支持「上一页」。

### 2.5 智能体编辑器（画板 05）

- 11 个横向 tab 改为左侧分组导航：基础（基本信息、模型）/ 能力（技能、工具权限、MCP、数据源）/ 协作与交付（协作、交付策略）/ 发布（可见范围、版本历史）/ 高级（JSON）。
- 有未保存修改的分区在导航项右侧显示黄点；保存按钮从页头移到底部固定保存栏，栏左侧写「N 个分区有未保存修改」。无修改时保存栏隐藏。
- 只换布局与导航，不改各分区内部的字段与校验逻辑。

### 2.6 状态与细节（画板 06）

- 「交付物审核」：用户没有 `reviewer` 角色时显示 `EmptyState forbidden`（说明 + admin 可见「成员与角色」链接），不再请求队列、不再红字报错。侧栏入口仍按现有规则显示。
- 会话内「Deliverables」→「交付物」。
- A2A 新建凭据：表单改用 `FormField`，权限范围从原生复选框改为可切换 chip（`role=checkbox` 语义保留：用 `<button aria-pressed>` 或带视觉的 `<input type=checkbox>`）。
- 所有列表的加载失败统一 `EmptyState error`，保留筛选条件；空列表统一 `EmptyState empty`，有可执行的下一步时给动作按钮。

## 3. 实施拆分

两路并行，各自独立 worktree（[delegation.md](../delegation.md) §4）：

| 任务 | 执行者 | worktree / 分支 | 文件所有权 |
|---|---|---|---|
| F1 共享组件 + 版式规范落地到全部页面、登录页、智能体选择、编辑器导航、状态细节（§2.1–2.3、2.5、2.6） | agy | `.runtime/worktrees/ui-frontend` / `feat/ui-polish-frontend` | `frontend/src/**`，**除** `shared/api/`、`shared/schemas/`；`docs/webui.md` |
| B1 列表分页接口（§2.4 契约） | dsh | `.runtime/worktrees/ui-pagination` / `feat/ui-polish-pagination` | `agent/`、`api-server/`、`frontend/src/shared/api/`、`frontend/src/shared/schemas/`、`frontend/src/features/chat/ChatContext.tsx`（仅适配新响应形状）、`docs/api.md` |
| F2 前端接入分页（`Pager`/`LoadMoreSentinel` 接到 B1 接口与已有 cursor 接口；侧栏服务端搜索） | agy | F1 与 B1 合并后在 `feat/ui-polish-frontend` 上继续 | 同 F1 + 上述 ChatContext |

合并顺序：B1 → F1 → F2，最后整体走一个 PR（或 B1 单独先行）。主会话负责复核 diff、跑测试、重建容器和真实链路验证。

## 4. 验收

- 六套测试、类型检查、前端 build 全绿；新增组件有单测（`Pager` cursor 栈、`LoadMoreSentinel` 三态、登录 `return_to` 校验、智能体 chip 单/多智能体形态）。
- 分页接口测试覆盖：第一页/中间页/末页 `next_cursor`、非法 cursor 400、跨用户 cursor 拿不到他人数据（拒绝对照 + 合法对照）。
- 重建 `agent agent-worker api-server frontend` 后真实链路：登录（SSO 与 admin 本地）→ 建会话（多智能体时选非默认）→ 带工具 run → 侧栏造 >30 个会话验证增量加载与服务端搜索 → 跨租户 404。
- 浏览器逐页核对原型：间距、宽度、深浅主题、窄屏（390px）不出现横向滚动。
