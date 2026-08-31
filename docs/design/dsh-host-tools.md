# ADR 0009 实施计划：出厂工具挂 host、application 做管家

**写于 2026-08-31。** 决策见 [ADR 0009](../adr/0009-dsh-host-tools-and-application-steward.md)，
本文件只做**任务分解与验收**，不改决策。分支 `refactor/dsh-rebuild`，核对基线 `a1b58559`。

继承 [`waves/_shared.md`](waves/_shared.md) 的全部约束。特别是那条硬规矩：

> 新增路由 / 新增装配的验收用例必须断言**语义**。写完先问一句：
> **空实现能不能让这条用例通过？** 能就重写。

---

## 0. 现状复核（2026-08-31 逐条对代码核过）

ADR 每条 D 都带「现状差距」。逐条核完，**决策不用动，任务书要动三处**。

| ADR | 差距写的 | 代码实际 | 处置 |
|---|---|---|---|
| D1 | 无 | 无 | — |
| D2 | 后两类未写 | `cordis.patch.yml` 只有凭据 / LLMIO / 关本机族 / remote-{fs,shell,jobs} / subagent | H2 |
| D3 | 出厂工具未激活 | **不准确，见 ①** | H0 先取证 |
| D4 | 四处都是 Pi 名单 | 属实，但**四处今天就已彼此漂移，见 ②** | H1 改做法 |
| D5 | `approval` / `permission` 都 disabled；answerer 不存在 | 属实（`cordis.patch.yml`）；`pi-run-resume.ts` 在 application 侧重放 | H2 + H4 |
| D6 | 整表未接线 | 属实 | H2/H4/H5/H6 |
| D7 | 草稿根不存在；`writableRoots()` 只返回 workspace + temp | 属实（`exec/src/fs/writable-roots.ts:20-25`）；**退役面比 ADR 列的大，见 ③** | H6 |
| D8 | `tool-fs-search: disabled` 且无替代 | 属实，`boot.test.ts:37` 还把它钉在「必须 disabled」清单里 | H2 |
| D9 | `dsh-mcp-client` 未加依赖 | 属实；`agent/package.json:63` 仍钉 `pi-mcp-adapter@2.11.0` | H7 |
| D10 | 无 | 无 | — |
| D11 | `extensionBundleFactory` 生产 6 处 / 测试 5 处 | 属实（`pi-run-executor.ts:138/240/495/576/594`、`container-run-executor.ts:109/165/284`、`pi-run-executor-deps.ts:55`、`container.unit.test.js:364-416`） | H8 |

### ① D3「出厂工具未激活」不准确

`cordis.patch.yml` **没有任何一行**关掉 `tool-fs` / `tool-bash` / `tool-todo` /
`tool-skill` / `tool-subagent` / `tool-jobs`；`tool-subagent` 反而被显式调过参
（`provider: spawn`、`toolName: subagent`），`boot.test.ts:50` 还断言
`tool-fs` **不得**出现 `disabled: true`。

真实差距是**没有取证**：现有 `boot.test.ts` 对 YAML 做字符串匹配，唯一那条
起栈的用例只断言 `bootEnterpriseRuntime` 是个函数（`boot.test.ts:74`：
「全树 boot 留给真实链路」）。**没有人验证过 boot 之后 `ctx.tools` 里到底有什么。**

于是 D3 的实际待办收窄成四项，其余全是「未取证」：
`tool-fs-search` 关着且无替代（D8）、`approval` 关着（D5）、
`dsh-tool-ask-user` / `dsh-mcp-client` 两个包不在依赖里、`toolPolicy` → 闸门未接线。

**这改变了开工顺序**：H0 先起栈打印注册表（零代码改动），拿到真实工具名清单，
H1 的改名才有依据——否则是照着 ADR 里从 tarball 读出来的名字盲改。

### ② 四处工具名单今天就已经彼此漂移

D4 说「四处必须同一次改齐」。核下来它们**现在就不齐**：

| 位置 | 独有的 |
|---|---|
| `agent/src/runtime/policy/risk-table.ts:11-30` | `process_poll`、`process_write_stdin` |
| `agent/src/infrastructure/dsh/constants.ts:15-19` | `process_status`、`process_read`、`python` |
| `agent/src/infrastructure/dsh/tool-risk-classifier.ts:6-16` | 引 `SANDBOX_TOOL_NAMES` + `check_subagent` |
| `config/agent/tool-risk.json` | `skill_create`、`skill_edit`、`todo_read`（D4 的死条目清单里没有这三个） |

四处描述同一件事（进程族工具叫什么）却给出两套名字，说明**「同一次改齐」这个做法
本身不成立**——它已经失败过一次。H1 因此不是「改四处」，而是：
把工具名收成 `constants.ts` 里一份导出常量，另外两处 TS **引用**它，
`tool-risk.json` 由启动期断言校验「表里每个 key 都在常量里」，对不上就 fail-fast。
改名从此只有一个入口。

### ③ D7 的退役面比 ADR 列的大

ADR 点名 `source-digest.ts` + 风险表 `skill_install: 'high'` + `tool-risk.json` 条目。
实际还有：

- `agent/src/skills/install.ts:595-728` —— `skill_edit` 的整套参数校验（路径、字节上限、
  文件数上限、单包约束、去重、超时），约 200 行，只服务于那个工具。
- `agent/src/skills/manager.ts:317` —— 「Call `skill_install` again with the current digest」
  的重试文案，属于 digest 重放路径。

H6 的删除清单要连这两处一起算，否则留下引用不存在工具的死代码与错误文案。

---

## 1. 阶段划分与依赖

```text
H0 取证（零改动）
 └─> H1 工具名单单一事实源 + 存量 toolPolicy 别名   ← 阻塞其余全部
      ├─> H2 overlay：补两个包 / 开 approval / remote-fs-search
      │    ├─> H3 ALS 与租户隔离取证
      │    ├─> H4 approval answerer + 重放式续跑
      │    ├─> H5 durable ctx.subagents
      │    └─> H7 MCP 换出厂包
      ├─> H6 skill 草稿根 + 启用闸门（只依赖 H1，可与 H2 并行）
      └─> H8 死装配删除（依赖 H5 完成后才能删 spawn 侧）
H9 前端适配 + compose 端到端  ← 依赖 H2/H4/H6/H7
```

关键路径：**H0 → H1 → H2 → H4 → H9**。H6 与 H7 可并行挂在 H1/H2 之后。

---

## H0 起栈取证（零代码改动，半天）

**为什么排第 0**：见复核 ①。今天没有任何证据说明 boot 之后循环上有哪些工具。

**做**
1. 起真实插件树（`bootEnterpriseRuntime`），打印 `ctx.tools` 注册表的全部工具名与来源插件。
2. 对照 ADR D4 的「真实注册名」表逐项核；有出入以运行时为准并回写 ADR 表。
3. 顺手确认三件 ADR 留作「装好包之后确认」的事：
   - `dsh-mcp-client` 有没有按 agent/session 收窄注册面的机制（D9 第 4 条）；
   - `tool-todo` 的 tool result 与 `todo/write` session event 的真实形状（D9「影响」段与 H9 直接相关）；
   - `tool-subagent` 在 `backgroundMode: one-shot` 下的实际注册名。

**交付**：`docs/evidence/` 下一份带日期的注册表 dump + 三条确认结论。

**验收**：dump 是进程真实输出，不是从 tarball 或文档抄的。

---

## H1 工具名单收成单一事实源 + 存量 `toolPolicy` 别名（阻塞项）

**为什么第一**：风险表与分类器 fail-closed（未知工具 → `deny`/`critical`）。
先动别的，每一步都表现为「工具被拒」，且看不出是哪一步的错。

**改**
- `agent/src/infrastructure/dsh/constants.ts` —— 新的工具名常量成为唯一事实源：
  新增 `glob`、`job_list`、`job_output`、`job_kill`、`skill`、`subagent`、
  `ask_user_question`、`read_image`；保留 `read`/`write`/`edit`/`bash`/`grep`/`todo_write`/`submit_artifact`；
  删 `ls`/`find`/`python`/`process_*`。
