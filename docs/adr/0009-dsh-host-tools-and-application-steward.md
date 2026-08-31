# ADR 0009: 出厂工具挂 host；application 做 DSH 管家

| 字段 | 值 |
|---|---|
| 状态 | **Accepted**（2026-08-31 决策锁定；**2026-08-31 第二版重写**；实施未开始） |
| 日期 | 2026-08-31 |
| 决策所有者 | Agent runtime maintainers |
| 适用范围 | `agent/` 的 DSH 组合层与 `application/` 对循环的接线；`exec/` 的可写根扩一项；skill 的闸门位置与前端 skill 面 |
| 关联决策 | [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)（本 ADR 收窄其组合方式，并改写 D4 中「不组合 `dsh-user-approval`」）、[ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md)（D2 的可写根集合扩一项，机制不变；D4 的逐包绑定成为 skill 闸门的执行面）、[ADR 0006](0006-user-skill-enablement-gate.md)（**本 ADR 吸收并改写它的 P1**：四个变更工具不是降级而是整体取消，闸门只剩「启用」） |
| 上游参照 | 官方 `npx @deepseek-ai/dsh web`（`dsh-base` → `dsh-web-app` → `dsh-agent-presets`）；本仓库 **不采用** 后两层包。注意 `dsh-base` 依赖里的 `@deepseek-ai/dsh-web` 是 **web 搜索/抓取 seam**（配 `dsh-tool-web` / `dsh-web-search-deepseek`），不是那个 web app；`dsh-web-app` 只在 CLI 包 `@deepseek-ai/dsh` 的依赖里 |

## 背景

[ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) 已经把 Agent 循环换成 DSH：`dsh-base` 之上叠
`agent/src/runtime` 的 overlay，`ctx.fs/shell/jobs` 指向 `exec/`。Pi Extension 包
（`sandbox-bridge` / `enterprise-policy` / `user-interaction` / `skill-lifecycle` /
`subagent-spawn` / `task-state`）已删除。

实施留下一个洞：**模型侧的企业工具没有按 DSH 的方式挂回去。** 工作区 read/bash 能走
出厂 `tool-fs` / `tool-bash` + remote provider；todo / 提问 / skill 工具面 / 子 Agent
工具面既没有旧 Extension，也没有把 `dsh-base` 里已有的对应 plugin 激活到循环上。
`application/` 仍按「自己 registerTool」的形状留着审批、todo、spawn 服务，其中若干
工厂函数已经没有调用方。

讨论中一度把官方 web 的 **per-session preset** 当成「挂上 tool 的办法」。那是误用：
preset 只解决「每个会话工具清单可以不同」；DSH 加插件的常规路径是 **bundle / overlay**。
官方 TUI 就是把 `tool-bash` 等放在 host 上。

### 第二版为什么重写

初版评审发现三处会在起栈时直接撞墙的硬伤，它们改的是决策本身，不是实施细节：

1. **审批**：初版写「问人改走原生审批」，但 `dsh-user-approval` 是一个**没有 answerer
   的 seam**，且请求必须处在一个 open turn 内（[ADR 0002](0002-dsh-harness-evaluation.md)
   §「审批 seam」的四条已知限制）。「释放 Worker 再 resolve 那次 ask」在跨 Worker
   的前提下不成立。见 D5。
2. **工具名**：风险表与分类器是 fail-closed（未知工具 → deny）。把模型的工具面换成
   base 的出厂工具而不同步改名单，等于整片工具被拒。这是第 0 步，见 D4。
3. **skill**：初版把 `skill_install` 等排除在模型之外，同时又拿 `source_digest` 论证
   审批绑定——而那套 digest 只服务于 `skill_install`，两条一起写就是死代码。本版
   取消整套变更工具，改为模型直接用 `tool-fs` / `tool-bash` 写草稿目录，见 D7。

## 决策

### D1：网页不进 ctx，不采用 `dsh-web-app`

浏览器边界仍是 `frontend → BFF → Agent`。SSE 契约不变。不把官方 `ui-*` /
`dsh-client-connection` 叠进 Agent 进程，也不让浏览器打到 Agent 的 HTTP。

