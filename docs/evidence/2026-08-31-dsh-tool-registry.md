# 2026-08-31 DSH tool registry 取证（ADR 0009 / H0.1–H0.2 / H0.4）

**怎么取的**：`agent/scripts/dump-tool-registry.ts` 起真实插件树
（`bootEnterpriseRuntime()` → `dsh-base` patch + 本仓 overlay），
用出厂公开 API `ToolRuntime.schemas()` 枚举**模型可见**的工具面。
不是读 tarball、不是读文档、不是字符串匹配 YAML。

复现：

```bash
cd agent
SANDBOX_INTERNAL_HMAC_KEYRING='{"boot":"<任意 b64url>"}' \
SANDBOX_INTERNAL_HMAC_ACTIVE_KID=boot \
npx tsx scripts/dump-tool-registry.ts
```

（HMAC 两个 env 是 `readExecRpcFromEnv` 的 fail-closed 前置，取证不发 RPC，占位即可。）

---

## 结论一：ADR 0009 D4 的工具面清单**少了 8 个已经注册且模型可见的工具**

# ctx.tools.schemas() —— 全局视图，23 个模型可见工具

| 工具名 | 描述首行 |
|---|---|
| `bash` | Execute a bash command (`bash -c`) and return its stdout/stderr. Each call runs in a fresh |
| `create_goal` | Create one persisted same-session completion goal when the current direct human request is |
| `edit` | Edit an existing UTF-8 text file by replacing literal text. |
| `exit_plan_mode` | Use only in plan mode. Present your plan for the user's review and, on approval, leave pla |
| `get_goal` | Read the current same-session goal, including its exact id/revision, objective, phase, com |
| `interrupt_agent` | Request cancellation of a background agent's current turn by its agent id. The target may  |
| `job_kill` | Request cancellation of a running background job by job id. Returns immediately; the job s |
| `job_list` | List your background jobs (running and finished) with their ids, kinds, and statuses. |
| `job_output` | Read a background job. Stream jobs return only output since the previous read; final-outpu |
| `list_agents` | List your continuable background subagents by durable id and label. Use it to recall which |
| `ralph` | Run a foreground fresh-agent Ralph loop toward one immutable objective. Use only when the  |
| `read` | Read a UTF-8 text file and return line-numbered content. |
| `read_image` | Read a PNG/JPEG/WebP/GIF file and return the image itself. Harness validates and downscale |
| `send_message` | Send a message to a background subagent by its subagent id, continuing the same conversati |
| `skill` | Load the full instructions for an available skill. Call this with the exact skill name fro |
| `str_replace_editor` | Custom editing tool for viewing, creating and editing files |
| `subagent` | Delegate a self-contained task to a subagent (a separate agent that works in its own conte |
| `subagent_fork` | Delegate a task to a subagent that inherits this conversation: a child agent seeded with a |
| `todo_write` | Record and update a structured task list for the current work. Send the ENTIRE list every  |
| `update_goal` | Update the exact current goal revision. edit, pause, and resume require a direct top-level |
| `web_search` | Search the web for current information. Provide 1–4 queries in the required queries array. |
| `workflow` | Run a JavaScript workflow script that orchestrates subagents at scale. Use this for work t |
| `write` | Create or fully replace a UTF-8 text file. |

# seams

| seam | 在？ | 实现类 |
|---|---|---|
| `ctx.approval` | ✗ | — |
| `ctx.permissionPresets` | ✗ | — |
| `ctx.userQuestions` | ✓ | UserQuestionService |
| `ctx.fs` | ✓ | RemoteFileSystem |
| `ctx.shell` | ✓ | RemoteShell |
| `ctx.jobs` | ✓ | RemoteJobs |
| `ctx.skills` | ✓ | SkillRegistry |
| `ctx.subagents` | ✓ | SubagentRuntime |
| `ctx.credentials` | ✓ | EnvCredentialsProvider |
| `ctx.sessionPersistence` | ✗ | — |

# 收窄机制（ADR 0009 D9 §4）

  ✓ ctx.tools.restrict()
  ✓ ctx.tools.guard()
  ✓ ctx.tools.schemas()
  ✓ ctx.tools.get()
  ✓ ctx.tools.register()

---

## 逐项对 ADR 0009 D4「真实注册名」表

### ADR 预期有、实测**没有**（3 类）

| 缺的 | 为什么 | ADR 是否已知 |
|---|---|---|
| `glob`、`grep` | `tool-fs-search` 被 overlay 关掉且**没有替代** | ✅ D8 已写明「今天模型没有搜索工具」 |
| `ask_user_question` | `@deepseek-ai/dsh-tool-ask-user` 不在 `agent/node_modules` | ✅ D3 已写明要加依赖 |
| `mcp__*` | `@deepseek-ai/dsh-mcp-client` 不在 `agent/node_modules` | ✅ D9 已写明要加依赖 |

### ADR 预期有、实测**确实有**（8 个）

`read`、`write`、`edit`、`read_image`（`tool-fs`）、`bash`（`tool-bash`）、
`job_list`、`job_output`、`job_kill`（`tool-jobs`）、`todo_write`（`tool-todo`）、
`skill`（`tool-skill`）、`subagent`（`tool-subagent`）。

**`submit_artifact` 不在注册表里** —— ADR D4 写「`submit_artifact` 是我们自建的，保留」，
但它今天**没有任何插件注册**（旧 Pi Extension 删除后没补）。要保留就得自己写一个 tool 插件。

### ⚠️ ADR **完全没提**、实测已注册且模型可见（8 个）

| 工具 | 来源插件 id | 来源包 | 性质 |
|---|---|---|---|
| `web_search` | `web-search-deepseek` + `tool-web` | `dsh-web-search-deepseek` | **agent 进程直接出网** |
| `workflow` | `tool-workflow` | `dsh-tool-workflow` | 在 worker thread 里跑 JS,编排子 Agent |
| `ralph` | `tool-ralph` | `dsh-tool-ralph` | 前台 fresh-agent 循环,朝一个不可变目标反复重试 |
| `subagent_fork` | `tool-subagent-fork` | `dsh-tool-subagent`(第二实例) | 继承当前会话的子 Agent |
| `interrupt_agent`、`list_agents`、`send_message` | `tool-subagent-control`、`tool-subagent-list-agents` | `dsh-tool-subagent-control` | 对**可续聊**子 Agent 的控制面 |
| `create_goal`、`get_goal`、`update_goal` | `tool-goal` | `dsh-tool-goal` | 会话内目标状态机 |
| `exit_plan_mode` | `plan-mode` | `dsh-plan-mode` | plan mode 交接 |
| `str_replace_editor` | `tool-str-replace-editor` | `dsh-tool-str-replace-editor` | 与 `read`/`write`/`edit` **功能重复的第二套编辑工具** |

**这 8 个在 fail-closed 分类器下全部是 `unknown` → `deny`。** 也就是说 H1 如果只按 ADR D4
那张表改名单，boot 之后模型会看到 23 个工具、其中 8 个必然在运行时被拒——正是 D4
要避免的那种失败，只是方向反了（不是漏加新名，是漏了整批没预料到的工具）。

---

## 结论二：`ctx.tools` 有**按 scope 收窄注册面**的机制（回答 ADR 0009 D9 §4 的悬念）

`ToolRuntime`（`@deepseek-ai/dsh-tools`）的公开 API：

| 方法 | 语义（照抄 d.ts） |
|---|---|
| `restrict(filter)` | "Restrict global tools for the calling agent scope … `allow`(keep only) and/or `deny`(remove). Restrictions intersect; scoped registrations remain visible." 返回解除该限制的 disposer。 |
| `guard(guard)` | "A plain-context guard applies globally; one registered through `agent.ctx` applies only to that agent … no guard can force-allow a call another guard denied."（单调，fail-closed） |
| `schemas(scope?)` | 按 scope 投影模型可见的 schema——**就是模型实际看到的那份清单**。 |

**所以 D9 §4 的答案是「有」**：可见性可以按 agent scope 收窄，且**不需要 preset**。
`restrict()` 是可见性层（省上下文、不诱发必然被拒的调用），`guard()` 是权威层。
ADR 说的「host 挂全量 + 按 Run 过滤」两层在出厂 API 里都有对应物。

d.ts 里还有一条要记下来的坑（原文）：

> "A restriction filters what a scope inherits — the global layer and every ancestor
> layer on its chain — and never what its OWN layer registers."

我们走的正是 host 组合（工具在 global layer），所以 `restrict()` 对我们有效；
官方 preset 把工具搬到 agent plane 之后反而失效过。**这是选 host 组合的一个额外收益,
ADR D3 当时没写。**

---

## 结论三：seam 现状与 ADR 一致

| seam | 在？ | 实现类 | ADR 期望 |
|---|---|---|---|
| `ctx.approval` | ✗ | — | D5 要打开 |
| `ctx.permissionPresets` | ✗ | — | D5 要**保持关闭** ✅ |
| `ctx.userQuestions` | ✓ | `UserQuestionService` | 有 seam 无工具 ✅ |
| `ctx.fs` / `ctx.shell` / `ctx.jobs` | ✓ | `RemoteFileSystem` / `RemoteShell` / `RemoteJobs` | ✅ 是我们的 RPC 代理,不是本机实现 |
| `ctx.skills` | ✓ | `SkillRegistry` | — |
| `ctx.subagents` | ✓ | `SubagentRuntime` | H5 要接 durable |
| `ctx.credentials` | ✓ | `EnvCredentialsProvider` | ✅ 出厂 `LocalCredentialProvider` 确实被替换掉了 |
| `ctx.sessionPersistence` | ✗ | — | 由 `boot.createSessionBackend` 按 Run 装配,不在根 ctx |

**`ctx.credentials` 这一条顺带补上了 ADR 0007「必须移除的行」的取证** ——
2026-08-30 那次 patch 路径写错导致出厂实现留在原位，此前只有 YAML 字符串断言，
现在有运行时证据。

---

## 对计划的影响

1. **H1 的常量内容不能照 ADR D4 那张表写**，要按本次 dump 的 23 个 + 待加的
   `glob`/`grep`/`ask_user_question`/`mcp__*` 来定，并先决定那 8 个意料外工具的去留。
2. **H7.7（可见性收窄）已经有答案**：用 `ctx.tools.restrict()`，不引入 preset。
3. **`submit_artifact` 需要重新实现**，ADR 说的「保留」在代码里没有对应物。

---

# 附：H0.3 —— answerer 返回非 allow 之后 turn 会怎样（实跑，不是读文档）

**探针**：`agent/scripts/probe-approval-park.ts`。真实插件树 + `tests/support/fake-openai-provider.js`
的确定性假 LLM（第 1 次请求回一个 tool_call，之后回文本）。判据是**循环 LLM 请求次数**
（只数 body 带 `tools` 的那些，排除 session-title 的那次调用）：
1 次 = turn 在工具那里就结束了；2 次 = 模型收到结果后又走了一步。

```bash
cd agent
SANDBOX_INTERNAL_HMAC_KEYRING='{"boot":"<b64url>"}' SANDBOX_INTERNAL_HMAC_ACTIVE_KID=boot \
AGENT_ENABLE_FAKE_LLM=1 npx tsx scripts/probe-approval-park.ts
```

| 场景 | 做法 | 循环 LLM 请求 | 工具体执行 | 结论 |
|---|---|---|---|---|
| **A** | `tools/pre-execute` 判 `ask` + answerer 返回 `rejected`（**ADR 0009 D5 第 1 步的原样**） | **2** | 0 次 | ❌ **turn 没有结束** |
| **B** | `tools/execute` around-wrapper 返回 `{isError:false, concludesTurn:true}` | **2** | 0 次 | ❌ wrapper 写的 `concludesTurn` 被规范化掉了 |
| **C** | 工具**体内**调 `exec.concludeTurn()` | **1** | 1 次 | ✅ **循环停了** |
| **D** | answerer 同步调 `agent.cancel({kind:'hook'})` 后返回 `rejected` | **2** | 0 次 | ❌ 中止没能阻止这一步 |

## 结论：ADR 0009 D5 的停泊第 1 步被证伪

D5 原文：

> answerer 写 durable PENDING → **立刻返回一个非 allow 的结果 → 该次工具调用不落地
> → turn 正常结束** → Run 转 `WAITING_APPROVAL` → **释放 Worker**。

实测：工具调用确实不落地（场景 A 工具体 0 次执行，这一半是对的），
但 **turn 不会结束**。模型拿到一个错误型 tool result，循环把它喂回去，又发了一次请求。
出厂 README 其实写着这个语义，只是 ADR 当时读成了「turn 结束」：

> "A rejection may replace a normal tool result with a small retained error,
> while an allowance leaves the consumer's ordinary result."

类型层面也是关死的：`concludesTurn` **只存在于 `ToolExecutionSuccess`**，
`ToolExecutionFailure` 上是 `concludesTurn?: never`。**一个被拒的调用在类型上就不可能结束 turn。**

## 可用的原语只有一个，且它在工具体里

场景 C 证明 `ToolRunContext.concludeTurn()` 有效（"The agent loop stops after
committing this successful result batch"）。但它**只对我们自己写的工具体可用**——
`read` / `bash` / `todo_write` 这些出厂工具的体不是我们的，wrapper 又拿不到
`concludeTurn`（场景 B 证明 wrapper 自己写 `concludesTurn` 会被丢掉）。

## 因此 H4 的形状要改（三选一，推荐第 3）

1. **给每个需审批的工具自己写一份工具体** —— 违反 ADR 0007 D2「能用原生用原生」，且要
   重新实现 `read`/`bash` 的全部语义。否决。
2. **等上游给一个 out-of-turn 审批工作流** —— 上游明写 "deferred"。不能等。
3. **接受「多走一步」，用 `guard()` 把这一步锁死**（推荐）：
   - answerer 写 durable PENDING → 返回 `rejected`（工具不落地，这一步实测有效）；
   - **同时在该 Run 的 agent scope 上装一个 park guard**：本轮之后**任何**工具调用一律拒，
     理由码固定（`RUN_PARKED_AWAITING_APPROVAL`）。`guard()` 是单调 fail-closed 的
     （"no guard can force-allow a call another guard denied"），正好承担这件事；
   - 模型于是在下一步没有任何工具可用，只能输出文本并结束 turn；
   - executor 观察到 PENDING → Run 转 `WAITING_APPROVAL` → 释放 Worker；
   - 续跑仍按 D5 的**重建会话 + 重放**，那一半不受影响。

**代价写在明处**：每次停泊多一次模型往返（一步文本）。**换来的是**park guard 保证
这一步里模型碰不到任何工具，不会趁机产生别的副作用——这正是场景 A 裸奔时的风险。

---

# 附：H0.5 —— `todo_write` 的真实结果形状（确认 ADR「影响」段）

`@deepseek-ai/dsh-tool-todo/lib/index.js:167-177`：

- **tool result 的 content**：`Updated todo list: <n> pending, <m> in progress, <k> completed.`（纯文本）
- **canonical value**：`{ counts: { pending, inProgress, completed } }` —— **不含 todos 数组**
- **清单本身**：在 **arguments**（`args.todos`）与 `exec.agent.session.append('todo/write', { todos })`
  这个 session event 里

**ADR 的判断成立**：`frontend/src/widgets/runtime-steps/taskStateFields.ts:70` 现在从
result JSON 取 `todos`，换到出厂 `tool-todo` 之后会取到 `undefined`，卡片静默退化成一行文本。
H9.1 照这个形状改。

---

# 附：一个顺带发现的**现存跨租户缺陷**（不在原计划里）

`agent/src/infrastructure/dsh/runtime-factory.ts:170-174`：

```ts
const ctx = await ensureCtx(runtime);          // bootOnce：整个进程共用一个根 ctx
const providers = runtime.createRemoteProviders(ctx, rpc);
for (const p of [providers.fs, providers.shell, providers.jobs]) {
  if (p && typeof p.rebind === 'function') p.rebind(rpc);   // ← 每个 Run 改同一份 provider
}
```

`boot.createRemoteProviders()` 在 provider 已挂载时**返回同一份实例**，
接着这里按本 Run 的 `rpc` 调 `rebind()`。两个并发 Run 就是后一个 `rebind` 覆盖前一个。

这正是 **ADR 0009 D3 明文禁止的那一条**：

> 并发 Run **不得**靠「`rebind` 根 ctx 上的同一份 provider」——那会串台。

ADR 把它写成「要保证的约束」，但代码里**已经是**被禁止的那个写法。
所以 H3 不是「补断言」，是**修缺陷 + 补断言**。

### 缺陷的实际范围（2026-08-31 修复时核准，初稿写宽了）

**租户身份是安全的**：`ExecRpcClient.envelope()` 走 `currentExecRpc()`，
ALS 优先于构造值，所以 `orgId`/`userId`/`workspaceId`/`fenceToken` 不会串。
初稿把这条写成「跨租户串台」，范围写宽了，此处更正。

**真正被 `rebind` 改坏的是 `physicalRoots`**：它不走 ALS，是 provider 上的字段，
而它每 Run 不同（`buildExecRpcConfig` 取 `input.physicalRoots ?? [input.cwd]`，
cwd 就是该租户的工作区）。这份根用于**路径脱敏**，且只在
`ExecRpcClient.post()` 的「未分类错误」分支上用（网络 / 超时 / 非 JSON；
线上回来的 `FsError`/`ContractError` 原样透传，脱敏是 exec 侧的责任）。

后果具体是：并发时 B 的 `rebind` 把脱敏根换成 B 的，于是 **A 的未分类错误按 B 的根
脱敏 → A 的真实物理路径原样漏进错误消息**。复现固定在
`agent/tests/runtime/tenant-isolation.test.ts`（修之前红，修之后绿）。

**修法**：三个 provider 的 `roots` 从字段改成 getter，调用时取
`this.rpc.activeConfig().physicalRoots`（即 ALS）；`runtime-factory` 里那段
`p.rebind(rpc)` 删除。租户上下文从此只有 ALS 一条通路。