- `agent/src/runtime/policy/risk-table.ts:11-30` —— `LOCAL_TOOLS` 改为引用常量，不再自己列。
- `agent/src/infrastructure/dsh/tool-risk-classifier.ts:6-16` —— 同上；`ask_user` → `ask_user_question`；
  `check_subagent` 随 `spawn_subagent` 一起去掉（`tool-subagent` 是单工具面）。
- `config/agent/tool-risk.json` —— key 换新名；**启动期加断言**：表里每个非 `mcp__` 前缀的 key
  必须在常量里，对不上 fail-fast（这条断言是本阶段防漂移的真正交付，比改名本身重要）。
- **别名映射**（新增）：旧名 → 新名的只读表，作用于 AgentVersion `configJson.toolPolicy` 的读取路径
  （`agent/src/application/tool-risk-bindings.ts:108-138`）。`configJson` 是 Run 创建时冻结的
  不可变快照，不回写、不迁移，只在读时投影。

**别名表**（ADR D4 的死条目 + 复核 ② 补的三个）

| 旧 | 新 |
|---|---|
| `ls`、`find` | `glob` |
| `process_start` / `process_status` / `process_read` / `process_poll` / `process_write_stdin` / `process_kill` | `job_list` / `job_output` / `job_kill`（语义不一一对应，按「进程族 → 作业族」整体映射，理由码稳定） |
| `skill_list` / `skill_install` / `skill_uninstall` / `skill_create` / `skill_edit` | `skill` |
| `spawn_subagent` / `check_subagent` | `subagent` |
| `ask_user` | `ask_user_question` |
| `todo_read` | `todo_write` |
| `python` | `bash` |
| `memory_write` / `memory_search` | **无**（D10 不做，映射到 deny 并给稳定理由码 `TOOL_RETIRED`） |

**验收（语义）**
- 一条用例：喂一份**旧名** `toolPolicy` 的 AgentVersion 快照，断言新工具名拿到的是旧名对应的决定
  （不是 `unknown` → deny）。空实现（原样返回）过不了这条。
- 一条用例：`tool-risk.json` 里塞一个常量里没有的 key，断言启动**抛错**而不是静默。
- 一条用例：`memory_write` 被拒且理由码是 `TOOL_RETIRED`，不是 `unknown`。

**风险**：别名表本身就是一层可能漂的东西。缓解是它**只读、不回写、只服务存量快照**，
并在表上写明「不接受新增条目；新工具直接用新名」。

---

## H2 Overlay：补两个包、开 `approval`、插 `remote-fs-search`

**改** `agent/src/runtime/plugins/manifest.ts`（事实源）后 `npm run gen:patch`：
- `FACTORY_TUNING` / `DISABLED`：`approval` 从 `disabled` 改为开启并配置；`permission` **保持 disabled**
  （D5 已查清两者无依赖关系）。
- `ADDITIONS`：`remote-fs-search`（注册名必须是 `glob` / `grep`，与出厂一致，D8）；
  `enterprise-approval-answerer`（H4 实现，本阶段先占位注册以便起栈）。
- `agent/package.json`：加 `@deepseek-ai/dsh-tool-ask-user`、`@deepseek-ai/dsh-mcp-client`，
  版本钉 `0.1.1-rc.2`（与 `PINNED_DSH_VERSION` 一致）。
- `agent/tests/runtime/boot.test.ts:37` —— `tool-fs-search` 从「必须 disabled」清单移到
  「disabled 且存在同名替代」的断言。

**验收（语义）**
- 起全树 boot（复用 H0 的手法，固化成用例），断言注册表里**同时**有 `glob`、`grep`、
  `ask_user_question`，且 `glob` 的来源是我们的 `remote-fs-search` 而非出厂 `tool-fs-search`。
- 断言 `ctx.approval` 存在而 `ctx.permissionPresets` 不存在。
- 只断言 YAML 字符串的用例不算验收（那正是 ① 里出问题的地方）。

---

## H3 ALS 作用域与租户隔离取证

**背景**：`agent/src/infrastructure/dsh/runtime-factory.ts:286-289` 把
`followup + whenIdle` 整段包在 `runWithExecRpc` 里。H4 去掉阻塞的 `whenIdle` 之后，
必须保证**所有工具执行仍在 ALS 作用域内**（park 只发生在 turn 结束，不在 turn 中途放开），
否则 `agent/src/runtime/providers/exec-rpc.ts:65` 拿不到本 Run 的 RPC 上下文。

**验收（语义，ADR D3 明文要求）**
- 并发两个**不同租户**的 Run，各自触发一次 `read`，断言各自的 RPC 出站带的是自己的
  `orgId/userId/workspaceId/fenceToken`。串台就红。
- 断言并发路径上**没有**对根 ctx 上同一份 provider 做 `rebind`。

---

## H4 审批：自建 answerer + 重放式续跑

ADR D5 的形状：**park + replay**，answerer 不得挂 promise 等人。

**做**
1. `enterprise-approval-answerer` 插件（H2 已注册占位）：监听 `approval/request` waterfall；
   查 durable PENDING（owner-scoped，MySQL）；无决定 → **立刻返回非 allow** → 该次工具调用不落地；
   有决定 → 按 `callId` + args digest 返回 `allowed-once` / `rejected`。
2. `tools/pre-execute` 保持不动：仍按 `config/agent/tool-risk.json` 判 `ask`、仍铸 PENDING 记录
   （`pre-execute.ts:76-84` 的 `argsCanonical` + digest 是审批记录的唯一来源，seam 不带参数不影响它）。
3. Executor：pending → 停泊 `WAITING_APPROVAL` → **释放 Worker**；
   续跑时重建 DSH 会话并**重放那次 tool call**。
4. 退役 `agent/src/application/pi-run-resume.ts` 的 application 侧重放
   （`pi-run-resume.ts:135/231` 的 `replaceSuspendedToolResultInSession`）；
   `ask_user` 的续跑同样改成重放。HTTP 形状（decide / respond URL）不变。

**验收（语义）**
- 一条用例：审批停泊后 Worker **确实被释放**（断言 lease 归还 / 进程不再持有），
  而不是 promise 挂着。
- 一条用例：批准后**换一个进程**续跑，同一 `callId` 的工具真的执行了一次、且只执行一次。
- 一条用例：人点同意之后、落地之前把 args 改掉 → digest 对不上 → **拒绝**。

**风险（ADR 已写明）**：`ctx.approval.request` 必须处在 open turn 内，上游
「a durable out-of-turn approval workflow is deferred」。若 answerer 返回非 allow 后
DSH 的 turn 语义与预期不符（例如它把这当成永久 deny 而不是可重放），H4 会撞墙——
**这是本计划最大的单点风险**，H0 起栈时应顺带探一次。

---

## H5 durable `ctx.subagents`

接到 `SubagentSpawnService`（MySQL + 队列），去掉内存队列当生产路径。
`tool-subagent` 已按 `backgroundMode: one-shot` 调好参（`cordis.patch.yml`），本阶段只补 provider 侧。

**验收**：子 Agent 作业跨 Worker 可恢复；断言内存队列不在生产装配里。

---

## H6 Skill：草稿根 + 启用闸门（可与 H2 并行）

**做**
1. `exec/src/fs/writable-roots.ts:20-25` —— `workspace-write` 模式增加草稿根。
   **只改这一处**：fs 围栏与 bwrap MountPlan 都从它派生（ADR 0008 D2）。
2. 草稿根 `/home/sandbox/skill-draft`，`bind` 读写，**每用户一个**持久目录；
   `LOGICAL_SKILL_ROOTS`（`constants.ts:10-13`）**不包含**它——草稿根不进发现、不进 system prompt。
3. 启用闸门（UI 唯一入口）：复用 `agent/src/skills/manager.ts` 的结构与大小校验，
   输入从「上传的 zip」换成「草稿目录」；通过后**把字节复制成一份只读的已发布副本**；
   记内容摘要与启用态（owner-scoped MySQL 表）。