学官方 web 的 **只有组合方式**（空 ctx → base → overlay），不学它把 UI 和循环放进
同一个进程。

**现状差距**：无。今天就是这样。

### D2：组合是 `dsh-base` + 一份 overlay；overlay 是整棵树的 patch

```text
空 ctx
  ├─ ① @deepseek-ai/dsh-base
  ├─ ② agent/src/runtime overlay（manifest.ts → cordis.patch.yml）
  └─ 网页不进 ctx
```

Overlay 按 `id` 覆盖或插入，不是「给 `tool-bash` 打补丁」。它对 base 做五类事：
改 config（LLMIO）、关掉本机执行族与 jsonl、替换凭据 / 子 Agent provider、插入
`remote-fs` / `remote-shell` / `remote-jobs`、插入我们自己的工具与 answerer 插件
（D5、D8）。`tool-bash` 仍是出厂插件，只是 `ctx.shell` 换成 RPC。

事实源仍是 `agent/src/runtime/plugins/manifest.ts`，YAML 由 `npm run gen:patch` 生成。

**「不再 registerTool」约束的是 `application/`，不是 `agent/src/runtime`。**
runtime overlay 里的插件当然可以注册工具——那正是 DSH 里注册工具的地方。

**现状差距**：前三类已在 `cordis.patch.yml` 里；后两类未写。

### D3：出厂工具挂在 host（bundle / overlay），不用 per-Run preset

`dsh-base` 已包含 `tool-fs`、`tool-fs-search`、`tool-bash`、`tool-jobs`、
`tool-todo`、`tool-skill`、`tool-subagent`、`user-questions`、`user-approval`
（2026-08-31 直接查 registry 的 `dsh-base@0.1.1-rc.2` 依赖核对）。
它们留在 host，与官方 TUI、与 `dsh plugin add` 加包的方式相同。

**base 有两个缺口，必须显式加依赖**（否则 boot 之后这两类工具根本不存在）：

| 缺的 | base 里有什么 | 要加的包 |
|---|---|---|
| 问人的**工具** | 只有 `ctx.userQuestions` 这个 seam（`dsh-user-questions`） | `@deepseek-ai/dsh-tool-ask-user`（注册 `ask_user_question`） |
| MCP | 什么都没有 | `@deepseek-ai/dsh-mcp-client`（见 D9） |

**不用 preset 的理由不是「所有 Run 工具一样」**——那句是错的：
`agent/src/infrastructure/dsh/agent-version-bindings.ts` 里 AgentVersion 本来就带
`extensions / skills / mcpServers / toolPolicy / sandboxPolicy`，工具面按版本就是不同的。
真正的理由是 [ADR 0002](0002-dsh-harness-evaluation.md) 的实测结论：
**`dsh-agent-presets` 的预设表是 process-level，改可选项要重载插件，没有租户维度**
（"一台机器上的一个人给自己选一档权限"）。AgentVersion 是租户的动态数据，注册不进去。

AgentVersion 之间的工具差异走**已有的逐调用闸门**：`tools/pre-execute` /
`ctx.tools.guard()` 按 `toolPolicy` 拒绝不在清单里的工具，理由码稳定。
即 **host 挂全量 + 按 Run 过滤**，而不是 per-Run 装配不同的工具集。

每 Run 的工作区 / 租户隔离同样不靠 preset：由 remote provider + 按 Run 的
`runWithExecRpc`（`AsyncLocalStorage`，`agent/src/runtime/providers/exec-rpc.ts:65`）承担。
tool 插件是单例，问到的 `ctx.fs/shell/jobs` 必须是这次 Run 的租户。并发 Run
**不得**靠「`rebind` 根 ctx 上的同一份 provider」——那会串台。

**ALS 作用域是一条硬约束**：今天 `runtime-factory.ts:286-289` 把
`followup + whenIdle` 整段包在 ALS 里。D5 去掉阻塞的 `whenIdle` 之后，
**必须保证所有工具执行仍在 ALS 作用域内**（park 发生在 turn 结束时，不是在
turn 中途放开），否则 provider 拿不到本 Run 的 RPC 上下文。验收要有并发两个
不同租户 Run 的断言。

