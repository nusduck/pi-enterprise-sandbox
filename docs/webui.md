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
│   ├── widgets/             ← 消息、时间线、审批、交付物、进程控制台等组件
│   └── pages/
│       ├── workbench/       ← 主工作台（聊天 + 实体检查器）
│       ├── runs/            ← Run 列表与取消
│       ├── approvals/       ← 待审批列表
│       ├── schedules/       ← Cron 任务管理
│       └── settings/        ← Capabilities、Agents 与 A2A 管理
├── test/                    ← node:test + tsx
├── index.html
├── nginx.conf               ← /api/* 反代，SSE buffering off
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
| `features/chat/projections/` | 按稳定 run/message id 合并服务端消息与 runtime 投影 |
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
- **人机闸门**：草稿卡片提供高亮 **Enable** 按钮；点击后平台校验结构、复制一份只读已发布副本至用户已启用根，并写入 MySQL 账本；已启用用户 Skill 显示在 My Skills 中并提供 **Disable** 按钮；系统 Skill 为只读不可变更。
- **启用后草稿不再重复列出**：启用是**复制字节**，草稿本身留在草稿根（停用只删已发布的副本）。Agent 因此给已发布过的草稿打 `published: true`，Drafts 区只列 `published !== true` 的那些——否则同一个包名会在页面上出现两次，而且草稿那张卡还带着一个按了也没有新效果的 Enable。My Skills 里对应的卡片显示 `from draft` 小标签；要重新发布改过的草稿，先 Disable，草稿会回到 Drafts。分层规则在 `pages/settings/skillHelpers.ts`（纯函数，可测）。
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

**`/settings/agents`（仅 admin）** — `pages/settings/AgentsPage.tsx`，与 A2A Access
一样只在 `actingRole === 'admin'` 时出现在二级导航里。四块：org 内的智能体列表、
新建、配置编辑、版本历史。

- 页面反复说明的一件事是**保存 = 建新版本**：`agent_versions` 不可变，编辑配置
  产生下一个版本，旧版本保留；切换活跃版本**只影响新建的会话**，正在跑的 Run 与
  已存在的会话继续用它们钉住的版本。只写"保存"而不解释，用户会以为是原地修改，
  然后困惑于"为什么改了配置老会话没变"。两个按钮因此分开：
  *Save as new active version* 与 *Save without activating*。
- 「回滚」不是一个单独功能，就是在版本历史里激活一个旧版本——无需数据修复。
- config 是 JSON 文本框。解析规则在 `pages/settings/agentHelpers.ts`（纯函数，可测）：
  空文本 = 空配置而不是错误；数组与标量被拒；比较的是**解析后重新序列化**的结果，
  所以只改缩进不会被当成"改了配置"，否则每次打开页面都会诱导用户建一个内容完全
  相同的新版本。服务端仍会把同一份 config 再校验一遍（写入即校验），前端这层解析
  只是让用户在按下按钮之前就看到 JSON 错在哪。

### Settings 二级导航结构与 Grok 风格布局

为优化系统功能架构，侧边栏一级主导航聚焦于核心工作流（Chat 与 Schedules）；侧边栏底部仅保留单一简洁的 **Settings** 入口与用户 Profile（当存在未决审批或运行中任务时统一展示聚合角标）。
点击 Settings 进入 `/settings/*` 后，界面采用对标 **Grok Web** 的经典两栏式设置中心：
- **左侧垂直分类导航（Settings Sidebar）**：常驻提供 `Capabilities`、`Approvals`（未决警告角标）、`Runs`（活跃角标）、`Agents`（管理员可见）与 `A2A Access`（管理员可见），顶部提供快捷返回聊天的「Chat」按钮。
- **右侧配置面板（Settings Content）**：承载当前分类的内容。
- **Runs 行内展开控制台**：在 `Runs` 表格中，点击单条记录的 `Logs` 或 `Trace` 直接在当前行下方平滑展开行内抽屉（`<tr className="mgmt-expand-row">`），提供终端日志查看、复制与分布式 Span 树检查，避免滚动到页面底部的体验断层。
- **Workbench Details 精简化**：聊天主界面右侧 Details 抽屉对标 ChatGPT Canvas / Artifacts 模式，聚焦于「产物预览（Artifacts）」、「关联文件（Files）」与「执行概览（Overview）」，将研发向 Trace 链路跟踪全面收拢至 Runs 页面。
旧路径 `/runs` 与 `/approvals` 自动重定向至对应 `/settings/*` 路径，保持外链与收藏兼容。

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
| 审批 | 横幅按钮 | `decideApproval` |
| 复制消息 | 气泡下方 Copy（hover 显示） | 剪贴板写入 `messagePlainText(msg)` |
| 重新生成 | 最后一条助手气泡的 Regenerate（仅 idle 时显示） | 取前一条用户回合文本重发 `sendMessage`（纯文本；不重建附件） |
| 回到最新 | 右下角浮标（距底部 >120px 时出现） | smooth 滚动到底 |

## SSE 事件消费

解析见 `frontend/src/shared/sse/parser.ts`；事件类型与 [API 文档](api.md#sse-事件协议) 及 `tests/fixtures/sse_events.json` 对齐：

| 事件类型 | UI 行为 |
|----------|---------|
| `trace` | 记录 `traceId` |
| `session` | 状态栏 session 后 8 位；可带 `conversation_id` / `session_reused` |
| `token` | 增量追加文本到流式气泡 |
| `tool_start` | 工具卡片 running |
| `tool_end` | 工具卡片 complete / error |
| `approval_required` | 审批横幅 |
| `file_ready` | artifact 下载链接 / 交付物列表 |
| `done` | 结束流式 |
| `session_closed` | 状态栏 Session ended |
| `error` | 错误文本 + flash |

## 渲染机制

- React 组件通过 `ChatContext` 订阅规范化 `EntityStore` 与 UI snapshot
- `agentEventAdapter -> runReducer` 是 RuntimeEvent 的唯一写入路径
- `projectRunMessages` 从 Run/Message/Tool/Artifact 实体生成聊天投影
- **一轮 Run = 一个助手气泡**：`projectConversationMessages` 末尾的 `mergeAssistantTurns`
  把同一 Run 的相邻 assistant 行合并成一条消息（多个 text part 顺序渲染为连续
  Markdown 块）。否则「出文本 → 调工具 → 再出文本」的一轮会摊成一叠各自带头像和
  「UPRC Agent」抬头的碎片。身份字段（`_messageId` / `sequenceNo` / `createdAt`）取
  首行以保持 React key 与回合起始时间稳定，存活状态（thinking 状态、中断横幅）取末行
- 步骤树（`InlineRuntimeSteps`）挂在该 Run 的**第一个**助手气泡上，渲染在正文之前，
  **默认折叠**——它在回合顶端，展开会把回答本身顶到屏幕外；折叠态的摘要行仍显示
  步骤数与耗时
- Timeline、Context Inspector、Approval 与 Deliverables widgets 按实体 id 更新，不维护第二份 runtime state
- 子代理 fan-out：`subagent` 工具卡片渲染为结构化任务视图（子 Run 状态聚合），而不是裸 wire JSON；`todo_write` 同理。

  **2026-08-31（ADR 0009 D4/D10）**：工具名换成 DSH 出厂的一套——`spawn_subagent` → `subagent`、`ask_user` → `ask_user_question`；旧名在前端仍被识别，**只为渲染历史会话**。`todo_write` 的清单在 **arguments** 与 `todo/write` 事件里，**不在 result 里**（出厂结果只有一句 `Updated todo list: …` 与 `{counts}`）——按 result 解析会让卡片静默退化成一行文本。`memory_write` / `memory_search` 本阶段不做（D10），新 Run 不会再产生它们，卡片保留只为历史会话。
- Markdown 通过 `react-markdown` + `rehype-sanitize` 渲染；下载链接仍经 URL allowlist 过滤

## 测试

```bash
npm test --prefix frontend          # node:test + tsx — test/**/*.test.ts
npm run build --prefix frontend     # 生产构建（CI 同款）
```

覆盖：SSE 分片/abort/错误、会话切换与 generation、URL/HTML 注入防护、基础 a11y 语义。

## 主题

支持暗色（默认）和亮色主题：`ThemeProvider` 持久化用户偏好，通过 CSS `[data-theme]`
切换；图标为内联 SVG 集合（`shared/ui/Icons.tsx`），不再使用 emoji 字形。

## 键盘快捷键

| 快捷键 | 操作 |
|--------|------|
| `Enter` | 发送消息（输入法组合期间不触发，回车先确认候选词） |
| `Shift+Enter` | 换行 |
| `Ctrl+U` / `Cmd+U` | 打开文件选择器上传（Run 运行中与按钮一致被禁用） |
| `Ctrl+V` / `Cmd+V` | 粘贴剪贴板里的图片/文件为附件（同一道 Run 运行中门禁）；剪贴板只有文本时不拦截，正常落进输入框 |
| `Ctrl+L` / `Cmd+L` | 新建会话 |

消息日志区域显式声明 `aria-live="off"`：`role="log"` 本身隐式携带 polite live
region，而流式 token 是在已有文本节点上追加（落在默认 `aria-relevant` 的 `text`
范畴内），不显式关掉就会让读屏逐 delta 重读整段 transcript。Run 状态变化由
FlashZone（`role="status"` + `aria-live="assertive"`）统一播报。