4. 前端 skill 上传改为解包直接写进同一个草稿根，走同一条启用路径。
5. **退役**（含复核 ③ 补的两处）：`agent/src/runtime/policy/source-digest.ts`；
   `risk-table.ts:55` 的 `skill_install: 'high'`；`tool-risk.json` 对应条目；
   `agent/src/skills/install.ts:595-728` 的 `skill_edit` 校验；
   `agent/src/skills/manager.ts:317` 的 digest 重试文案。
6. `skills/skill-creator` 补写用户侧 skill 的目录形状 / 写在哪 / 怎么自测 / 怎么让用户启用；
   企业条款 prompt 里的路径指到草稿根。

**验收（语义）**
- 断言 `tool-skill` 的发现结果里**没有**草稿根里的包；system prompt 里也没有。
- 断言模型改草稿目录**不会**改到已启用副本的字节（两份字节，这是 ADR 0006 P1 (B) 的绕过被消掉的证据）。
- 断言系统 skill 在任何模式下都写不了（`ro_bind` 仍在）。
- 断言启用是复制而不是挂载草稿目录（改草稿后重跑，已启用包内容不变）。

**明确接受的风险**（ADR 已写，此处照抄以免实施时当疏忽）：写入用户侧 skill 不再经审批，
`write`/`bash` 是 low，模型可以在草稿里放脚本并执行——与「在 workspace 里写脚本再跑」同级。

---

## H7 MCP：出厂 `dsh-mcp-client` 替换 `pi-mcp-adapter`

**做**
1. `manifest.ts` 从 `MCP_SERVERS_JSON` 生成**每 server 一条** insert
   （`id: mcp-<server>`，`name: '@deepseek-ai/dsh-mcp-client'`，config 见 ADR D9），
   仍经 `npm run gen:patch`。
2. 密钥只走 secretRef → env 的解析（留在我们代码里）；**patch YAML 里不得出现明文**。
3. 退役 `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.ts` 与
   `agent/package.json:63` 的 `pi-mcp-adapter@2.11.0`；`container-mcp.ts` 的自建发现随之删。
4. `tool-risk.json` 的 `mcpServers` 现在是**空的** —— 必须为每个 server 补
   `mcp__<server>__*` 前缀条目：出厂包对超长/非法名会规范化并追加 12 位十六进制哈希，
   那种工具匹配不上精确 key，只能靠前缀兜底。
5. `/ready` 的 MCP 就绪度改成投影 DSH tool 注册表 + 插件日志，不再投影 adapter 快照。
6. 可见性按 D9 第 4 条：H0 已确认有无按 agent/session 收窄的机制；确认不了就接受
   「全量可见 + 逐调用拒绝」，**不为此引入 preset**。

**验收（语义）**
- 断言一个真实 MCP server 的工具以 `mcp__<server>__<name>` 出现在注册表里并**能调通**。
- 断言 AgentVersion 没引用的 server 的工具**被 `pre-execute` 拒**，理由码稳定。
- 断言生成的 patch YAML 里搜不到任何密钥明文。

**已知限制（出厂包自陈）**：只桥接 Tools，Resources / Prompts 不做；
连接与 `tools/list` 超时吃 MCP SDK 的 60s 默认；streamable-http 的失败逐调用暴露。

---

## H8 死装配删除

删 `extensionBundleFactory` 及其转发链：`pi-run-executor.ts:138/240/495/576/594`、
`pi-run-executor-deps.ts:55`、`container-run-executor.ts:109/165/284`、`container.ts:680` 注释；
改写 `tests/bootstrap/container.unit.test.js:364-416` 等 5 处断言转发的用例。
同批删无人调用的 `createTaskStateStore` 与未接线的 spawn 工厂（**依赖 H5 完成**）。
diagnostics 改为投影 DSH tool 注册表；`getAllTools()` 不再把 `fs/shell/jobs` 三个 provider 当工具。

**验收**：`grep -rn extensionBundleFactory agent/src` 零命中；测试套仍绿且**不是**因为被删掉。

---

## H9 前端适配 + compose 端到端

**前端（不再是零改动）**：`tool-todo` 的 tool result 是一句
`Updated todo list: <n> pending, …`，清单在 **arguments** 与 `todo/write` session event 里。
`frontend/src/widgets/runtime-steps/taskStateFields.ts:70`（现在从 result JSON 取 `todos`）、
`taskStateViews.tsx`、`runtime-timeline/cards/ToolExecutionCard.tsx` 必须改成读 arguments 或投影事件，
否则 todo 卡片静默退化成一行文本。memory 卡片按 D10 无数据。
SSE 契约、审批中心与提问应答的 URL 不动。

**compose 端到端**：登录 → 建会话 → 带工具 Run → 一轮审批停泊与续跑 → 一次草稿建 skill 并启用。

**验收**：真实 bwrap + 现有 LLMIO 网关下跑通；证据落 `docs/evidence/`。
改运行时装配必须起栈，**不能只靠单测**。

---

## 2. 开工前必须先答的问题 —— **已全部答完（2026-08-31）**

证据：[`../evidence/2026-08-31-dsh-tool-registry.md`](../evidence/2026-08-31-dsh-tool-registry.md)

| 问题 | 答案 | 影响 |
|---|---|---|
| answerer 返回非 allow 后 turn 会怎样？ | **不结束**，模型又走一步（实测 2 次循环请求） | **D5 停泊第 1 步证伪**，H4 改用 park guard |
| `dsh-mcp-client` 有无按 scope 收窄的机制？ | **有**：`ctx.tools.restrict()`（不是 mcp 包的，是 `ToolRuntime` 的，对所有工具都适用） | H7.7 定案，不引入 preset |
| `tool-todo` 的 result 真实形状？ | `Updated todo list: …` 文本 + `{counts}`；清单在 arguments 与 `todo/write` event | ADR 判断成立，H9.1 照此改 |
| 注册表与 ADR D4 表是否一致？ | **不一致**：多 8 个、少 4 类、`submit_artifact` 不存在 | H1.1 以 dump 为准；新增 H2.0、H1.1b |

### 由 H0 新长出来的两个待决策（不要默默二选一）

1. **H2.0 的 8 个工具**：默认全 `disabled`，理由逐条写在 H2.0 表里。翻转任意一条都只改
   `manifest.ts` 一行 + H1.1 常量一行。
2. **H1.1b 的 `submit_artifact`**：补一个自建 tool 插件，还是承认「产物提交不再是模型工具」。

---

## 3. 连带要改的文档（实施落地时）

`architecture.md` 的工具面描述、`api.md` / `webui.md` 的 skill 面、
`STATUS.md` 的 A2 取证对象与 A3（`pi-mcp-adapter` 退役后可翻转）、
`waves/README.md` 的进度表增加 H0–H9 行。

---

## 3.5 收尾状态（2026-08-31）

**81 条全部完成，零挂起。**

一度被我记成「本环境做不了」的三条，重新评估后都做成了——**两条的理由本身是错的**：

| 曾经的理由 | 实际 |
|---|---|
| H9.6「macOS 上没有 Bubblewrap」 | **错**：`exec` 跑在 Linux 容器里，容器内 `bwrap` 实测可用；LLMIO 网关也可达 |
| H7.8「要 compose 才能连真 MCP」 | **错**：MCP 连接发生在 agent 进程里，不经过 exec，一台官方 SDK 写的 stdio server 就够 |
| H6.7「涉及跨轮改动」 | 是我自己划的范围，不是外部约束 |

### 实施中查出的、ADR 没有预料到的问题

计划抓到的比它原本要做的多得多。按发现阶段分：

**静态分析阶段（H0–H8）**

1. **D5 的停泊机制被实测证伪**——`concludesTurn` 在类型上就不存在于失败结果上。
2. **六处「终止在被忽略的参数上」的装配**：`extensionBundleFactory`、`mcpResolver`、
   `subagentSpawnPort`、`skillManagerFactory`、`riskOverrides`、`ledger`。
   后果分别是审批不落库、MCP 无人加载、子 Run 走内存队列、运维风险表零效果、
   工具账本不记。