**现状差距**：出厂工具未激活；`toolPolicy` → 闸门的过滤未接线。

### D4：工具名是契约面，改名是第 0 步

模型侧工具名从 Pi 的一套换成 base 的一套。风险表与分类器是 **fail-closed**
（未知工具 → `deny` / `critical`），漏一处就是整片工具在运行时被拒。以下四处必须
同一次改齐：

| 位置 | 现在装的 |
|---|---|
| `agent/src/runtime/policy/risk-table.ts:11-31`（`LOCAL_TOOLS`） | `read/ls/grep/bash/todo_write/spawn_subagent/skill_*` |
| `agent/src/infrastructure/dsh/tool-risk-classifier.ts:6-16`（`LOCAL_SET`） | 同上 |
| `agent/src/infrastructure/dsh/constants.ts:15-21`（`SANDBOX_TOOL_NAMES` / `ENTERPRISE_DEFAULT_TOOLS`） | Pi 名单，供 diagnostics 与默认工具面用 |
| `config/agent/tool-risk.json` | 运维可编辑，key 就是工具名 |

**真实注册名**（2026-08-31 从 registry 拉 `0.1.1-rc.2` 的 tarball 里读出来的，不是推的）：

| 包 | 注册名 |
|---|---|
| `dsh-tool-fs` | `read`、`write`、`edit`、`read_image` |
| `dsh-tool-fs-search` | `glob`、`grep` |
| `dsh-tool-bash` | `bash` |
| `dsh-tool-jobs` | `job_list`、`job_output`、`job_kill` |
| `dsh-tool-todo` | `todo_write` |
| `dsh-tool-skill` | `skill` |
| `dsh-tool-subagent` | `subagent`（`config.toolName` 默认值） |
| `dsh-tool-ask-user` | `ask_user_question` |
| `dsh-mcp-client` | `mcp__<serverName>__<rawName>` |

对着现在的 `LOCAL_TOOLS` 逐项落差：

- **新名字要加进白名单**（不加就是 fail-closed 拒）：`glob`、`job_list`、`job_output`、
  `job_kill`、`skill`、`subagent`、`ask_user_question`、`read_image`。
- **旧名字变成死条目**：`ls`、`find`、`process_start` / `process_status` / `process_read` /
  `process_kill`、`skill_list` / `skill_install` / `skill_uninstall`、`spawn_subagent`、
  `ask_user`、`memory_write` / `memory_search`（D10）。
- **原样不动**：`read`、`write`、`edit`、`bash`、`grep`、`todo_write`。
- **注意**：出厂 `tool-fs` **没有 `ls`**，目录列举靠 `glob` 或 `bash`；`submit_artifact`
  是我们自建的，保留。

**存量数据**：AgentVersion 的 `configJson` 是 Run 创建时冻结的不可变快照，里面的
`toolPolicy` 存的是旧工具名。实施时必须给出处置：旧名 → 新名的只读别名映射（推荐），
或明确「旧版本不再可运行」。不处置就是老 Run 静默全拒。

**现状差距**：四处都还是 Pi 名单；别名映射不存在。

### D5：审批 = 组合 `ctx.approval` seam + 自建 answerer；停泊靠重放，不靠挂起

**改写 [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) D4 的「不组合
`dsh-user-approval`」。** 但组合的方式不是「把审批交给原生」：

- `dsh-user-approval` 提供的是 **`ctx.approval` 这个通道中立的 seam，本身没有
  answerer**（[ADR 0002](0002-dsh-harness-evaluation.md)：「企业审批 UI 要自己实现成一个
  `approval/request` waterfall listener」）。overlay 打开 `approval`，同时插入自建的
  `enterprise-approval-answerer` 插件。
- **风险表与审批记录留在原地**：`tools/pre-execute` 仍然按 `config/agent/tool-risk.json`
  判 `ask`，仍然铸 PENDING 记录。这一层是「大脑」，seam 只是「嘴」。
- **原生审批不携带 arguments 不再是问题**：审批记录是在 `pre-execute` 里铸的，那里
  args 齐全（`pre-execute.ts:76-84` 的 `argsCanonical` + digest）。seam 不带参数只影响
  seam 自己传什么，不影响我们记什么、不影响审批中心展示什么。

