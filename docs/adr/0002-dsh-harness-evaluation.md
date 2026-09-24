# ADR 0002: 评估将 Agent Runtime 迁移到 DeepSeek Harness（DSH）

| 字段 | 值 |
|------|----|
| 状态 | **Superseded by [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)**（2026-08-29）。调研内容全部有效并被 0007 复用为风险清单；**「调研结论」一节作废**——它建立在"Pi 可用"的前提上，该前提已不成立 |
| 日期 | 2026-08-28 |
| 决策所有者 | TBD |
| 适用范围 | `agent/` 的 Agent Runtime（当前实现见 [ADR 0001](0001-pi-coding-agent-sdk.md)） |
| 关联决策 | [ADR 0001](0001-pi-coding-agent-sdk.md)、[ADR 0004](0004-session-persistent-tmp.md)、[ADR 0005](0005-pi-session-jsonl-persistence.md)、[ADR 0006](0006-user-skill-enablement-gate.md) |
| DSH 仓库 / 全称 | DeepSeek Harness（`dsh`），[github.com/deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，MIT，TypeScript，`npx @deepseek-ai/dsh web` |
| 调研证据基线 | **DSH 侧**：npm `@deepseek-ai/dsh@0.1.1-rc.2` 及其包树（`next` tag，发布于 2026-08-21）；GitHub 仓库元数据读取于 2026-08-28。**Pi 侧**：本仓库 `main` @ `4dda7a9b`，`@earendil-works/pi-coding-agent@0.80.3` |

## 背景

[ADR 0001](0001-pi-coding-agent-sdk.md) 已经决定采用官方 `@earendil-works/pi-coding-agent`
SDK（当前锁定 `0.80.3`）作为 Agent Runtime 的地基，`agent` 服务通过它创建 Session、
流式收发 tool/token 事件、恢复多轮历史。

本 ADR 最初的立项理由写的是"不是由已知痛点驱动，只是想学习一种不同的架构"。
**这句话是错的，本次补充调研把它推翻了**——代码和提交历史里有一批 Pi 的能力缺口和
手动绕过，其中两处是打在非公共 API 上的补丁。详见下面「Pi 侧的实际约束」一节。

因此本 ADR 的真实动机应当记为：**Agent Runtime 已经在 Pi 上积累了可观的适配成本
（`agent/src/extensions/` 与 `agent/src/infrastructure/pi/` 合计约 10,700 行），其中若干
项是 Pi 公共 API 无法覆盖、只能靠改写内部字段或绕开既有 seam 实现的。**调研 DSH 的意义
不在"学习一种新架构"，而在回答一个具体问题：这些成本是 Agent Harness 这类软件的固有
成本，还是 Pi 这一个实现的特性。

保留这段修订记录，是为了让后来的读者看到前提被改过，以及被什么证据改的——按本 ADR
「影响」一节自己定下的规矩：真实驱动因素一旦出现就更新「背景」，不要事后把文档补写成
另一副样子。

DSH 于 2026-08-13（DeepSeek V4 Pro 发布数小时后）以 developer preview 形式开源，
MIT 协议，TypeScript 实现，`npx @deepseek-ai/dsh web` 一条命令起 Web UI
（默认 `http://127.0.0.1:3080`）。它自我定位为"把 LLM 接到真实世界的那一层：
文件系统、shell、tool call、session、审批、长时间运行的工作流"，采用
"everything-is-a-plugin" 架构，底层由 Cordis 框架驱动——model adapter、tool registry、
session log、agent loop 本身都是可替换插件，没有可打补丁的"核心"，扩展是往 context
上挂一个平级插件。

## Pi 侧的实际约束（对照基线）

初版 ADR 只调研了 DSH，把 Pi 当成"够用的现状"，因此结论建立在一个未经核实的前提上。
本节补上对照的另一半：**Pi 这一侧现在实际付出了什么。**

### 打在非公共 API 上的补丁

| 位置 | 事实 |
|------|------|
| `agent/src/application/pi-run-tool-budget.js:126-127` | 每 Run 的工具预算靠**改写 `agent.beforeToolCall` 与 `agent.prepareNextTurnWithContext`** 实现——两个字段都不在 `@earendil-works/pi-coding-agent` 的公共导出面。保存旧值、覆盖、dispose 时还原。 |
| `agent/tests/sdk-compat/agent-hook-points.test.js:1-13` | 这个套件存在的唯一理由是**静默失效**：Pi 升级若重命名这两个字段、改成只读或改成 handler 数组，"the budget stops applying while every functional test keeps passing, and a Run quietly regains an unbounded tool loop"。所以它断言的是**补丁依赖的形状**，而不是行为。 |

`pi-run-tool-budget.js` 的文件头写着"uses the public Agent hook points exposed by
AgentSession"——这句与它自己的 compat 测试头矛盾。**以测试头为准**：这是补丁，不是公共
seam。这处注释本身也应当修掉，但那是另一个 PR 的事。

### Pi 公共 API 覆盖不到、只能自建的能力

| 缺口 | 我们的应对 | 证据 |
|------|-----------|------|
| **无 snapshot / hydrate / checkpoint API**；`SessionManager.inMemory()` 不能 hydrate 原始 entry | 恢复时把完整 v3 JSONL **物化成磁盘文件**再 `SessionManager.open()` | `pi-session-adapter.js:4-9` |
| **`SessionManager.open` 静默跳过损坏行** | 必须在 open 之前自己做 fail-closed 校验，否则会得到一个"少了几条"的会话而不报错 | `pi-session-adapter.js:7`、`pi-jsonl-codec.js:14` |
| Session version 与 entry-type 表**没有可依赖的导出** | 从 SDK **抄写**进 `pi-jsonl-codec.js`（因为 snapshot 是持久化契约必须归我们），靠 contract test 追漂移 | commit `be4a077a` |
| **`AgentVersion.sandboxPolicy` 在 Pi 里没有任何执行路径** | 只能报 `PI_FEATURE_NOT_ENABLED` 并告诉运维沙箱限制是部署级 env | `agent-version-bindings.js:619-623` |
| `SettingsManager.applyOverrides` 看着像支持的 seam，实则 `save()` 会从 `globalSettings` 重建 `settings` 并**静默丢弃**覆盖值 | 改用 `SettingsManager.inMemory(seed)` 把策略塞进 `globalSettings` | `context-policy-service.js:1-24` |
| **无可恢复的暂停/续跑**（durable suspend/resume） | `ask_user` 靠**抛异常中断当前 Pi turn**，让 executor checkpoint 后返回 `WAITING_INPUT` | `user-interaction/index.js:5-6, 106-115` |
| **无 subagent 原语** | 自建 `spawn_subagent`/`check_subagent`，落成 BullMQ 上的独立持久 Run；且因为"一个 Run 独占 AgentSession 的执行锁整个生命周期"，子 Run **不能继承父 Session** | `subagent-spawn/index.js` |
| **无跨 Run 的持久工作记忆** | 自建 `todo_write`/`todo_read` 与 owner-scoped 的 `memory_write`/`memory_search` | `task-state/index.js` |
| **内建工具跑在 Agent 容器本机** | 整个 `sandbox-bridge`（`tools/index.js` 单文件 970 行）把 read/write/edit/bash/grep/find 重新实现成走 Sandbox REST | ADR 0001 硬规则 2 |
| **事件携带原始负载** | 277 行 `event-redaction.js` 在落库和展示前做脱敏 | `event-redaction.js` |
| 静态 import SDK 要 **~300ms 进程启动**，且把整个 coding agent 拉进 HTTP 进程 | A2A Agent Card 路径改为直接用 `yaml` 自己解析 frontmatter，不碰 SDK 的 `parseFrontmatter` | `skills/frontmatter.js:12-18` |

### 一次由 Pi 语义造成的生产回归

`excludeTools` 是**按名字**排除，且同样作用于 extension 注册的工具——所以把
`ls`/`find`/`grep` 加进去，会连 sandbox-bridge 注册的同名替代品一起排掉。
`pi-runtime-constants.js:21-26` 的原话：

> "denying `ls`/`find`/`grep` there also denies the sandbox replacements — which is
> exactly how the model lost workspace search while the capability manifest kept
> advertising it."

现在的边界改成 bind 之后由 `assertSandboxShadowedTools` 检查：如果这些名字仍解析到内建
实现就 fail closed。**但这条边界之所以需要，是因为 Pi 的工具注册表没有"内建 vs 覆盖"的
概念**——影子覆盖能生效，只是因为同名 extension 工具会盖掉内建条目，而
`defaultActiveToolNames` 恰好只含 sandbox-bridge 影子的那四个（commit `be4a077a` 的原话是
"only because … happens to be"）。这是巧合形成的安全边界，不是设计出来的。

### 规模

```
agent/src/extensions/           7,412 行（7 个 extension，其中 sandbox-bridge 占 3,076）
agent/src/infrastructure/pi/    3,315 行（factory / bindings / codec / adapter / redaction / projector）
                               ────────
                               10,727 行适配层
```

其中 `sandbox-bridge`（3,076 行）是"Sandbox 是安全边界"这个架构决定的必然成本，换任何
Harness 都要付。但 `pi-jsonl-codec` + `pi-session-adapter` + `agent-version-bindings`
（合计 1,597 行）加上工具预算补丁，是**Pi 特有**的成本——它们存在，是因为 Pi 没有
hydrate/checkpoint API、不导出 session 版本表、没有 per-AgentVersion 的策略绑定面，
以及没有公共的 turn/tool 预算钩子。

## 调研方法与证据边界

初版本 ADR 的发现只基于仓库 README / `AGENTS.md` / `docs/architecture.md` / `SAFETY.md`，
因此在审批与权限模型上只能写"文档没披露"。本次补充调研改为**读实际发布的包**：从 npm
拉取 `@deepseek-ai/dsh@0.1.1-rc.2` 的完整依赖清单，再逐个拉取 `next` tag 下的关键包，
读其 `package.json`、`cordis.patch.yml` 组合层与各包自带的 README（DSH 每个包的 README
是规范级文档，含 `Config` 表、`Model Experience` 与显式的 `Known Limitations and Deferred
Work` 段）。

下文的每条结论都能落到一个具体的包和版本。**没有实机跑通任何链路**——本阶段不引入
原型代码（见「决策」）。凡是"没跑过、只读了契约"的地方，下文显式标注。

## 调研发现

### 1. 审批与权限模型（初版最大的未决问题，现已有答案）

DSH 的审批不在 `dsh-base` 里，而是三个各管一段的包，加上 tool registry 的一道闸门：

| 包 | 职责 |
|----|------|
| `dsh-user-approval` | 通道中立的一次性审批 seam（`ctx.approval`） |
| `dsh-permission-presets` | 把 sandbox mode + approval policy 打包成用户可选的预设 |
| `dsh-sandbox-policy` | 持有 sandbox mode 这个旋钮本身 |
| `dsh-tools` | `tools/pre-execute` waterfall + `ctx.tools.guard()`，真正的 per-call allow/deny/ask 闸门 |

**`ctx.approval.request(req)` 返回 `allowed-once` / `rejected` / `cancelled` /
`unavailable`，缺失或失败的 answerer 一律 fail closed，授权只对被请求的那一次动作生效。**
每次请求成对追加 `approval/asked` 与 `approval/decided` 两条 session event 作为审计；
这两条是 log-only，模型只看得到最终的工具结果。审计追加失败会拒绝请求，而不是返回一个
没落账的决定。这套 fail-closed + 落账语义与我们的
`approval-decision-service.js` 是同一种设计直觉。

但四条限制里有三条与本项目的现有决策直接冲突，其中第一条是硬阻塞：

1. **审批请求不携带工具参数。** 包 README 的已知限制原文：answerer 只看到 tool name、
   reason 和可选的 call id。[ADR 0006](0006-user-skill-enablement-gate.md) 的整套机制建立在
   相反的前提上——`source_digest` 用 sha256 把审批钉在**字节**上，正因为高风险工具的参数是
   审批后重放的、路径不等于内容。DSH 的审批 seam 结构性地无法表达"批准这一份内容"，
   只能表达"批准这次调用某个工具"。ADR 0006 P1 的 (B) 条（启用绑定内容摘要）在这个
   seam 上无处安放。
2. **`ApprovalPolicy` 只有 `'ask'` 和 `'never'` 两个值。** 没有风险分级，没有
   `allow-always`、记忆规则、授权撤销或 grant store（README 自陈）。我们的
   `config/agent/tool-risk.json` 是按工具名解析风险等级、再由风险表决定是否
   `require_approval`；DSH 没有这一层，只有全局开关加逐调用的 pre-execute 判断。
3. **请求必须处在一个 open turn 内**，出圈或 turn 之间的调用方直接抛错，README 明写
   "a durable out-of-turn approval workflow is deferred"。我们的 BFF 是发
   `approval_required` SSE 后由人**异步**决策；这条限制是否阻塞需要实测，但契约层面
   DSH 假定的是同步的、turn 内的人机往返。
4. **没有内置 answerer**，服务本身从不提示人；headless 或组合不完整的部署一律解析为
   `unavailable` 并 fail closed。这条不是缺陷（是干净的分层），但意味着企业审批 UI 要
   自己实现成一个 `approval/request` waterfall listener。

`dsh-permission-presets` 出厂三档：`read-only`（sandbox read-only + approval ask）、
`workspace-write`（workspace-write + ask）、`danger-full-access`（danger-full-access +
never）。预设在 **session 创建时 pin 进该 session**，之后改设置不影响已存在的 session
（这个不可变性做得很好，和我们 `agent_version.configJson` 的冻结快照是同一个思路）。
但预设表本身是 **process-level**，改可选项要重载插件——**没有租户维度**：整个模型是
"一台机器上的一个人给自己选一档权限"。

**真正与我们的 `enterprise-policy` extension 可对齐的挂载点是 `dsh-tools` 的
`tools/pre-execute` waterfall 加 `ctx.tools.guard()`。** guard 是单调的：返回一个 reason
即拒绝，后面的 listener 不能把拒绝翻回许可；guard 可以挂在全局 context 或某个 agent 的
`agent.ctx` 上。风险表 → guard 是能落地的映射。

但有一条已知限制要记下来：**`tools/pre-execute` 被刻意设计成不能改写
`exec.arguments`**（理由是落账和渲染的参数会与实际执行的脱节，rewrite 设计目前只是一份
proposed note）。我们现在的 `arg-guards.js` 是**拒绝**不合规形态，不是改写，所以能对上；
但 extension 侧的 `tool_result` rewrite 能力在 DSH 里对应的是 `tools/post-execute`
（可以替换 presentation content、替换 canonical value、带反馈阻断、附加 context），这一侧
是够的。

### 2. Sandbox 与隔离（初版判断需要修正）

初版写"DSH 只定义了 `ctx.sandbox` 能力接口，插件化本身不提供隔离保证"。前半句对，
后半句给了错误印象：**DSH 出厂就带一个真做隔离的 provider**。

`dsh-sandbox-local` 在 Linux 上优先探测可用的 `bwrap`，其次 Landlock；macOS 用 Seatbelt；
Windows 用 ACL restricted-token runner。不支持的平台和不可用的 runner **fail closed**
（`SANDBOX_UNAVAILABLE`），README 明写 "execution never silently falls through
unconfined"。每次 wrap 还回报 `enforcement` 完整度（Landlock 老内核 ABI 与 Windows ACL
只能报 `partial`，README 不肯把 partial 说成 full），以及后端特定的拒绝签名，让消费者能
区分"沙箱坏了"和"命令失败了"。这份诚实度高于文档层面给人的印象。

所以「`ctx.sandbox` 能不能套 Bubblewrap」这个问题的答案是：**已经套了**。但真正的结论
是两条冲突，都不是接口问题：

**(a) 出厂 bwrap profile 与 [ADR 0004](0004-session-persistent-tmp.md) 直接冲突。**
DSH 的 bwrap profile 是只读 host root + fresh `/dev` + private-PID `/proc`；
`workspace-write` 档追加 **ephemeral `/tmp`** 和一个可写的 workspace bind。ADR 0004 的
决定正好相反：`/tmp` 必须是 **Agent Session 私有且跨 Run 持久**的
`SANDBOX_TEMP_ROOT/tmp_{workspace_id}`，因为多个 Run 是一个连续工作上下文，脚本物化和
长 Process Handle 要跨执行存活。要保住 ADR 0004，只能走 `runnerCommand` 配一个自定义
runner——而该包 README 自己把 `runnerCommand` 标为 **"an operator assertion"**：跳过功能
探测、假定自定义 runner 诚实地实现了 bwrap 兼容 profile，并且如果它本身是个 bash 脚本，
解释器启动会先于约束生效。用这条口子承载我们的隔离边界，等于把 ADR 0004 的验证责任
（`tests/test_bubblewrap_isolation.py` 那一组）整个搬到一个显式声明"不再探测"的接缝后面。

**(b) 更根本的是进程模型。** `ctx.sandbox` 的语义是"消费者在 spawn 前把 argv 包一层"，
隔离与 harness **同主机、同进程树**。本项目的边界是 Agent（Node）→ Sandbox REST
（Python，独立服务/容器），ADR 0001 硬规则第 1 条写死"SDK 不是沙箱，信任边界住在
`sandbox/`"。DSH 的 base bundle 里所有能力提供者都是本机实现——`sandbox-local`、
`fs-local`、`subprocess-local`、`jobs-local`、`credentials-local`、`spill-local`、
`attachment-local`——**没有任何 remote provider**。要复用我们的边界必须自写一个 remote
sandbox provider，并先证明"包 argv"这个接口能表达"隔离发生在另一个容器里"。这不是
配置工作。

顺带一个值得借鉴的分层声明：`dsh-fs-sandbox`（文件工具族的模式围栏）在 README 里直接
写明自己 **"a policy fence, not a kernel boundary"**——它是可信代码里对模型可控路径做
canonicalize-then-contain，显式接受残余 TOCTOU，并把"不可信**代码**的内核级隔离"划归
`ctx.shell`。同时它保证 fs 围栏和 bash runner 从同一个 `writableRoots` 函数派生可写根，
"so the fs fence and the bash runner cannot drift"。这两点——**分层职责写进文档**、
**两条执行路径共享同一个事实源**——正是 ADR 0006 (A) 条要求的"启用集必须与执行时的
绑定走同一个事实源"的同一种纪律。

### 3. Session 事件日志与长期恢复（初版第二个未决问题）

**结论：不能映射到 ADR 0005 的分层，只能整体替换；接口是开的，但不变量对不上。**

`dsh-session` 是 append-only 事件日志加一层 **surface**（消息产出事件的有序投影），
LLM 消息历史从 surface 派生。每个 `SessionEvent` 带三个可选结构字段：`sourceEventSeqs`
（引用的来源事件 seq）、`surfaceOp`（如何进入 surface）、`ignorable`（读者可安全跳过）。
`SessionEventMap` 可由插件 declaration-merge 扩展，**扩展方自己拥有它那些事件的关系
不变量**。这套设计比 pi 的 JSONL entry 树更明确地把"模型可见"和"仅落账"分开，值得学。

但持久化那一侧是这样的：`dsh-session-persistence-jsonl` 在 base bundle 里**默认挂载**，
`root: $DSH_HOME/sessions`，布局是
`<root>/--<normalized-cwd>--/<encoded-id>/session.jsonl.zstd`——**每 Session 一个持久
`.jsonl` 文件**。这恰好是 [ADR 0005](0005-pi-session-jsonl-persistence.md)「备选方案」
表里第一行、已被明确**拒绝**的形态。

该 backend 的已知限制里有两条直接撞我们的需求：

- **"One live writer per session"**：append 与 repair 只在拥有该 session 的 backend 实例
  内部协调，另一个实例或进程在其 quiescent disposal 之前不得写同一个 session。
  ADR 0005 §5 的模型是相反的：journal append、Session 版本推进、snapshot pointer、
  Run Event 与 Outbox 在**一个 MySQL 事务**内完成，并在写 snapshot 前再校验 execution
  fence——它假定的是多 Worker 竞争加乐观 fence，不是单写者独占。
- **"Nothing deletes session files"**：seam 根本没有删除 API，日志在 `root` 下无限累积
  直到被外部清理。多租户 retention、legal hold、受控删除（ADR 0005 §6 明确要另开决策）
  在 DSH 侧连接口都不存在。

再加两条版本约束：`SESSION_FORMAT_VERSION` 固定为 `0`，pre-release，**没有任何迁移
路径**——读到更新的版本报"upgrade"，读到更旧的直接说"no upgrade path ships yet"；
未知 event type 只要没标 `ignorable`，**整个 session 拒绝重建**。对一个我们要长期承载
企业会话历史的存储层，这是当下最劝退的一条。

接口上确实是开的：`SessionPersistence` 是个 seam，自写一个 MySQL backend（订阅
`session/event` 写后、在 `session/flush` 时 drain）在类型上完全可行。但"单写者"、
"format v0 无迁移"、"未知事件拒绝重建"三条合起来，意味着 ADR 0005 那套分层
（snapshot 是加速层、journal 是长期依据、fence 保护 checkpoint）要在 DSH 的不变量里
从头重写一遍并重新验证，不是平替。

**反过来，有三处 DSH 已经做了、而 ADR 0005 正想要的东西，可以直接借鉴，不需要迁移
Runtime：**

1. **`dsh-attachment-local`：durable image bytes 存在 append-only log 之外**，消息里只留
   content-addressed 引用，由后端在发 provider 请求和授权历史读取时解析。这正是
   ADR 0005 §4 想要的形状（"大 payload 只记录不可变引用、摘要、MIME 和大小"），并且
   证明了一件我们当时不确定的事——**Harness 侧可以做到不把字节内联进会话日志**。
   Pi 是否有等价机制值得单独查一次；这是本次调研最有直接价值的一条。
2. **Packed chunk rows**：`text-chunks` / `reasoning-chunks` / `tool-call-chunks` 三种行
   把 ≥3 条连续同 block 的 `assistant/chunk` delta 合成一行，`seq0`/`time0` 加逐成员
   `dt` 精确重建每个成员的 `seq`/`time`；codec 白名单精确形状，不认识的一律逐字存储，
   读端 layout-blind。README 称在真实 coding session 上实测**逻辑日志缩小约 60%**。
   ADR 0005 §迁移策略第 1 步要"记录真实行大小"，这个编码技巧对 `entry_bytes` 的写放大
   是可直接借鉴的，且完全不触碰我们的权威模型。
3. **崩溃修复的模型可见语义**：assistant 请求了工具但没有 durable `tool/call` →
   合成 `TOOL_NOT_STARTED`；有 `tool/call` 但没有结果 → `TOOL_OUTCOME_UNKNOWN`，
   文本里直接告诉模型"只对只读或幂等的工作重试；可能有副作用的先验证外部状态或问
   用户；不要盲目重试"。我们的恢复目前是 `RECOVERY_REQUIRED` fail closed 由人介入，
   补一个等价的、模型可见的修复结果是一个独立的小改进。

### 4. 维护活跃度（初版第四个未决问题）

2026-08-28 读数：

| 指标 | 值 | 判读 |
|------|----|------|
| star / fork / watcher | 201,704 / 23,160 / 882 | 仓库 2026-08-13 创建，14 天 |
| **Issues** | **已关闭**（`has_issues: false`），只开 Discussions | 没有公开缺陷追踪面，也没有可引用的公开漏洞上报通道 |
| 最近提交 | 最后 push 2026-08-27；近一周 100+ commit（API 单页上限） | 高强度活跃 |
| 版本节奏 | 08-10 `0.0.1-rc.1` → 08-21 `0.1.1-rc.2` → 08-27 tag `dsh-v0.1.2-alpha.1` | 14 天 11 个 npm 版本 |
| 署名 contributor | 29 | 集中在一个团队 |
| 许可 | MIT，未变 | |

"star 数"在这里不是维护活跃度的证据——它是 V4 Pro 发布同日开源带来的关注度。
**Issues 被关闭这一条对企业采用的分量更重**：无法用 issue 走势判断缺陷处理质量，
无法追踪已知安全问题，也没有一个可以写进合规文档的上报通道。

两条工程卫生问题，是本次调研的意外发现，任何试点都必须处理：

- **npm dist-tag 是错的。** 子包（如 `@deepseek-ai/dsh-base`）的 `latest` 至今仍指向
  `0.0.1-rc.1`，`next` 才是 `0.1.1-rc.2`，而 CLI 自己依赖 `^0.1.1-rc.2`。
  `npm i @deepseek-ai/dsh-base` 会装到一个两周前的 rc。任何试点必须**逐包 exact pin**
  （与 ADR 0001 的 exact pin 政策一致），不能依赖 dist-tag。
- **包不声明 `engines`。** `@deepseek-ai/dsh` 及检查过的子包 `package.json` 里都没有
  `engines` 字段。ADR 0001 靠 `runtime-versions.json` 加 SDK 自身声明的 `>=22.19.0`
  把 CI、Docker 镜像和 package `engines` 三方对齐，并由 `tests/test_runtime_versions.py`
  强制；DSH 不提供这个信号，Node 版本要求只能靠试出来，且没有任何东西会在升级时提醒
  它变了。

README 自陈 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"。这与 `SESSION_FORMAT_VERSION
= 0` 无迁移路径是同一件事的两个说法。

### 5. 调研新增的风险（初版完全没有覆盖）

1. **默认遥测指向 DeepSeek 的服务端。** `dsh-session-telemetry-otel` 在 base bundle 里
   **默认挂载**（`mode` 默认 `DISABLED`，需 `DSH_TELEMETRY_MODE` 显式开启）。组合文件的
   注释写得很清楚：一旦开启，就把 session-log 记录镜像到 OTLP/HTTP，**没有任何 redaction
   规则**——"exports are the raw captured copy"；默认端点
   `https://harness-telemetry.deepseeksvc.com/v1/logs`，并携带
   `$DSH_HOME/.anonymous-user-id` 作为 Resource 的 `user.id`。对一个执行不可信用户代码的
   多租户服务，这一行必须在组合层显式移除或置 disabled——注意 **"config cannot disable a
   row"**，官方 launcher 自己也是靠 patch 把整行置 disabled 而不是靠配置。这是"默认安全"
   与"默认可观测"取舍的一个具体分歧点。
2. **默认出网。** base bundle 默认启用 `web_search`（`dsh-web` + `dsh-web-search-deepseek`，
   用 `DEEPSEEK_API_KEY`，60s 超时）。`fetch` 被显式关闭，理由写得很好——
   "that provider defers SSRF protection and the model would choose the request target"
   ——说明团队对 SSRF 有清醒认识；但 search 本身即是默认 egress。
3. **凭据没有租户维度。** `dsh-credentials-local` 从继承环境、`$DSH_HOME/.credentials.yaml`
   和 project/user `.env` 解析，Web 的 Models 页会写那个 managed 文档。ADR 0001 硬规则
   第 4 条要求 secrets 只留服务端且绝不下发浏览器；DSH 的模型是"这台机器上的这个人的
   key"，多租户下"这是谁的 key"没有表达方式。
4. **Code Mode 是一类新的、不受账本约束的内存与容量面。** `dsh-tools` 的
   `mode: code | both` 让模型只能调 `run_code`，其余工具从 TypeScript/Python 程序里调用。
   worker 的 `maxOutputBytes` 默认 **64 MiB**，且 README 明写中间绑定值 execution-local、
   **无字节上限、无法从会话重放重建**。这与 ADR 0005 §4「所有输入走同一个 materialized-size
   预算器、在调用模型前 fail closed」的统一预算模型正面冲突。默认是 `native`；任何试点
   都应保持 `native`，并把 Code Mode 单列为一个需要独立评估的话题。
5. **单租户假设是写进 base bundle 的，不是配置默认值。** 上面第 2 节列的那一串 `-local`
   provider，加上单一的 `$DSH_HOME`（内含匿名用户 id、settings、credentials、sessions），
   构成一个"一台机器、一个用户"的世界观。`ctx.scope` 的分层是 **agent preset 维度**，
   不是租户维度。ADR 0005 §5「所有 repository 读写必须显式接收 `org_id + user_id` scope，
   即使 ID 全局唯一也不能省略」在 DSH 里没有任何对应物——要自己造，而且要造在一个
   不为它设计的分层模型上。
6. **默认模型是 `deepseek-official` / `deepseek-v4-flash`**，但 `dsh-llm-pi-ai` 作为多
   provider 适配器**以 dormant 状态挂载**，由 `settings.yaml` 的 `llm-pi-ai:` 段激活并注册
   路由，key 按请求经 `apiKeyEnv` 引用解析。接我们的 LLMIO 网关有现成挂载点，**这一条
   不是阻塞项**——组合层可选适配器，用户设置决定跑哪些 provider，分得很干净。

### 6. Skill 模型对比（对 [ADR 0006](0006-user-skill-enablement-gate.md)）

DSH 的 skill 是三层：`dsh-skill` 是纯 provider registry（`ctx.skills`，不关心 skill 来自
本地文件、插件内嵌、HTTP 还是别的后端），`dsh-skill-filesystem` 是出厂的本地实现，
`dsh-tool-skill` 提供模型可见的 catalog 和 `skill` 工具。

**对得上的一半：** `SkillSummary.invocation` 是一个必填的四态策略对象
（`modelInvocable` × `userInvocable` 的四种组合都保留），registry 让"一次发现结果同时
服务模型面工具、人机面命令和可信内部调用者，而不混淆它们的目录"。这比我们现在
"列进 prompt / 不列"的二元粒度细，且是 registry 层的既有概念——ADR 0006 P1 的"启用态"
中**控制 prompt 列表与模型可调用性**的那一半，在 DSH 里有现成的形状可抄。

**对不上的另一半，恰恰是 ADR 0006 的分水岭。** P1 的 (A) 条是"启用态必须控制**绑定**，
不能只控制 prompt 列表"。DSH 里 skill 目录的**可执行性**由 `ctx.sandbox` 的 workspace
绑定和 `bash` 决定，`ctx.skills` 的 invocation 策略**完全不影响文件系统可达性**——这和
我们现在 `bubblewrap.py` 把 `<base>/<orgId>/<userId>` 整个 `--ro-bind` 进去、未启用的包
照样能被 `python .../scripts/x.py` 执行，是**同一个形状的漏洞**。DSH 没有解决它；
它只是因为单租户、单用户，所以不需要解决。**这条不能当作 P1 的反例，它是 P1 论证的
佐证。**

(B) 条（启用绑定内容摘要）在 DSH 里没有对应物：skill 没有 digest 概念，`get()` 每次都向
provider 现要 body。

DSH 也**没有 skill 的安装/创建/编辑/卸载工具**——只有一个加载用的 `skill` 工具。所以
ADR 0006「不采纳的类比」那一段里对单机 Agent 的分析，对 DSH 同样成立而且更强：它连
写入面都没开。

**有一处值得抄：** `dsh-tool-skill` 的 catalog 重发判定用的 digest **只覆盖它发布过的
`name` + `description` 这些 durable entries，不覆盖渲染出来的散文**，README 的理由是
"the surrounding `<system-reminder>` framing cannot decide whether a republish is needed"，
且消费者永远不重新解析 `<available_skills>` 块。我们做 P1 的启用态 catalog 时会遇到
一模一样的问题（改了外框文案不应触发全量重发），这个约束值得直接照搬。

## 调研结论（倾向性，待决策所有者签署）

**建议：短期维持 Pi，不迁移——但理由不是"Pi 够用"，而是"DSH 的阻塞项比 Pi 的痛点更硬"。
同时把 Pi 侧的缺口显式立案，不再隐性承担。**

这个结论比初版弱，也更准确。理由分四层：

**(1) ADR 0001 的退出条件不是"一条都没触发"——需要决策所有者重新判定两条。**
初版这里写的是"一条都没触发"，那是在没核实 Pi 现状的情况下写的，错了。按证据重判：

| 退出条件 | 判定 |
|---------|------|
| 1. 许可变更 | **未触发**，仍 MIT |
| 2. 产品所需的关键能力**无法**通过公共 API 实现 | **部分触发。** 每 Run 的工具预算是收敛性/成本护栏，目前只能靠改写两个非公共字段实现；`AgentVersion.sandboxPolicy` 在 Pi 里没有执行路径；session 恢复必须经磁盘文件往返。前两项是能力缺口，不是风格问题。 |
| 3. 上游停止维护 | **未触发** |
| 4. 兼容成本超出批准预算 | **待判定。** commit `be4a077a` 一次就清掉"两个升级后会静默失效的 monkeypatch"；`agent-hook-points.test.js` 是为了守住其中一个而专门写的。这类成本是否已超预算，是决策所有者的判断，不是本 ADR 能替它下的。 |
| 5. 引擎/平台约束无法满足 | **未触发**（Node 22 对齐良好） |

条件 2 和 4 的存在，意味着**"维持 Pi"不再是免费的默认选项**。它现在是一个带已知欠账的
选择，欠账应当被记下来（见「影响」）。

**(1b) 但退出条件触发的方向是"考虑 fork 或自建"，不是"换成 DSH"。** ADR 0001 的
第 2 条原文是"无法通过公共 API（`customTools`、Extension hooks、SessionManager entries、
BFF orchestration）实现"。真正对应的动作是：把工具预算搬到公共 `tool_call` extension 事件
上（`agent-hook-points.test.js` 自己就写明了这条退路："move the budget onto the public
`tool_call` extension event"），或向上游提 issue/PR 要一个公共钩子。**这两条都比换 Runtime
便宜一个数量级**，且不受 DSH 那堆阻塞项影响。

**(2) DSH 原生提供了我们手搓的一大半——这是本次调研对 Pi 最有力的一条反证，必须记下来。**

把上面「Pi 侧的实际约束」的缺口清单，对着 DSH 的 base bundle 逐条查：

| 我们自建的东西 | DSH 是否原生提供 |
|---------------|-----------------|
| `spawn_subagent` / `check_subagent`（BullMQ 上的持久子 Run） | **有**：`dsh-subagent` + `dsh-tool-subagent` + `dsh-tool-subagent-control`，两种 provider（`spawn` 独立上下文 / `fork` 继承历史），`continuable` 与 `one-shot` 两种背景模式，外加 `list_agents` / `send_message` |
| `todo_write` / `todo_read` | **有**：`dsh-tool-todo`（含 `allowParallelInProgress`） |
| 后台进程与轮询 | **有**：`dsh-jobs-local` + `dsh-tool-jobs`（`job_output`/`job_list`/`job_kill`），且 job runtime 自己管 id、跨 session 隔离、完成通知 |
| `ask_user`（现在靠抛异常中断 turn） | **有**：`dsh-tool-ask-user` + `dsh-user-questions`——但同样受"必须在 open turn 内"限制，**不是** durable suspend |
| 每 Run 的工具/超时预算（现在是补丁） | **有公共 seam**：`dsh-tool-call-timeout-policy` 是 `tools/execute` 的 around wrapper；预算类插件是这个 seam 的**声明用途**，不是内部字段 |
| 大结果溢出到文件 | **有**：`dsh-spill-local` + `dsh-spill-policy`（`maxInlineBytes`） |
| 压缩策略 | **有**：`dsh-compaction-basic` + `dsh-compaction-tool-result-pruner`，且是可替换 seam |
| Session 恢复（现在必须物化 JSONL 文件） | **有**：`SessionPersistence` 是一等 seam，backend 订阅 `session/event`、`session/flush` 时 drain，**不经磁盘文件往返** |
| Plan mode | **有**：`dsh-plan-mode` |
| MCP | **有**：`dsh-mcp-client` |
| `memory_write` / `memory_search` | **没有** |
| 事件脱敏（277 行） | **没有**，而且反向——遥测导出显式无 redaction 规则 |
| 多租户 scope | **没有** |

**这条对比是本次补充调研最重要的结论：**我们那 10,727 行里，有相当一部分不是"企业需求
的必然成本"，而是"Pi 没有这些原语的成本"。DSH 证明了一个 Harness 可以把 subagent、jobs、
todo、spill、compaction、timeout policy、persistence backend 全部做成**声明好的可替换
seam**——我们在 Pi 上是逐个自建，而且其中一个（工具预算）连挂载点都得自己凿。

同时注意这条对比的**边界**：DSH 原生有的这些，几乎都是**单机、单租户、turn 内**的版本。
它的 `ask_user` 和我们一样不能 durable suspend；它的 subagent 是进程内 fork/spawn，不是
我们那种落在 BullMQ 上、能跨 worker 重启的持久子 Run；它的 jobs 没有跨租户账本。所以
**不能得出"迁过去就省掉 10,727 行"**——真实的节省更接近"省掉自建原语的骨架，保留全部
企业语义的填充"。

**(3) DSH 当前形态给出的是反方向的证据，且集中在我们最不能让步的三处：**

| 我们的约束 | DSH 现状 |
|-----------|---------|
| 审批钉在内容字节上（0006 `source_digest`） | 审批请求**不携带工具参数**，结构性做不到 |
| MySQL 事务 + fence 的多 Worker 恢复（0005 §5） | 持久化 backend **单 session 单写者**；`SESSION_FORMAT_VERSION = 0` 且**无迁移路径** |
| Session 私有、跨 Run 持久的 `/tmp`（0004） | 出厂 bwrap profile 是 **ephemeral `/tmp`**；改法只有一个"跳过探测"的 operator assertion 口子 |
| 租户 scope 贯穿所有读写（0005 §5） | base bundle 全是 `-local` provider + 单一 `$DSH_HOME`，**没有租户维度** |
| 隔离住在独立的 Sandbox 服务（0001 硬规则 1） | `ctx.sandbox` 是**同主机 argv 包装**，无 remote provider |

再叠加 SAFETY.md 已经声明的"未经安全审计、不能作为不可信工作负载的唯一安全控制"，
以及 Issues 关闭、14 天 11 个版本、`engines` 缺失、dist-tag 指向陈旧版本——短期内
不具备承载生产 Runtime 的条件。

**(4) 调研的直接产出：四条可以喂回现有 ADR 的设计借鉴。**

| 借鉴 | 去处 | 性质 |
|------|------|------|
| attachment by-reference：大 payload 存在 append-only log 之外，消息只留 content-addressed 引用 | [ADR 0005](0005-pi-session-jsonl-persistence.md) §4 | 证明该形状可行；需先查 Pi 是否有等价机制 |
| packed chunk rows（≥3 连续同 block delta 合一行，`seq0`+`dt` 无损重建，读端 layout-blind，实测 −60%） | ADR 0005 `entry_bytes` 写放大 | 纯编码技巧，不触碰权威模型 |
| catalog digest 只覆盖 durable entries、不覆盖渲染散文 | [ADR 0006](0006-user-skill-enablement-gate.md) P1 启用态 catalog | 直接照搬 |
| `TOOL_NOT_STARTED` / `TOOL_OUTCOME_UNKNOWN`：崩溃修复给模型可见的、带重试指引的合成结果 | `agent/` 恢复路径 | 独立小改进，与本 ADR 结论无关 |

另外记下一条**架构层面的观察**，它比上面任何一条借鉴都更有长期价值：DSH 每个包的
README 都强制包含 `Model Experience`（模型看到什么、token 影响、**KV cache 影响**）和
`Known Limitations and Deferred Work` 两段。"这个插件对请求前缀的 KV cache 有没有
破坏性"被当作一等公民写进每个包的契约——这是我们的 `architecture.md` 和 extension
文档目前完全没有的一个维度。

**如果将来要重开这件事**，窄口子是三个都存在但都要自写的挂载点：
`SessionPersistence` seam（写一个 MySQL backend）、`ctx.sandbox` 的 remote provider
（表达"隔离在另一个容器"）、`tools/pre-execute` + `ctx.tools.guard()`（承载风险表）。
重开的触发条件应当是 ADR 0001 的退出条件之一被触发，**而不是 DSH 本身变得更流行**。

## 决策

1. **调研阶段：已完成，两侧都查。** DSH 侧覆盖了初版列出的四个问题（审批/权限模型、
   Session 事件日志到 MySQL 的映射可行性、`ctx.sandbox` 与 Bubblewrap、维护活跃度），
   并补充了初版未覆盖的遥测、出网、凭据、Code Mode、单租户假设与 skill 模型对比。
   Pi 侧补上了初版完全缺失的对照基线（「Pi 侧的实际约束」一节）。
2. **产出：上面的「调研结论」。** 倾向于「短期维持 Pi」，但结论附带一份必须同时开出的
   欠账清单（见「影响」）——**"维持 Pi"与"处理这些欠账"是同一个决定的两半，不能只签
   前一半。** 在决策所有者签署前，状态保持 Proposed；Runtime 唯一生效实现仍是
   ADR 0001 采用的 `@earendil-works/pi-coding-agent`，本 ADR 不带来任何代码改动。
3. 签署后本 ADR 转 Accepted 并作为**已结案的调研记录**保留；四条设计借鉴与四项欠账
   各自开 issue 或并入对应 ADR，**不在本 ADR 里实施**。
4. **若决策所有者判定 ADR 0001 退出条件第 2/4 条已触发**，正确的下一步不是本 ADR——
   按 ADR 0001 的规定应当另开新 ADR 讨论 fork / 上游 PR / 局部自建，而 DSH 迁移只是
   那份新 ADR 的备选之一，且是被本 ADR 列出的阻塞项压住的那一个。

## 取舍

- **接受**：结论是"短期不迁移"，但**代价是继续承担已列举的 Pi 欠账**，其中工具预算补丁
  是会静默失效的那一类。接受这个结论就等于接受"下一个 Pi 升级前必须先处理它"。
- **接受**：初版把立项理由写成"没有痛点、纯学习"是错的，本次已更正。这类前提错误的代价
  是结论会朝错误方向倾斜——初版据此得出"退出条件一条都没触发"，而实际是两条待判定。
  **对照基线应当和被调研对象同时调研，不能只查新东西。**
- **接受**：结论基于**读契约而非跑链路**。所有包 README 都是团队自述，`enforcement:
  partial` 之类的诚实标注提高了可信度，但没有一条经过我们实测。若将来重开评估，第一步
  应是实测而非再读一遍文档。
- **接受**：SAFETY.md 的"未经安全审计、不能作为不可信工作负载唯一安全控制"声明，加上
  本次发现的默认遥测与默认出网，意味着即使结论正面，DSH 短期内也只能是"额外的一层"
  而非直接替换生产 Runtime。这条限制留在决策里，避免日后被淡忘。
- **拒绝**：以"DSH 更现代 / 更活跃 / star 更多"为由开迁移。star 数是 V4 Pro 同日开源的
  副产物，不是维护活跃度证据；重开的触发条件写在结论末尾，是 ADR 0001 的退出条件。
- **拒绝**：把 DSH 的 `approval` seam 当作 ADR 0006 P1 的替代设计。它不携带工具参数，
  与 P1 的 (B) 条互斥。
- **待定**：`dsh-attachment-local` 式的 by-reference 存储是否适用于 Pi——取决于 Pi 的
  entry 格式是否原生支持稳定引用（ADR 0005 §4 已把这个条件写成分支）。

## 影响

- 当前无代码变更，也不产生原型分支。
- **「背景」一节已按证据更正**：初版的"没有已识别的 pi 无法满足的需求"是错的，真实驱动
  因素是 Pi 侧已经积累的适配成本与两处非公共 API 补丁。这条不再是"待补充"，是已补充。
- **本 ADR 结案时应同时开出的欠账**（它们不属于本 ADR，但因本 ADR 而被发现，不记下来就
  会重新沉默）：
  1. **把每 Run 工具预算从 `agent.beforeToolCall` / `prepareNextTurnWithContext` 搬到公共
     `tool_call` extension 事件**——`agent-hook-points.test.js` 自己指定的退路。这是唯一
     一条"下次 Pi 升级可能静默失效并放开无界工具循环"的。优先级最高。
  2. 修掉 `pi-run-tool-budget.js` 文件头那句与其 compat 测试矛盾的"uses the public Agent
     hook points"。注释比代码更容易骗到下一个人。
  3. `AgentVersion.sandboxPolicy` 与 `@earendil-works/pi-ai`（已 pin 但零 import，见
     `docs/review-deferred-items.md`）各自决定"删掉还是写明为什么留着"。
  4. 评估向上游提 issue：公共的 turn/tool 预算钩子、session hydrate API、导出 session
     版本与 entry-type 表。这三项若上游接受，本 ADR 列的 Pi 特有成本大部分消失。
- 四条设计借鉴的去向见「调研结论 (4)」的表；它们**不改变** ADR 0004/0005/0006 的任何既有
  决策，只是给 0005 §4 和 0006 P1 增加实现证据与一个可照搬的约束。
- **ADR 0001 需要一次复核**：它的「API surface inventory」称 `ExtensionRunner` /
  `extensionFactories` "not imported by the BFF today"，但 `agent/src/extensions/` 是一个
  7,412 行、7 个 extension 的在产 bundle；它的退出条件第 2 条的判定也应按本 ADR 的证据
  重走一遍。这属于 ADR 0001 的维护，不在本 ADR 内改。
- `agent/` 与 `sandbox/` 不因本 ADR 引入任何 DSH 依赖。若将来重开评估并需要原型，仍按
  初版约定在独立分支/子目录中进行，不合入主干。

## 参考

### 上游文档

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（README、
  `AGENTS.md`、`docs/architecture.md`、`SAFETY.md`）
- [官方文档站](https://deepseek-harness.github.io/deepseek-harness/)

### DSH 侧一手证据（npm `next` tag，`0.1.1-rc.2`，发布于 2026-08-21）

| 结论 | 证据包 |
|------|--------|
| 组合层与出厂默认（遥测、web_search、权限预设、默认模型） | `@deepseek-ai/dsh-base` 的 `cordis.patch.yml` |
| 审批 seam 的返回值、审计事件、四条已知限制 | `@deepseek-ai/dsh-user-approval` |
| 三档权限预设、session 创建时 pin、preset 表 process-level | `@deepseek-ai/dsh-permission-presets` |
| `tools/pre-execute` 闸门、`ctx.tools.guard()` 单调性、不可改写 arguments、Code Mode 与 64 MiB | `@deepseek-ai/dsh-tools` |
| bwrap/Landlock/Seatbelt/ACL runner 选择、fail closed、`enforcement` 完整度、ephemeral `/tmp`、`runnerCommand` 是 operator assertion | `@deepseek-ai/dsh-sandbox-local` |
| "policy fence, not a kernel boundary"、`writableRoots` 单一事实源 | `@deepseek-ai/dsh-fs-sandbox` |
| `sandbox_permissions` 升级参数、`justification` 必填、一次性授权、denial 标记 | `@deepseek-ai/dsh-tool-bash` |
| 事件日志/surface、`SessionEventMap` 合并扩展、`ignorable`、`SESSION_FORMAT_VERSION = 0`、崩溃修复语义 | `@deepseek-ai/dsh-session` |
| 每 session 一个 `.jsonl.zstd`、packed chunk rows（−60%）、单写者、无删除 API | `@deepseek-ai/dsh-session-persistence-jsonl` |
| 四态 `invocation` 策略、provider registry 分层 | `@deepseek-ai/dsh-skill` |
| catalog digest 只覆盖 durable entries | `@deepseek-ai/dsh-tool-skill` |
| 包树规模、无 `engines` 声明、profile/bundle 机制 | `@deepseek-ai/dsh` |

npm dist-tag 现状（2026-08-28）：`@deepseek-ai/dsh` 的 `latest` = `next` = `0.1.1-rc.2`，
但子包的 `latest` 仍停在 `0.0.1-rc.1`。仓库元数据（star/fork/issues 关闭/提交与
release 节奏）读取自 GitHub API，同日。

### Pi 侧一手证据（本仓库 `main` @ `4dda7a9b`）

| 结论 | 证据 |
|------|------|
| 工具预算改写两个非公共字段；compat 测试为防静默失效而写 | `agent/src/application/pi-run-tool-budget.js:126-127`、`agent/tests/sdk-compat/agent-hook-points.test.js:1-13` |
| 无 snapshot/hydrate/checkpoint API；`open` 静默跳过损坏行 | `agent/src/infrastructure/pi/pi-session-adapter.js:4-12`、`agent/src/infrastructure/pi/pi-jsonl-codec.js:14` |
| `AgentVersion.sandboxPolicy` 无执行路径 | `agent/src/infrastructure/pi/agent-version-bindings.js:619-623` |
| `applyOverrides` 被 `save()` 静默丢弃 → 改用 `inMemory(seed)` | `agent/src/application/context-policy-service.js:1-24` |
| `excludeTools` 按名字且作用于 extension tool，曾导致模型丢失 workspace search | `agent/src/infrastructure/pi/pi-runtime-constants.js:14-30` |
| `ask_user` 靠抛异常中断 turn 实现可恢复暂停 | `agent/src/extensions/user-interaction/index.js:5-6, 106-115` |
| 子 Run 不能继承父 AgentSession（Run 独占执行锁） | `agent/src/extensions/subagent-spawn/index.js` |
| 静态 import SDK 约 300ms，A2A 路径改为自解析 frontmatter | `agent/src/skills/frontmatter.js:12-18` |
| "两个升级后会静默失效的 monkeypatch"及能力缺口清单 | commit `be4a077a` "fix(pi): close the gaps between the agent service and the Pi SDK (#10)" |
| `@earendil-works/pi-ai` 已 pin 但零 import | `docs/review-deferred-items.md:92` |
| 适配层规模 10,727 行 | `agent/src/extensions/`（7,412）+ `agent/src/infrastructure/pi/`（3,315） |

### 其它本仓库对照物

- `agent/src/extensions/enterprise-policy/arg-guards.js`、`config/agent/tool-risk.json`
- `agent/src/application/approval-decision-service.js`
- `sandbox/isolation/bubblewrap.py`、`tests/test_bubblewrap_isolation.py`
- `agent/src/extensions/skill-lifecycle/index.js`
- `docs/runbooks/sdk-upgrade.md`