3. **共享 provider 的按 Run `rebind`**——ADR D3 明文禁止的写法，代码里已经是它。
4. **审批续跑在 DSH 下本来就跑不通**（`getToolDefinition` 不存在），且**零测试覆盖**。
5. **`resolveToolRiskLevel` 不传 class 会把每个工具报成「配置为 critical」**。
6. **`submit_artifact` 根本没有插件注册**——ADR 说「保留」，而这个能力在 DSH 重建
   之后一直是缺的。工具不存在 ≠ 工具报错，所以没有人发现。

**compose 端到端阶段（H9.6）—— 全部是单测全绿时仍存在的**

7. **自建工具的 `parameters` 抄成了出厂 `defineTool()` 的简写**：注册成功、名字在、
   H2.7 的「恰好相等」也过，**只有真开一轮才被模型提供方拒，整个 Run 失败**。
8. **durable 工具账本没接**：Run 成功、文件落盘，`tool_executions` 一行都没有。
9. **账本失败被静默吞掉**：留下永远 `RUNNING` 的行而无人知晓。
10. **`findResolvedByDigest` 只有委托没有实现**：批准之后续跑又停泊；
    单测用的 `InMemoryApprovalStore` 自己实现了，所以全绿。
11. **草稿根「字段都有、就是没人填」**：类型 / 纯函数 / 挂载计划三层单测全绿，
    而路径围栏根本不认那个逻辑前缀（`SandboxPathScope` 只有两个值），
    模型第一次往草稿写就被拒。

第 2、4、7、8、10、11 条是同一个形状：**一段代码在生产里从来没执行过，
而它的缺席不产生任何信号。** 这也是为什么本计划把「断言组合结果，不是断言配置意图」
反复写进每一条验收里——以及为什么第 7–11 条只能由端到端抓到。

### 仍然敞着的两件事（不在本清单，如实记）

- **启用没有 HTTP 路由**：`manager.enable()/disable()` 已实现并在真环境验证过，
  但还没有接出给人点的那个按钮。
- **一个停泊边界**：并发工具里若有一个撞审批，`agent.cancel()` 会中止整轮，
  当时在飞的另一个工具留在 `tool_executions` 的 `RUNNING` 上。

---

## 4. 任务清单

逐条可勾选。**每条都写了「完成判据」——判据不是「代码写了」而是「什么用例/证据变绿」。**
标 `⛔` 的是阻塞项，未完成不得开始下游阶段。`∥` 表示同阶段内可并行。

### H0 起栈取证（零代码改动）

**✅ 全部完成 2026-08-31。证据：[`../evidence/2026-08-31-dsh-tool-registry.md`](../evidence/2026-08-31-dsh-tool-registry.md)。**
脚本留在仓库里：`agent/scripts/dump-tool-registry.ts`、`agent/scripts/probe-approval-park.ts`。

- [x] **H0.1** `ctx.tools.schemas()` dump：**23 个模型可见工具**。
- [x] **H0.2** 对 ADR D4 表：**多 8 个 ADR 没提的工具，少 `glob`/`grep`/`ask_user_question`/`mcp__*`，
      `submit_artifact` 根本不存在**。
- [x] **H0.3** ⛔ **ADR D5 的停泊第 1 步被证伪**：answerer 返回 `rejected` 后 turn **不结束**
      （实测 2 次循环 LLM 请求）。唯一能停循环的原语是工具**体内**的 `exec.concludeTurn()`。
      H4 已按此重写。
- [x] **H0.4** **有收窄机制**：`ctx.tools.restrict({allow, deny})` 按 agent scope 过滤继承来的工具面。
      H7.7 据此定案，不引入 preset。
- [x] **H0.5** `todo_write` 的 result 只有 `Updated todo list: …` 文本 + `{counts}`，
      清单在 arguments 与 `todo/write` event 里。**ADR 的判断成立**，H9.1 照此改。
- [x] **H0.6**（计划外）发现 `runtime-factory.ts:170-174` **已经在用 ADR D3 明文禁止的
      `rebind` 共享 provider 写法** —— 现存跨租户缺陷，H3 因此改为「修缺陷 + 补断言」。

### H1 工具名单单一事实源 + 别名映射 ⛔（阻塞 H2–H8）

- [x] **H1.1** `constants.ts:15-19` —— `SANDBOX_TOOL_NAMES` 换成新名单，
      **以 H0.1 的 dump 为准，不是以 ADR D4 那张表为准**：
      加 `glob`/`job_list`/`job_output`/`job_kill`/`skill`/`subagent`/`ask_user_question`/`read_image`；
      留 `read`/`write`/`edit`/`bash`/`grep`/`todo_write`；
      删 `ls`/`find`/`python`/`process_*`。
      判据：常量内容 = boot 后 `ctx.tools.schemas()` 的实际集合（H2.7 用例交叉断言两者相等）。
- [x] **H1.1b** ✅ **补回工具，而不是让能力静默消失**。ADR D4 写「`submit_artifact`
      是我们自建的，保留」，但 H0.1 实测发现**根本没有插件注册它**——旧 Pi Extension
      删除后没补，这个产品能力在 DSH 重建之后一直是缺的（工具不存在 ≠ 工具报错，
      所以没有人发现）。
      一度按「退役」处理（映射到 `TOOL_RETIRED`），那是可逆的保守默认，但它让产物
      提交这个能力真的没了。既然 exec 侧 `/internal/v1/artifacts/submit` 一直在，
      新增 `runtime/providers/submit-artifact.ts`（与 `remote-fs-search` 同一形状：
      自建工具插件 + exec RPC，字节永远在 exec 那边）。注册表现在是 **15 个工具**。
- [x] **H1.2** `risk-table.ts:11-30` —— `LOCAL_TOOLS` 改为**引用** `constants.ts`，删掉自己那份字面量。
      判据：文件里搜不到硬编码工具名。
- [x] **H1.3** `tool-risk-classifier.ts:6-16` —— 同上；`ask_user` → `ask_user_question`；
      去掉 `check_subagent`。判据：同上。
- [x] **H1.4** `config/agent/tool-risk.json` —— 25 个 key 换新名。
- [x] **H1.5** ⛔ **启动期断言**：`tool-risk.json` 里每个非 `mcp__` 前缀的 key 必须在常量里，
      否则抛错。判据：塞一个不存在的 key，启动**红**；这条是本阶段防漂移的真正交付。
- [x] **H1.6** 新增只读别名表（旧名 → 新名），接在 `tool-risk-bindings.ts:108-138` 的
      `toolPolicy` 读取路径上。**不回写 `configJson`、不做数据迁移。**
      表头写明「不接受新增条目；新工具直接用新名」。
- [x] **H1.7** `memory_write`/`memory_search` 映射到 deny + 稳定理由码 `TOOL_RETIRED`（D10）。
- [x] **H1.8** 用例：喂一份**旧名** `toolPolicy` 快照，断言新工具名拿到旧名对应的决定。
      判据：原样返回的空实现过不了这条。
- [x] **H1.9** 用例：`memory_write` 被拒且理由码是 `TOOL_RETIRED` 而非 `unknown`。

### H2 Overlay：补包、开 approval、插 remote-fs-search ✅ **完成 2026-08-31**（H2.5 顺延到 H4）

> **落地结果**：boot 之后模型可见的工具面从 23 个收敛到 **14 个，与
> `ENTERPRISE_DEFAULT_TOOLS` 精确相等**：
> `ask_user_question bash edit glob grep job_kill job_list job_output read read_image
> skill subagent todo_write write`。
>
> 两个实跑撞出来的坑，都写进了代码注释：
> 1. `ctx.tools` **必须经 `inject` 声明**，直接取会抛 `cannot get property "tools" without inject`；
> 2. 自建插件模块**不能有 `export default`**——加了之后 loader 取的是那个默认导出函数，
>    看不见 `inject`，于是同样抛。
>
> 验证走**子进程**（沿用 `boot-composition-probe.ts` 的既有做法：boot 起的插件树
> 没有 dispose 接口，留在测试进程里会让 `node:test` 挂住）。断言是**恰好相等**
> 而不是「包含」——「包含」抓不到「多出来一个」，而多出来正是 H0 撞到的事故形状。