**停泊语义（本 ADR 的关键一条）**：`ctx.approval.request` **必须处在一个 open turn 内**，
上游明写 "a durable out-of-turn approval workflow is deferred"。因此 answerer
**不得**挂着 promise 等人——那等于堵住 Worker。唯一自洽的形状是 **park + replay**：

1. **第一次问**：answerer 写 durable PENDING（owner-scoped，MySQL）→ 立刻返回一个
   非 allow 的结果 → 该次工具调用不落地 → turn 正常结束 → Run 转 `WAITING_APPROVAL`
   → **释放 Worker**。
2. **人决策**：现有 `approval-decision-service` 的 HTTP 形状不变。
3. **续跑**：Run 重新入队（可能换一个 Worker/进程）→ **重建 DSH 会话并重放那次
   tool call** → answerer 按 `callId` + args digest 查到已落库的决定 → 立刻
   `allowed-once` 或 `rejected`。

**执行者是 DSH，不是 application。** 今天 `agent/src/application/pi-run-resume.ts` 是
application 自己认领并重放被批准的工具（原 toolCallId + 原参数，结果塞回 session）；
本 ADR 把这件事交回循环，application 只负责「停下来」和「重新跑起来」。
`ask_user` 的续跑（`replaceSuspendedToolResultInSession`）同样改成重放。

digest 与租户 / fence 仍在 `tools/pre-execute` / `ctx.tools.guard()` 上核；
人点同意之后、真正落地之前，args 指纹对不上必须拒绝。

`dsh-permission-presets` 与 `dsh-sandbox-policy` **仍然不组合**（隔离权威是
Bubblewrap / exec，不是 DSH 本机围栏）。

**「approval 是否依赖 permission」这个悬念已经查清**（2026-08-31，registry）：
`dsh-user-approval@0.1.1-rc.2` 的依赖只有 `@deepseek-ai/schemastery`，
**与 `dsh-permission-presets` 无关**；而 base 里那个 `permission` id 就是
`dsh-permission-presets`（`ctx.permissionPresets`，一个把 sandbox-mode 与
approval-policy 打包成产品级下拉的 process-level 旋钮）。
所以结论是干净的：**overlay 打开 `approval`，`permission` 继续保持 `disabled`。**
包自陈 "one-shot permission decisions dispatched to composed answerers over the
approval/request waterfall, fail-closed by default"——正是本条要的形状。

**现状差距**：`cordis.patch.yml` 现在 `approval` / `permission` 都是 `disabled`；
answerer 插件不存在；resume 是 application 侧重放。

### D6：旧 Pi Extension 的模型面用 dsh-base 顶掉

| 旧 Extension | 用什么顶 | application 还留什么 |
|---|---|---|
| `sandbox-bridge` | `tool-fs` / `tool-bash` / `tool-jobs` + 自建 `remote-fs-search`（D8） | 无（字节在 exec） |
| `task-state` 的 todo | `tool-todo` | 不再当模型 tool；`task_todos` 可停用。前端改结果解析（见「影响」） |
| `user-interaction` | `user-questions` / ask-user | `WAITING_INPUT` 停泊 + 现有应答 API，续跑靠重放（D5） |
| `skill-lifecycle` 的工具层 | **不再有工具层**：`tool-skill` 负责发现与调用，变更由模型直接写草稿目录（D7） | 启用态与校验（`skills/manager` + Capabilities HTTP） |
| `subagent-spawn` 的工具层 | `tool-subagent` | durable `ctx.subagents` 接到 `SubagentSpawnService`（MySQL + 队列） |
| `enterprise-policy` 的「问人」 | `ctx.approval` seam + 自建 answerer（D5） | 停泊 `WAITING_APPROVAL` + 现有审批中心 API |

`application/` **不再 `registerTool`。**

**现状差距**：整表未接线。

### D7：模型直接操作用户侧 skill；不注册任何 skill 变更工具；闸门只剩「启用」