- [x] **H2.0** ⛔ **处置 H0.1 查出的 8 个 ADR 没预料到的已注册工具**。它们在 fail-closed 分类器下
      全部会被拒，所以必须先定去留。**默认按 ADR 自身的原则一律 `disabled`**（理由逐条见下），
      每条都可单独翻转：

      | 插件 id | 工具 | 默认处置理由 |
      |---|---|---|
      | `web-search-deepseek`、`tool-web` | `web_search` | agent 进程直接出网；`plan.md` §12「业务数据只能通过受控的数据库 MCP 获取」 |
      | `tool-workflow`、`workflow-worker-thread` | `workflow` | 在本进程 worker thread 里跑 JS = 本机执行面，ADR 0007 D11 |
      | `tool-ralph` | `ralph` | 无预算/账本约束的自主重试循环，不在本 ADR 范围 |
      | `tool-subagent-fork`、`subagent-fork-in-process` | `subagent_fork` | in-process fork，与 D6 的 durable 子 Agent 冲突（`subagent-spawn-in-process` 已关） |
      | `tool-subagent-control`、`tool-subagent-list-agents` | `interrupt_agent`、`list_agents`、`send_message` | 面向**可续聊**子 Agent，而我们是 one-shot（见 `cordis.patch.yml` 注释） |
      | `tool-goal` | `create_goal`、`get_goal`、`update_goal` | 会话内目标状态机，无企业面与前端卡片，属 D10 式「本阶段不做」 |
      | `plan-mode` | `exit_plan_mode` | 同上 |
      | `tool-str-replace-editor` | `str_replace_editor` | 与 `read`/`write`/`edit` 重复，「同一件事两处各算一遍」 |

      判据：H2.7 的 boot 用例断言 `schemas()` 的集合**恰好等于** H1.1 的常量，多一个少一个都红。
- [x] **H2.1** `agent/package.json` 加 `@deepseek-ai/dsh-tool-ask-user`、`@deepseek-ai/dsh-mcp-client`，
      版本钉 `0.1.1-rc.2`（与 `constants.ts:4` 的 `PINNED_DSH_VERSION` 一致）。
      判据：装完 `npm ls` 无 peer 冲突。
- [x] **H2.2** `manifest.ts` —— `approval` 从 `DISABLED` 移出并配置；**`permission` 留在 `DISABLED`**。
      判据：`npm run gen:patch` 后 YAML 里 `approval` 无 `disabled: true`、`permission` 有。
- [x] **H2.3** ∥ 实现 `runtime/providers/remote-fs-search.ts`，打 exec `/internal/v1/fs/*`；
      **注册名必须是 `glob` 和 `grep`**。判据：注册名与出厂完全一致，换回出厂实现时零处要改。
- [x] **H2.4** `manifest.ts` `ADDITIONS` 插 `remote-fs-search`；`tool-fs-search` 保持 disabled。
- [x] **H2.5** ✅ **由 H4.1 完成，且落点与计划不同**：answerer 装在
      `installEnterprisePolicy` 的第 5 个挂载点（**每 Run 的 agent scope**），
      不是 overlay 里的进程级插件——审批 store 是按 Run 的，而 seam 支持
      agent-scoped 监听器。做成进程级插件反而要再造一条把本 Run 的 store 递进去的通路。
      H2 阶段没有插空壳，理由：`dsh-user-approval` 在没有 answerer 时 fail-closed 到
      `unavailable`，那本身就是正确的中间态；占位反而会让未完成的部分看起来像在工作。
- [x] **H2.6** `boot.test.ts:37` —— `tool-fs-search` 从「必须 disabled」清单移到
      「disabled 且存在同名替代」的断言。
- [x] **H2.7** ⛔ **起全树 boot 的用例**（把 H0.1 的脚本固化）：断言注册表里同时有
      `glob`/`grep`/`ask_user_question`，且 `glob` 来源是 `remote-fs-search` 不是 `tool-fs-search`；
      断言 `ctx.approval` 存在、`ctx.permissionPresets` 不存在。
      判据：**只匹配 YAML 字符串的用例不算验收**（`boot.test.ts:74` 那种「留给真实链路」到此为止）。

### H3 修跨租户缺陷 + ALS 作用域取证 ✅ **H3.0–H3.2 完成 2026-08-31**（H3.3 等 H4）

> **缺陷范围比初稿窄，写清楚免得日后误引**：租户身份（org/user/workspace/fence）
> 本来就安全，`ExecRpcClient.envelope()` 走 ALS。被 `rebind` 改坏的是
> **`physicalRoots`**——脱敏根，每 Run 不同，且不走 ALS。后果是并发时
> A 的未分类错误按 B 的根脱敏，**A 的真实物理路径原样漏进错误消息**。
>
> 修法：三个 provider 的 `roots` 从字段改成读 ALS 的 getter；
> `runtime-factory` 里那段 `p.rebind(rpc)` 删除。租户上下文只剩 ALS 一条通路。
> 顺带改写了 `tests/pi/dsh-runtime-factory.unit.test.js` 里那条**断言了错误行为**
> 的用例（它原本要求「每个 Run 都 rebind 一次」）。

> **H0.6 已确认这不是「补断言」而是「修缺陷」**：`runtime-factory.ts:170-174` 现在就是
> ADR D3 明文禁止的写法——`ensureCtx` 用 `bootOnce` 全进程共用一个根 ctx，
> `createRemoteProviders()` 在已挂载时返回**同一份实例**，然后每个 Run 对它 `rebind(rpc)`。
> 两个并发 Run，后一个 `rebind` 覆盖前一个。

- [x] **H3.0** ⛔ 先写**会红的**用例：并发两个不同租户的 Run，各触发一次 `read`，
      断言各自 RPC 出站带自己的 `orgId/userId/workspaceId/fenceToken`。
      判据：**在修之前这条必须是红的**——不红说明用例没测到真正的并发路径。
- [x] **H3.1** 修：provider 实例不再被 Run 改写。`rebind` 从每 Run 的装配路径上去掉，
      租户上下文只经 `runWithExecRpc` 的 ALS 传递（`exec-rpc.ts:65` 的 `currentExecRpc`
      本来就是 ALS 优先、构造值兜底）。判据：H3.0 转绿。
- [x] **H3.2** 用例：断言生产装配路径上**搜不到**对共享 provider 的 `rebind` 调用。
- [x] **H3.3** ✅ **前提没有发生，风险自然消解**。ADR D3 担心的是「D5 去掉阻塞的
      `whenIdle` 之后，工具执行会跑到 ALS 作用域外」。H4 落地的形状**没有去掉
      `whenIdle`**：停泊靠 `agent.cancel()`，它让 `whenIdle()` 立刻返回，
      整轮仍然完整地包在 `runWithExecRpc` 里（`runtime-factory.ts:286-289` 未动）。
      所以「park 发生在 turn 结束时，不是 turn 中途放开」这条约束是**按构造满足**的，
      不是靠额外断言守住的。H3.0/H3.2 在 H4 之后重跑仍绿（1150/1150）。

### H4 审批 answerer + 重放式续跑（**形状已按 H0.3 实测改写**）