**适用范围只有用户侧 skill（`<base>/<orgId>/<userId>` 那一层）。系统 skill 一行不改**：
仓库 `skills/` 随镜像发布，挂在 `/home/sandbox/skill`，永远只读、永远全量进发现与
prompt、没有启用态、模型在任何模式下都写不了它——`agent/src/skills/paths.ts` 的原话是
「an installed skill must never be able to shadow or overwrite one the platform vouches
for」。改动系统 skill 仍然是改仓库、发版本。

**取消** `skill_install` / `skill_create` / `skill_edit` / `skill_uninstall` 这一整套工具。
模型用 `tool-fs` / `tool-bash` 在一个**可写的草稿根**里直接建目录、写 `SKILL.md`、
写 `scripts/`——和它在 workspace 里干活是同一组工具、同一套围栏。草稿根是
**每用户一个**，所以一个用户造的包不会进另一个用户（或另一个 org）的上下文。

三个根，职责分开（这是本条能同时做到「放松」和「不塌」的原因）：

| 根 | 挂载 | 谁能写 | 进不进 prompt / 发现 |
|---|---|---|---|
| 系统 skill `/home/sandbox/skill` | `ro_bind`，必挂 | 没人（镜像内） | 是 |
| 已启用用户包 `/home/sandbox/skill-user/<pkg>` | **逐包** `ro_bind`（[ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md) D4，已实现） | 没人 | 是 |
| **草稿根 `/home/sandbox/skill-draft`**（新增） | `bind`，读写，每用户一个持久目录 | 模型、前端上传 | **否** |

- **可写根是单一事实源**：草稿根必须加进 `exec/src/fs/writable-roots.ts` 的
  `writableRoots()`——fs 围栏与 bwrap 的 MountPlan 都从那里派生
  （[ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md) D2），**不许只改一处**。
- **`tool-skill` 的发现范围 = 系统 + 已启用**。草稿根不进发现、不进 system prompt。
  否则等于没有闸门。
- **启用 = 人在 UI 上做，是唯一的闸门**：校验包结构（复用 `agent/src/skills/manager.ts`
  现有的结构与大小校验，输入从「上传的 zip」换成「草稿目录」）→ **把字节复制成一份
  只读的已发布副本** → 记内容摘要与启用态（owner-scoped MySQL 表，
  [ADR 0006](0006-user-skill-enablement-gate.md) P1 (C)）。
- **复制消掉了 0006 P1 (B) 的绕过**：已启用副本与草稿是两份字节，模型改草稿动不了
  已启用的包，所以不需要每 Run 重算摘要，也不需要「摘要变了自动落回未启用」。
  停用 / 重新启用就是删掉或替换那份副本。
- **前端 skill 上传不再走 `skill_install`**：解包直接写进同一个草稿根，然后走同一条
  启用路径。上传与模型创建从此是同一个故事。
- **`skill-creator`（仓库 `skills/` 里已有）负责教怎么做**：用户侧 skill 的目录形状、
  写在哪、怎么自测、怎么让用户启用。原来由工具的参数校验和拒绝理由承担的语义，
  改由这个 skill 的正文承担。企业条款 prompt 里的路径要指到草稿根。
- **一并退役**：`agent/src/runtime/policy/source-digest.ts`、风险表里
  `skill_install: 'high'` 的覆盖、`config/agent/tool-risk.json` 里对应的 high 条目。
  它们只服务于「审批后重放 zip」这条已经不存在的路径。

**明确接受的风险**（这是本条相对 [ADR 0006](0006-user-skill-enablement-gate.md) 的实质
放松，写在这里以免日后当成疏忽）：**写入用户侧 skill 不再经任何审批**——`write` / `bash`
是 low。模型可以在草稿里放任意脚本并 `bash` 执行它。这与「在 workspace 里写个脚本
再跑」同级，[ADR 0006](0006-user-skill-enablement-gate.md) 真正在意的两件事仍被挡住：
包**进入之后每一轮的 system prompt**、以及包**进入只读挂载被当作既有能力执行**——
两者都只发生在启用之后。

**现状差距**：草稿根不存在；`writableRoots()` 只返回 workspace + temp；启用态表与
前端启用面不存在；四个工具与 digest 机制还在代码里。

### D8：搜索走自建 `remote-fs-search`，出厂 `tool-fs-search` 保持关闭