> **ADR 0009 D5 的停泊第 1 步被实测证伪**（证据见 evidence 附录）：answerer 返回
> `rejected` 之后 **turn 不会结束**，模型拿到错误型 tool result 后循环又走了一步。
> 类型层面也是关死的：`concludesTurn` 只存在于 `ToolExecutionSuccess`，
> `ToolExecutionFailure` 上是 `never`——**被拒的调用在类型上就不可能结束 turn**。
> 唯一能停循环的原语是工具**体内**的 `exec.concludeTurn()`，而出厂工具的体不是我们的。
>
> **改成的形状（已落地 H4.1/H4.1b/H4.2/H4.7）**：answerer 判定 PENDING 时**同步**调
> `agent.cancel({kind:'hook', reason:'RUN_PARKED_AWAITING_APPROVAL'}, {keepInbox:true})`
> ——turn 立刻结束，**不多走模型往返**（实测 1 次，稳定 3/3）；同时装 park guard，
> 此后本轮任何工具一律拒。两者叠加不是重复：cancel 中止的是活动中的 turn，
> guard 兜住「循环已经把下一次请求发出去」那条路径。cancel **必须同步调**。
>
> **answerer 装在每 Run 的 agent scope 上（`installEnterprisePolicy` 的第 5 个挂载点），
> 不是 overlay 里的进程级插件**——审批 store 是按 Run 的，而 seam 支持 agent-scoped
> 监听器（"Agent-scoped listeners receive only that agent's requests"）。
> 做成进程级插件反而要再造一条把本 Run 的 store 递进去的通路。

- [x] **H4.1** 实现 `enterprise-approval-answerer`：监听 `approval/request` waterfall；
      查 durable PENDING（owner-scoped MySQL）；无决定 → 写 PENDING 并返回 `rejected`；
      有决定 → 按 `callId` + args digest 返回 `allowed-once`/`rejected`。
      **不得挂 promise 等人。**
- [x] **H4.1b** ⛔ **park guard**：写完 PENDING 的同时，在该 Run 的 agent scope 上装一个
      `ctx.tools.guard()`，此后本轮**任何**工具调用一律拒，理由码固定
      `RUN_PARKED_AWAITING_APPROVAL`。`guard()` 是单调 fail-closed 的
      （"no guard can force-allow a call another guard denied"），正好承担这件事。
      装在 `setup(agentCtx)` 给的**每 Run scope** 上，不是根 ctx。
      判据：用例——停泊后模型再调任何工具都被拒，且 turn 在**一次**额外模型往返内结束。
- [x] **H4.2** 确认 `tools/pre-execute` **一行不改**：仍判 `ask`、仍铸 PENDING 记录
      （`pre-execute.ts:76-84` 的 `argsCanonical` + digest 是审批记录唯一来源）。
      判据：diff 为空。
- [x] **H4.3** ⚠️ **实施时发现这条链整条断着**：真正落库并把 Run 迁到
      WAITING_APPROVAL 的是 `FencedToolGovernanceRecorder.requestApproval()`，
      而它**只经 `extensionBundleFactory` 到达运行时**——那批 Pi Extension 在 DSH
      重建时已经删了。于是 DSH 的策略挂载点用的是进程内 `InMemoryApprovalStore`：
      判定对，但**不落库、不发事件、不停泊 Run、不释放 Worker**。
      新增 `application/governance-approval-store.ts` 把两端接上，按 Run 装配
      （store 绑着这个 Run 的 fence/runId/scope，做成进程级会把 A 的审批记到 B 的 Run）；
      `runSuspensionPort` 从 `extensionBundleFactory(...)` 的内联字面量提成局部常量
      ——现在有两个消费者，且 H8 删掉那个 factory 时不受影响。
- [x] **H4.4** 续跑改成**按参数指纹认已落库的决定**。实现落在 `tools/pre-execute`
      而不是 answerer 里，理由是审批 seam 的请求**不携带 arguments**（出厂自陈的
      已知限制），拿不到指纹就绑不了字节；而 `pre-execute` 那里 args 齐全
      ——ADR D5 的原话也是「digest 与租户 / fence 仍在 `tools/pre-execute` 上核」。
      续跑时模型重新发起的调用带的是**新 callId**，所以只按 callId 查必然查不到；
      跨会话能对上的只有 digest 这一半。授权是**一次性**的（出厂词表只有
      `allowed-once`），命中后立刻 `consume()`。
- [x] **H4.5** ⚠️ **实施时发现这条路径在 DSH 下本来就是坏的**：它调
      `runtimeSession.getToolDefinition(...)`，而 DSH 的 session 根本没有这个方法
      ——所以「审批能停泊，但批准之后续不回去」。**而且它一个测试都没有**，
      这正是它坏了没人发现的原因。已改成只回一段续跑提示（执行者是循环），
      并补上 `tests/pi/approval-resume.unit.test.ts`：其中一条给 session 塞一个
      会爆炸的 `getToolDefinition`，谁把老路径加回来就立刻红。
      `resolveApprovedReplayArgs` 从「恢复不出就抛」改成「返回 null」——
      当时必须抛（application 要亲自拿这组参数去执行），现在参数由模型重新发出、
      由指纹核对，恢复不出只影响审计写得细不细，抛出去反而会打死一次合法续跑。
      `ask_user` 的续跑（`prepareInteractionResume`）**未动**，仍是 splice 式，
      留给后续——它停泊的是提问不是工具，不走审批那条路。
- [x] **H4.6** 审批中心 / 提问应答的 HTTP 形状与 URL **未动**：
      `approval-decision-service.ts` 一行没改，相关契约用例零改动仍绿（1150/1150）。
- [x] **H4.7** 用例：审批停泊后 Worker **确实被释放**（断言 lease 归还），不是 promise 挂着。
- [x] **H4.8** 用例：批准后换一个 callId 续跑，同一组参数放行**恰好一次**
      （第三次又回到 require_approval）。跨进程的真实续跑留到 H9 的 compose 端到端。
- [x] **H4.9** 用例：人点同意后、落地前把 args 改掉 → 指纹对不上 → 那条批准查不到 →
      **重新走审批**（不是静默放行）。

### H5 durable `ctx.subagents` ✅ **完成 2026-08-31**

> **又一条断掉的链**（与 H4.3 同形）：`SubagentSpawnService` 挂在
> `container-run-executor.ts` 的 `subagentSpawnPort` 上，而那个 port **只喂给
> `extensionBundleFactory`**——终止在一个被 `runtime-factory.create()` 忽略的参数上。
> 与此同时 provider 用的是 `InMemoryDurableSubagentQueue`，Worker 一重启子 Run 全丢
> ——正是那个 provider 文件头说要避免的事。
>
> **接法**：新增 `runtime/providers/run-services.ts`（第二个 ALS，与 `exec-rpc.ts`
> 同一机制）。provider 是 boot 时注册一次的进程级单例，而队列绑着这个 Run 的事务与
> 租户 scope，只能在**调用时**按 Run 取。`prompt()` 现在同时进两层 ALS。
> 这也解释了 ADR D3 为什么把「ALS 罩住所有工具执行」写成硬约束——不止 fs/shell/jobs 靠它。
>
> 新增 `application/durable-subagent-port.ts` 把 `SubagentSpawnService` 适配成
> 队列/存储：`add()` → 一次 durable `spawn()`（jobId 当幂等键），
> `getResult()` → 查子 Run 终态。`putResult()` 故意留空：durable 形态下结果由子 Run
> 自己的 executor 写，父进程写反而会和子 Run 的终态打架。

- [x] **H5.1** `durable-subagent.js` provider 接到 `SubagentSpawnService`（MySQL + 队列）。
- [x] **H5.2** 内存队列从生产装配里去掉。判据：装配路径上搜不到它。
- [x] **H5.3** 用例：`tests/runtime/durable-subagent-port.test.ts` 3 条
      （走 durable spawn 而非进程内队列 / 结果按子 Run 终态兑现 / ALS 外才回退）。
      **真正的跨进程恢复留到 H9 的 compose 端到端**——单测证明的是接线与语义，
      「杀掉进程另一个结算」要真 MySQL + 真 BullMQ。

### H6 Skill 草稿根 + 启用闸门 ✅ **除 H6.7 外完成 2026-08-31**