出厂 `tool-fs-search` 依赖本机 `subprocess` + ripgrep，与
[ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) D11「本机执行族一律不挂」冲突。
不为了它恢复 `subprocess` 服务——那会把「agent 进程里没有执行面」这条边界糊掉。

改为在 overlay 里插入自建的 `remote-fs-search` 工具插件，打 exec 的
`/internal/v1/fs/*`（Wave 7 已经有搜索端点）。**注册名必须与出厂完全一致：
`glob` 和 `grep`**（出厂 `tool-fs-search` 就这两个，见 D4），这样风险表、
`tool-risk.json`、前端和模型只认一套名字，将来若换回出厂实现也不用改任何一处。

**现状差距**：`cordis.patch.yml` 里 `tool-fs-search: disabled` 且没有替代——
今天模型没有搜索工具。

### D9：组合出厂 `dsh-mcp-client`，退役 `pi-mcp-adapter`

**上一版把这条写错了**：以为 DSH 没有 MCP、要自己写注册插件。查 registry 之后更正——
**MCP 包存在，只是不在 `dsh-base` 里，而是 CLI 包 `@deepseek-ai/dsh` 的依赖**：

> `@deepseek-ai/dsh-mcp-client@0.1.1-rc.2` — "MCP client bridge: connects to MCP
> servers and registers their tools on `ctx.tools`"（依赖 `@modelcontextprotocol/sdk`）。

官方 `dsh` / `dsh web` 就是这么加载 MCP 的：**`cordis.yml` 里一个 MCP server 一个插件实例**
——正是 D3 说的 host 组合，不是 preset、不是每 Run 装配。

四条决定：

1. **组合出厂包，退役自建适配**。加依赖 `@deepseek-ai/dsh-mcp-client`，overlay 里
   **每个 MCP server 一条 `insert`**（`id: mcp-<server>`，`name: '@deepseek-ai/dsh-mcp-client'`，
   `config: { serverName, transport: stdio|streamable-http, command/args/env 或 url/headers,
   toolCallTimeoutMs, failOnStartupError, reconnect }`）。条目由 `manifest.ts` 从
   `MCP_SERVERS_JSON` 生成，仍然经 `npm run gen:patch`——事实源不变。
   **`agent/src/infrastructure/mcp/pi-mcp-adapter-factory.ts` 与 `pi-mcp-adapter@2.11.0`
   这个钉死的 vendor 依赖随之退役**（`STATUS.md` A3 可以翻转）。这符合
   [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) D2「能用原生用原生」。
2. **名字对得上**：出厂注册的公共名就是 `mcp__<serverName>__<rawName>`，与
   `config/agent/tool-risk.json` 现有的 `mcp__github__*` / `server::tool` 规则同形。
   一个坑要记下来：**超长或含非法字符的名字会被规范化并追加 12 位十六进制哈希**，
   那种工具匹配不上精确 key，只能靠 `mcp__<server>__*` 前缀兜底——风险表必须保证
   每个 server 都有前缀条目，不能只写精确名。
3. **密钥仍然只走 env**：README 的写法是 `env: { GITHUB_TOKEN: !!js process.env.X }` /
   `headers: !!js '`Bearer ${...}`'`，与 manifest 的 `!!js:` 占位符机制一致。
   **secretRef → env 的解析留在我们代码里，patch YAML 里不得出现明文。**
4. **可见性与执行仍是两层**（本条唯一没被出厂包解决的部分）：插件实例是进程级的，
   所有 Run 看见同一批 MCP 工具。AgentVersion 没引用的 server / tool 由
   `tools/pre-execute` 与 `ctx.tools.guard()` 拒（权威层）；要不要再收窄**可见性**
   （省上下文、少诱发必然被拒的调用）取决于 DSH 有没有按 agent/session 收窄注册面的
   机制，装好包之后确认。确认不了就接受「全量可见 + 逐调用拒绝」，
   **不为此引入 preset**。