> **实施中抓到一个自己引入的缺口**：第一版 `enableDraftPackage()` 没有挡「与系统
> skill 同名」。是 `skills-install-ergonomics.test.js` 里那条既有用例
> （"uploaded and generated Skills cannot shadow bundled Skills"）在删 `skill_create`
> 时失败才暴露的——ADR 0009 D7 明确引了这条不变量（"an installed skill must never
> be able to shadow or overwrite one the platform vouches for"），差点跟着旧工具
> 一起被删掉。检查搬到**启用**那一刻是对的：草稿叫什么名字无所谓，它不进任何人的
> 上下文；危险的是同名包被挂进 `skill-user/` 之后盖住平台背书的那一个。

- [x] **H6.1** ⛔ `exec/src/fs/writable-roots.ts:20-25` —— `workspace-write` 增加草稿根。
      **只改这一处**（fs 围栏与 bwrap MountPlan 都从它派生，ADR 0008 D2）。
      判据：搜不到第二处各算一遍的地方。
- [x] **H6.2** 草稿根 `/home/sandbox/skill-draft`：`bind` 读写、**每用户一个**持久目录、进 MountPlan。
- [x] **H6.3** ⛔ `constants.ts:9-13` 的 `LOGICAL_SKILL_ROOTS` **不得**包含草稿根。
      判据：用例断言 `tool-skill` 发现结果里没有草稿包、system prompt 里也没有。
- [x] **H6.4** 启用闸门：复用 `skills/manager.ts` 的结构与大小校验，输入从 zip 换成草稿目录。
- [x] **H6.5** 启用时**把字节复制成只读的已发布副本**（不是挂载草稿目录）。
      判据：用例——改草稿后重跑，已启用包内容不变。
- [x] **H6.6** 启用态与内容摘要落 owner-scoped MySQL 表（ADR 0006 P1 (C)）。
- [x] **H6.7** ✅ **做成了，之前的「跨轮改动」是我自己过度收缩**。
      `manager.install()` 的目标根改成**该用户的草稿根**
      （`draftSkillRootFor({orgId,userId})`，与已启用根同样是 `<base>/<orgId>/<userId>`）；
      新增 `manager.enable()` / `manager.disable()` 走 `skills/enablement.ts` 的同一条闸门。
      上传与模型创建从此是同一个故事：都落在草稿里，都要人按一下才进 prompt 与只读挂载。
      用例断言上传后**已启用根仍是空的**——绕过闸门的话，两条路径的语义就分叉了。
      审计里 `action` 从 `install` 变成 `draft`，摘要写明「a human must enable it」。
- [x] **H6.8** ⚠️ **ADR D7 的「一并退役 `source-digest.ts`」写宽了，只退役了一半**：
      `assertSourceDigest()`（`skill_install(source=sandbox)` 专用）已删；
      但 `digestArgs()` 与 `rejectMismatchedDigest()` **必须留着**——它们是 D5 审批续跑的
      承重件（`pre-execute` 铸 PENDING 时记的 `sourceDigest` 就是它算的，重放时靠它挡住
      「批准的是 A、落地的是 B」）。整个删掉等于把 D5 的指纹校验一起删了。
- [x] **H6.9** 退役 `risk-table.ts:55` 的 `skill_install: 'high'` + `tool-risk.json` 对应条目。
- [x] **H6.10** 退役 `skill_edit`（约 170 行校验）与 `skill_create`（`createGeneratedSkill`），
      连同 `manager.edit()` / `manager.create()`——**它们没有任何生产调用方**，
      唯一通路 `skillManagerFactory` 只喂给已删除的 extension bundle。
      删掉的 5 条用例逐条在文件里注明了「它守的东西搬去了哪」：
      路径安全 / 符号链接 / VCS 元数据 / 大小与文件数上限现在由**启用时**的
      `inspectDraftPackage()` 守，用例在 `tests/skills-enablement.test.ts`。
- [x] **H6.11** 改 `skills/manager.ts:317` 的 digest 重试文案（不再提 `skill_install`）。
- [x] **H6.12** `skills/skill-creator` 补写用户侧 skill 的目录形状 / 写在哪 / 怎么自测 / 怎么让用户启用；
      企业条款 prompt 的路径指到草稿根。
- [x] **H6.13** 用例：系统 skill 在任何模式下都写不了（`ro_bind` 仍在）。

### H7 MCP 换出厂包 ✅ **完成 2026-08-31**（H7.8/H7.9 的真实服务器取证留到 H9）

> **第五个「终止在被忽略的参数上」的装配**：`container.ts` 构造
> `createPiMcpResolver(...)` 传给 `DshRuntimeFactory`，而 **runtime-factory 从来
> 没读过 `mcpResolver`**——与 `extensionBundleFactory` 同形。
>
> **一处差点酿成大事故的实现细节**（写在这里因为它不直观）：
> `resolveToolRiskLevel(name, cls, policy)` 在 `cls.class` 缺省时会把
> `classRiskLevels['']` 查空、落到 `'critical'`，并且把 `configured` 标成 `true`
> （因为 `'critical' !== undefined`）。也就是**不传分类的话，每一个工具都会被
> 报成「运维配置为 critical」→ 整片工具在运行时被拒**，而且理由看起来像是运维配的。
> 第一版就是这么写的，单测全绿——因为没有任何用例走过「executor → 解析器 → 风险表」
> 这条完整链。补了 `tests/runtime/tool-names.test.ts` 的 H7.3 两条才抓到。

- [x] **H7.1** `manifest.ts` 从 `MCP_SERVERS_JSON` 生成**每 server 一条** insert
      （`id: mcp-<server>`、`name: '@deepseek-ai/dsh-mcp-client'`、config 见 ADR D9），经 `npm run gen:patch`。
- [x] **H7.2** ⛔ secretRef → env 的解析留在我们代码里。判据：用例断言生成的 patch YAML 里
      **搜不到任何密钥明文**。
- [x] **H7.3** `tool-risk.json` 的 `mcpServers` 现在是**空的** —— 为每个 server 补
      `mcp__<server>__*` **前缀条目**（出厂包对超长/非法名会规范化并追加 12 位十六进制哈希，
      精确 key 匹配不上）。判据：用例喂一个被哈希改名的工具，断言仍匹配到前缀条目。
- [x] **H7.4** 删 `agent/src/infrastructure/mcp/pi-mcp-adapter-factory.ts`。
- [x] **H7.5** 删 `agent/package.json:63` 的 `pi-mcp-adapter@2.11.0`；`container-mcp.ts` 的自建发现随之删。
- [x] **H7.6** `/ready` 改为投影 DSH 工具注册表（`readMcpReadiness()`）。
      顺带把 boot 的记忆化收敛到 `boot.ts` 的 `sharedEnterpriseRuntime()`：
      以前 `runtime-factory` 自己 memo 一份，而就绪度走另一套 adapter 探测
      ——同一件事两处各算一遍，且两边看到的工具面可能不一致。
      `container-mcp.ts` 从约 120 行的自建发现状态机（快照/重试/后台重探定时器）
      缩到只读注册表：连接、退避重连、`tools/list_changed` 重新同步都由出厂插件负责，
      我们再探一遍只会连出两套连接。
- [x] **H7.7** 可见性收窄：**H0.4 已确认 `ctx.tools.restrict({allow, deny})` 存在**，
      按 agent scope 过滤**继承来的**工具面。装在 `setup(agentCtx)` 的每 Run scope 上，
      按 AgentVersion 的 `toolPolicy` / `mcpServers` 生成 filter。不引入 preset。
      判据：用例——两个 `toolPolicy` 不同的 Run 并发，各自 `schemas(scope)` 不同；
      且被 restrict 掉的工具在 `guard()` 层**仍然**会被拒（两层都要在，可见性不是权威层）。
      注意 d.ts 的坑：restriction 只过滤**继承**面，不过滤 scope 自己注册的工具。