连带好处：出厂包自带重连退避与预算、`notifications/tools/list_changed` 重新同步、
`failOnStartupError` 选择、超时与 abort、图片结果经 `ctx.attachments` 落库——
这些今天要么在 `container-mcp.ts` 里自己写（冷启动重探、快照），要么没有。
`/ready` 的 MCP 就绪度改成投影 DSH tool 注册表 + 插件日志，不再投影 adapter 快照。

**已知限制（出厂包自陈，照抄进决策以免日后当惊喜）**：只桥接 Tools，Resources /
Prompts 不做；连接与 `tools/list` 超时吃 MCP SDK 的 60s 默认；streamable-http 的
失败是逐调用暴露而不是由 supervisor 重启。

**现状差距**：`dsh-mcp-client` 未加依赖；MCP 工具没进循环（今天模型一个 MCP 工具
都看不到）；`MCP_SERVERS_JSON` → N 条 patch 的生成器没写；AgentVersion 引用 →
执行层过滤没接线。

### D10：不做 memory

`memory_write` / `memory_search` 本阶段不做。DSH 无此组件；
`runtime/providers/memory.ts` 不挂到循环上。前端 memory 卡片随之无数据。

**现状差距**：无（本来就没接线）。

### D11：`application/` 是管家，不是工具面

留下：Run 队列与 lease、session lock / fence、取消与恢复、Conversation / Message /
RunEvent → BFF SSE、跨租户 404、A2A、trace 查询。

改接线：executor 听 DSH `session/event` 与审批/提问 pending，负责停泊与**重放式续跑**
（D5）；diagnostics 投影 DSH tool 注册表，不再投影空的 Extension 名单；
`getAllTools()` 不再把 `fs/shell/jobs` 三个 provider 当成工具列表。

删或停用生产路径上的：`extensionBundleFactory`、无人调用的
`createTaskStateStore` / 未接线的 spawn 工厂（spawn 接到 durable provider 之后，
死装配删掉）。自建 compaction / 单次 tool 超时 / 会话标题，能交给 base 的就关。

`PiRunExecutor` 文件名可后改，不阻塞本 ADR。

**现状差距**：`extensionBundleFactory` 在生产代码 6 处、测试 5 处仍被断言转发
（`pi-run-executor.ts:495/576/594`、`container-run-executor.ts:109/165/284`、
`tests/bootstrap/container.unit.test.js:364`、`tests/pi/pi-run-executor.unit.test.js` 等），
删除它是**独立一步**，附带这批测试的改写。

## 拒绝

- 用 `dsh-web-app` 替换 frontend / BFF。
- 引入 per-Run preset：`dsh-agent-presets` 的预设表 process-level、无租户维度，
  承载不了 AgentVersion 的差异。
- 在 application 里重新 `registerTool` 一套与 base 同名的工具。
- 把 Run 队列、审批中心、SSE 搬进 ctx。
- 用 `dsh-sandbox-local` 替换 Bubblewrap。
- **让 answerer 挂起等人**（上游明确不支持 out-of-turn 审批），或让 Worker 堵在
  `whenIdle()` 里。
- **为了 `tool-fs-search` 恢复本机 `subprocess`**。
- 本阶段做 memory。
- **把草稿根和已启用包做成同一份字节**（那会让模型能改写已批准启用的包，
  正是 [ADR 0006](0006-user-skill-enablement-gate.md) P1 (B) 点名的绕过）。
- **把草稿根放进 `tool-skill` 的发现范围或 system prompt**（等于取消闸门）。
- **为 MCP 的按 AgentVersion 差异引入 preset**，或每 Run 重新建 MCP 连接。
- **把 MCP 密钥明文写进 overlay 的 patch YAML**（只走 secretRef，与凭据插件同规矩）。

## 现状与实施顺序（未开始）

0. **工具名改齐**（D4：四处 + 存量 `toolPolicy` 的别名映射）。这是第 0 步，
   因为它是 fail-closed 的，不先做则后面每一步都表现为「工具被拒」。
1. Overlay：激活出厂工具族，**加两个 base 没有的依赖**（`dsh-tool-ask-user`、
   `dsh-mcp-client`），插入 `remote-fs-search`（D8）、`enterprise-approval-answerer`
   （D5）；打开 `approval`、保持 `permission` 关闭（D5）；确认 boot 后它们真的出现在
   DSH tool 注册表（没有的话补依赖，不是加 preset）。
2. Remote provider 按 Run 隔离；并发两个租户 Run 的断言；ALS 作用域覆盖所有工具执行（D3）。
3. Durable `ctx.subagents` 接到 `SubagentSpawnService`，去掉内存队列当生产路径。
4. Executor：pending → 停泊企业 Run → 现有 HTTP decide/respond → **重建会话重放**续跑；
   `pi-run-resume.ts` 的 application 侧重放退役（D5）。
5. Skill：草稿根 + `writableRoots()` 扩项 + 启用态表 + 启用时复制副本；四个变更工具与
   `source-digest.ts` 退役；`skill-creator` 补写用户侧 skill 的创建/编辑/发布（D7）。
6. MCP：`MCP_SERVERS_JSON` → 每 server 一条 `dsh-mcp-client` patch 条目；退役
   `pi-mcp-adapter` 与 `container-mcp.ts` 的自建发现；`toolPolicy` / MCP 引用 →
   执行层过滤（`pre-execute`），可见性层按 D9 第 4 条先确认再决定（D3、D9）。
7. `extensionBundleFactory` 与死装配删除，附带测试改写（D11）。
8. 前端：todo / 工具卡片按新工具名与结果 schema 适配；skill 上传改走草稿根 + 启用面。
9. 本机 compose + 现有 LLMIO 跑通：登录 → 建会话 → 带工具 Run → 一轮审批停泊与续跑
   → 一次草稿建 skill 并启用。

验证仍遵守：断言语义；改运行时装配必须起栈，不能只靠单测。

## 影响

- [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) D2（能用原生用原生）、D3（提供
  provider，不重写 tool）、D11（本机执行族不挂）维持。D4：**问人改走 `ctx.approval`
  seam + 自建 answerer**；四个工具管线挂载点仍承担风险表 / digest / 租户 / 预算 / 账本，
  并且仍然是「决定要不要问」的地方。
- [ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md)：D2 的可写根集合**多一项**
  （草稿根），机制不变——仍然只从 `writableRoots()` 派生；D4 的逐包 `ro_bind`
  成为 skill 闸门的执行面。
- [ADR 0006](0006-user-skill-enablement-gate.md)：P1 的方向（闸门移到启用）被本 ADR
  吸收，但形状改了——不是「把四个工具降到 low + 加 `skill_enable` 工具」，而是
  **取消工具、闸门只在 UI 上**。P1 (A) 由 ADR 0008 D4 的逐包绑定已经满足；(B) 由
  「启用时复制副本」替代内容摘要的常驻校验；(C) 不变。0006 的「拒绝：直接把四个工具
  降到 low」一条已被本 ADR 覆盖，其威胁模型的两条理由仍然成立、仍然由启用闸门承担。
- `api-server/` 仍以零改动为目标。**`frontend/` 不再是零改动**：工具名 `todo_write`
  出厂与我们一致（D4），但**结果形状变了**——出厂 `tool-todo` 的 tool result 是一句
  `Updated todo list: <n> pending, …`，清单本身在 **arguments** 与 `todo/write`
  session event 里。`frontend/src/widgets/runtime-steps/taskStateFields.ts`
  （现在解析 result JSON 取 `todos`）与 `taskStateViews.tsx`、
  `runtime-timeline/cards/ToolExecutionCard.tsx` 必须改成读 arguments 或投影事件，
  否则 todo 卡片静默退化成一行文本；memory 卡片按 D10 无数据。
  SSE 契约、审批中心与提问应答的 URL 不动。
- `exec/`：新增草稿根的挂载与可写根，`/internal/v1/fs/*` 增加搜索的对外形状（D8）。
- **依赖面**：加 `@deepseek-ai/dsh-tool-ask-user`、`@deepseek-ai/dsh-mcp-client`；
  删钉死的 `pi-mcp-adapter@2.11.0` 与 `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.ts`
  （`STATUS.md` A3 可翻转）。
- 实施落地时再改 `architecture.md` 的工具面描述、`api.md` / `webui.md` 的 skill 面、
  `STATUS.md` 的 A2 取证对象。