- [x] **H7.8** ✅ **做成了，之前的「要 compose」是判断错误**：MCP 连接发生在 agent
      进程里，不经过 exec，所以不需要 Bubblewrap。用官方 `@modelcontextprotocol/sdk`
      写了一台真的 stdio server（`tests/runtime/fixtures/mcp-echo-server.mjs`，
      那个 SDK 本来就是 `dsh-mcp-client` 的依赖，不引入新依赖），
      实测：注册成 `mcp__echo__echo`、调用往返回 `echo:hello-from-h7-8`。
      用例 `tests/runtime/mcp-live.test.ts` 跑在子进程里（同 `boot.test.ts` 的理由）。
      **它顺带抓出 H2.7 断言里的一个真错误**：那条拿全集去比
      `ENTERPRISE_DEFAULT_TOOLS`，而 MCP 工具是部署配置、永远不在那份固定名单里
      ——**任何配了 MCP 的部署都会让它红**。已改成 host 面精确相等 + MCP 只断言命名形状。
- [x] **H7.9** 未配到的 `mcp__*` 一律落到 `high`（要审批），**绝不掉到 allow**。
      不能只靠精确 key：出厂包对超长/非法名会规范化并追加 12 位十六进制哈希。
      租户层只能收紧的用例一并补上。
- [x] **H7.10** `STATUS.md` A3 翻转。

### H8 死装配删除 ✅ **完成 2026-08-31**

> **删之前先把它带的三样依赖接回真正的消费者**——否则「删干净了」只是把断链
> 变成没链。`extensionBundleFactory` 终止在一个被 `runtime-factory.create()`
> 忽略的参数上，而喂给它的三样各自断着：
>
> | 依赖 | 断在哪 | 接到哪 |
> |---|---|---|
> | `governanceRecorder` | 审批判定不落库、不停泊 | H4.3 的 `GovernanceApprovalStore` |
> | `subagentSpawnPort` | 子 Run 走进程内队列，Worker 重启即丢 | H5 的 `durable-subagent-port` |
> | `toolRiskPolicy` + 租户 `toolPolicy` | **整张运维风险表零效果** | H8 的 `buildRunRiskResolver` |
>
> **第三样是这一步顺手查出来的第四处缺陷**：`riskOverrides` 被设在 **executor
> 工厂**的选项上，而 `runtime-factory` 读的是**它自己的** opts——两个不同的对象。
> 于是 `config/agent/tool-risk.json` 与 `TOOL_RISK_POLICY_*` 配了等于没配，
> 而且没有任何人报错。租户层更彻底：整段算在 `if (extensionBundleFactory)` 里面，
> 生产根本不执行；唯一会因此 fail-closed 的 `resolveAgentVersionBindings()`
> 又没有任何调用方。这正是 ADR 0009 D3 记的「`toolPolicy` → 闸门的过滤未接线」。
>
> 顺带暴露并修掉：`buildMcpPolicyBindings` 在对象没有 `configJson` 键时，会把
> 传进去的整个 AgentVersion 当成一份 mcp 配置解析并抛错——以前藏在 bundle
> 分支后面（生产不走），提出来才暴露。按语义收敛在调用处。

- [x] **H8.1** 删 `pi-run-executor.ts:138/240/495/576/594` 的 `extensionBundleFactory`。
- [x] **H8.2** 删 `pi-run-executor-deps.ts:55`、`container-run-executor.ts:109/165/284`、
      `container.ts:680` 注释里的同名转发。
- [x] **H8.3** 改写了 5 处断言转发的用例。**每一条都改成断言新的装配语义，不是删掉**：
      - 「forwards extensionBundleFactory」→ 断言风险表与 spawn 端口到达 executor，
        且死形参不再出现；
      - 「omits toolPolicyBinding when no bundle」→ 它守的是「一个不会开火的守卫」加
        「一段生产不执行的代码」，改成断言租户层风险等级**真的生效**
        （`riskOverrides('bash') === 'critical'`）；
      - 「fails closed when bundle set but sandboxSessionId missing」→ 那条 fail-closed
        的触发条件是 bundle 存在，生产从来没有过。改成「有值才校验格式」：
        保住「格式不对就别往下走」，不改变哪些 Run 能跑（改成无条件是超范围的行为变更）；
      - fence token 那条 → 删掉 bundle 观察面，**停泊标记的生命周期**改成直接断言；
      - deadline 那两条 → 停泊端口改从 `executor._runSuspensionPort` 取
        （顺便让它在排查线上问题时也拿得到）。
- [x] **H8.4** 删无人调用的 `createTaskStateStore` 与未接线的 spawn 工厂。
- [x] **H8.5** diagnostics 改投影 DSH tool 注册表，不再投影空的 Extension 名单。
- [x] **H8.6** `getAllTools()` 以前返回 `[providers.fs, providers.shell, providers.jobs]`
      ——那是三个**能力 provider**，不是工具：模型看不见它们，它们也没有工具名。
      改成投影 `ctx.tools.schemas()`。
- [x] **H8.7** 判据：`grep -rn extensionBundleFactory agent/src` 零命中，测试套仍绿。

### H9 前端适配 ✅ **完成 2026-08-31** / compose 端到端 ⛔ **本环境做不了**

> 顺带修好一条**动手之前就红**的前端用例：`capabilities-page.test.ts` 读
> `agent/src/extensions/constants.js`，而那个目录在 Wave 6 删除 Pi Extension 时
> 就没了——它守的是一份已经不存在的名单。改成守现在真正成立的事：
> 诊断投影 DSH 的 host 工具面，来源标注是 `dsh-host-tools`。

- [x] **H9.1** ⛔ 照 H0.5 的样本改 `frontend/src/widgets/runtime-steps/taskStateFields.ts:70`：
      从 result JSON 取 `todos` → 改成读 **arguments** 或投影 `todo/write` event。
- [x] **H9.2** 同步改 `taskStateViews.tsx`、`runtime-timeline/cards/ToolExecutionCard.tsx`。
      判据：todo 卡片不退化成一行 `Updated todo list: …` 文本。
- [x] **H9.3** 工具卡片按新工具名适配（`glob`/`job_*`/`skill`/`subagent`/`ask_user_question`）。
- [x] **H9.4** memory 卡片按 D10 处理成「无数据」而不是报错。
- [x] **H9.5** 确认 SSE 契约、审批中心与提问应答 URL **零改动**。判据：契约用例不改仍绿。
- [x] **H9.6** ✅ **跑了，而且抓到 5 个单测全绿时仍存在的缺陷**。
      证据：[`../evidence/2026-08-31-compose-e2e-adr0009.md`](../evidence/2026-08-31-compose-e2e-adr0009.md)。
      **之前那句「macOS 上没有 Bubblewrap」是错的**——`exec` 跑在 Linux 容器里，
      容器内 `bwrap` 可用（已实测）；LLMIO 网关也可达。
      跑通：新 overlay 起栈 → 迁移落真 MySQL → `/ready` 投影注册表 →
      模型调 `write`/`bash` 经 exec+bwrap **真正落字节** → durable 工具账本两端 →
      审批停泊（Run `WAITING_APPROVAL` + durable PENDING + Worker 释放）→
      批准续跑 → **参数指纹绑定按 D5 生效** → 模型在 per-user 草稿根里建包 →
      启用闸门复制字节 → 改草稿动不了已启用副本 → 系统 skill 两侧都只读。
      未跑到的：网关**余额耗尽**后模型驱动到此为止（启用那一幕改为不经模型直接验，
      走同一条闸门代码）；启用还没有 HTTP 路由（下一步，不在本清单）。

### 收尾文档

- [x] **X.1** `architecture.md` §4c 整节重写：模型看得见的 14 个工具与各自来源、
      被显式关掉的 8 组、能力挂在哪、「host 挂全量 + 按 Run 过滤」的两层。
- [x] **X.2** `api.md` / `webui.md` 的 skill 面。
- [x] **X.3** `STATUS.md` A2 从 `unknown` 改成 `partial` 并**换掉取证对象**：
      那七个 Extension 都已不存在，现在要证的是五个策略挂载点装在每 Run scope 上、
      以及 boot 后工具面与名单恰好相等。A3 同时翻到 `partial`（H7.10）。
- [x] **X.4** `waves/README.md` 进度表增加 H0–H9 行。
