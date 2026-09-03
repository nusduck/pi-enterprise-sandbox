# ADR 0007: 在 DSH 上重建 Agent Runtime，并全栈统一 TypeScript

| 字段 | 值 |
|---|---|
| 状态 | **Accepted**（2026-08-30 实施完毕；实施偏差见文末「实施记录」） |
| 日期 | 2026-08-29 |
| 决策所有者 | Agent runtime maintainers |
| 适用范围 | `agent/` 的 Runtime 层、新增 `runtime/` 与 `contract/` 包；`exec/` 见 [ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md) |
| 取代 | **[ADR 0001](0001-pi-coding-agent-sdk.md)**、**[ADR 0002](0002-dsh-harness-evaluation.md)**、**[ADR 0005](0005-pi-session-jsonl-persistence.md)**（均转 Superseded） |
| 关联决策 | [ADR 0004](0004-session-persistent-tmp.md)（不变）、[ADR 0006](0006-user-skill-enablement-gate.md)（不变）、[ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md)（同批交付） |
| 详细设计 | **[docs/design/dsh-rebuild.md](../design/dsh-rebuild.md)**；逐函数移植对照见 [design/waves/gap-audit.md](../design/waves/gap-audit.md) |
| 上游基线 | `@deepseek-ai/*@0.1.1-rc.2`，**本次逐包下载核实**（非二手转述） |

## 背景与约束

`@earendil-works/pi-coding-agent` **已不可用**——不是"将要停用"，是现在就不能跑。约束由
决策所有者给定，本 ADR 不讨论其成因：

1. **Pi 不可用，没有并行窗口。** 不存在新旧双 Runtime 并行、影子比对、逐租户灰度。
2. **`@earendil-works/*` 不得作为本仓库的直接依赖**（作为 DSH 的传递依赖允许）。
3. **DSH 是唯一可选项。** [ADR 0002](0002-dsh-harness-evaluation.md) 的调研在此复用为
   **风险清单**，不再是选型依据。
4. **项目处于研发阶段。** 决策所有者确认：**无历史数据迁移，无回退目标**。
   本次发布不可逆——回滚的结果是继续停摆，不是回到旧 Runtime。这一条必须写明，
   因为早期草案里的"止损线"措辞会让读者误以为有退路。

## 本 ADR 相对早期草案的三处事实更正

早期草案依据 [ADR 0002](0002-dsh-harness-evaluation.md) 的二手记录写成，本次逐包核实后更正：

| 早期草案 | 实际（`0.1.1-rc.2`） |
|---|---|
| `session-telemetry-otel` "默认开启、无 redaction 规则" | **默认 `DISABLED`**（`mode: $DSH_TELEMETRY_MODE \|\| 'DISABLED'`），且记录经 `sessionTelemetry/record` 瀑布脱敏。导出地址确实默认指向 `harness-telemetry.deepseeksvc.com`，**显式钉住仍然必要，但理由要改写** |
| `ctx.attachment` 可承载大 payload 的 by-reference | 实际是 `ctx.attachments`，且**只支持图片**——包文档明写"通用文件、音频、视频需要另外的生命周期与 provider 契约"。**Artifact / Dataset 路径必须继续由我们自己承担** |
| 持久化是"官方 `PersistenceCoordinator` + 自实现 `PersistenceBackend`" | 接缝叫 `SessionPersistence`，后端契约是 **8 个方法**（见下）。命名要改，设计成立 |

## 决策

### D1：全栈统一 TypeScript

`exec/` 用 TS 重写，Python 版 `sandbox/` 收敛后删除。

**理由不是语言偏好，是一条具体的技术事实**：`dsh-fs-local` 已经实现了 `ctx.fs` 的
12 个基础操作，**包括文件版本、原子写、按目标加锁的编辑临界区、`createIfAbsent`
的硬链接抢占、`FS_STALE_VERSION` 全套错误码**。这正是 [ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md)
早期草案里工作量最大的三条决策。执行面留在 Python，这些要重新实现一遍；改成 TS，
只需 `extends LocalFileSystem` 加一层多租户围栏。

**附带收益**：两侧同语言后，Agent 与执行面之间**不需要手写 DTO**——直接复用
`@deepseek-ai/dsh-fs` 与 `dsh-shell` 的类型。早期草案里"Python 服务端与 JS 客户端
如何保证契约同批"这个问题因此消失：**类型系统就是契约，编译不过就发不出去。**

### D2：能用原生就用原生

团队方针。核实后可直接接手、把自建版本删掉的：文件与搜索工具、命令工具、后台作业工具、
**上下文压缩**（`dsh-compaction` + `-basic` + `-tool-result-pruner` + `dsh-token-meter`）、
待办、`ask_user`、会话标题、子 Agent 工具面、Skill 工具面、大结果溢出、工具超时、
重复调用提醒、LLM 抽象与重试、工具管线、系统提示词骨架。

清单与对应删除项见[设计文档 §4.1](../design/dsh-rebuild.md)。

**DSH 没有的、必须自建的**：`ctx.fs`/`ctx.shell`/`ctx.jobs` 的远程 provider、
MySQL 会话持久化后端、durable 子 Agent provider（原生 provider 契约写明是**同进程**的）、
启用集 Skill provider、企业策略、每 Run 预算、平台事件投影、追踪 span、
**memory**（整个包树里没有记忆组件）、**凭据 provider**（见 D6）。

### D3：提供 provider，不重写 tool

`ctx.fs` / `ctx.shell` / `ctx.jobs` 的实现指向 `exec/`。DSH 的接缝本就为远程执行世界
设计——`resolve()` 是异步的，文档给的理由是"远程后端可能需要 I/O"；上游已有 E2B
远程沙箱作为一等实现。保留出厂工具，白拿结果标记、截断与 spill、UI presentation、
prompt section，以及 `fs-observation-policy` 那套 read-before-edit 与版本守卫。

### D4：策略挂既有 waterfall，不建平行体系

| 挂载点 | 承载 |
|---|---|
| `tools/pre-execute` | 风险表、参数守卫、`source_digest`、持久 PENDING 审批 |
| `ctx.tools.guard()` | 租户与 fence 的单调兜底——返回拒绝后**后续监听器无法翻案** |
| `tools/execute`（环绕包装） | 每 Run 工具数、轮次、deadline |
| `tools/post-execute` | 脱敏、账本、上下文附加 |

**不组合 `dsh-permission-presets`、`dsh-sandbox-policy`。**
~~不组合 `dsh-user-approval`~~ — **已由 [ADR 0009](0009-dsh-host-tools-and-application-steward.md) D5
改写**：组合 `ctx.approval` 这个 seam，但 answerer 是我们自建的插件（上游不提供
answerer）；风险表与审批记录仍在本表的 `tools/pre-execute` 上铸，租户 / fence 仍走
`ctx.tools.guard()`，不靠审批 UI 绑定字节。停泊语义是 park + 重建会话重放——
上游的 `ctx.approval.request` 必须处在一个 open turn 内，不能挂起等人。
`dsh-permission-presets` 与本机 `dsh-sandbox-policy` 仍不组合（隔离权威是 exec /
Bubblewrap）。
[ADR 0002](0002-dsh-harness-evaluation.md) 判定的「审批不携带工具参数」不再视为
阻断组合的理由：审批记录在 `tools/pre-execute` 里铸，那里参数齐全（其已知限制原文是
不能 *rewrite*，我们也不需要改写）。
**[ADR 0006](0006-user-skill-enablement-gate.md) 的 P1 形状已由 0009 D7 改写**：
用户侧 skill 不再有变更工具，模型直接写草稿根，闸门只剩「启用」。

### D5：会话持久化（吸收 [ADR 0005](0005-pi-session-jsonl-persistence.md)）

`SessionPersistence` 是官方接缝，写一个 MySQL 后端是**正式扩展点**，不是绕路。
后端契约 8 个方法：`name`、`loadStored`、`readStoredRevision`、`loadStoredFrom?`、
`appendBatch`、`commitRepair`、`list`、`close?`。其中 `loadStoredFrom` 是增量恢复的关键，
SQLite 后端已有先例。

**ADR 0005 的六条决策全部继承，只换绑定对象**：日志文件是适配器格式不是在线事实源；
引擎原生事件拆到独立物理表（`session_events`，不再和 `messages` 挤在一起）；
快照按阈值触发不是每 Run 全量复制；容量限制写入前统一判定；一致性与租户语义不变；
冷归档不在在线提交事务里。

**新增**：直接用上游的 `chunk-rows` 存储编解码器——它"无损把事件序列转成紧凑行再转回来，
且原样保留不认识的事件"。这正是早期草案想要的"存确定性字节"缓解措施，上游已经有了。
且**版本拒绝逻辑发生在后端层，后端是我们写的**，兼容策略由我们掌握——早期草案列为
"最大残余风险"的一条因此大幅降级。

### D6：LLM 接入不写适配器，但凭据 provider 必须自建

生产是自有网关，协议与 DeepSeek 官方一致，会承载额外模型。`dsh-llm-deepseek` 的配置
支持自定义 `baseURL` 与**可配的模型目录**（官方示例里就含一个 `Company-hosted reasoning model`
的条目）。`config/agent/model-registry.json` 几乎 1:1 映射过去，**目录仍由我们的 JSON 生成**。

**但适配器强依赖 `ctx.credentials` 才能取到 key**，而出厂的 `dsh-credentials-local`
没有租户维度、且带热重载的设置文件（多租户下的配置漂移面）。
**因此必须自写一个最小凭据 provider**：只从服务端环境变量解析，不落盘、不热重载、
不进模型上下文。

冒烟已过（四个探针：流式、额外请求头、流式工具调用、`stream_options.usage`），
脚本在 `scripts/llmio-smoke.mjs`。**对生产网关重跑一次是上线准入项。**

### D7：租户隔离**不**建在 `ctx.scope` 上

`dsh-scope` 自己写明："Scopes route trusted same-process plugins; **they are not
sandboxes or authority boundaries.**" 因此 org/user 隔离继续完全由 `application/`
与 MySQL 仓储的显式 scope 谓词承担。`ctx.scope` 只用于**注册可见性**：每个 Run 一个
scope，承载该 Run 的工具视图、guard 与 skill 层。

### D8：A2A 换用官方 SDK（已由 ADR 0010 撤销）

`@a2a-js/sdk@1.1.0`。现有 12 个手写协议文件作废，只保留"把我们的 Run 事件翻译成
SDK 类型"的适配层。DSH 里没有任何 A2A 组件——这是另一个生态的 SDK。

> **2026-09-02 更新**：该条已由 [ADR 0010](0010-retain-custom-a2a-server-layer.md) **明确撤销**。
> 经实测判定（`docs/design/a2a-sdk-server.md`），`@a2a-js/sdk/server` 的 `ExecutionEventBus`
> 与 `resubscribe` 终态报错机制无法承载本仓库跨 Worker 异步执行与断线恢复语义，自建协议面完整保留。

### D9：追踪保留自建 span，另挂 OTel 导出

`dsh-session-telemetry-otel` 是把会话事件当**日志**发给 OTLP，不是 span 树。
直接替换会丢掉 `GET /runs/{id}/trace`。两者并存不冲突。

冒烟发现 usage 回传 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`——
**KV cache 命中率可观测**，这让下面 D10 的文档标准有了可量化依据。

### D10：采用 Model Experience 契约为内部文档标准

DSH 每个包的文档强制包含 `Model Experience`（模型看到什么 / token 影响 / **KV cache 影响**）
与 `Known Limitations and Deferred Work`。本 ADR 把它定为我们自己每个 provider、tool、
policy 的文档标准。

### D11：Sandbox 仍是唯一安全边界

[ADR 0001](0001-pi-coding-agent-sdk.md) 硬规则 1 继续生效。**不组合** DSH 的本机执行族：
`sandbox-local`、`sandbox-policy`、`bash-sandbox`、`pwsh-sandbox`、`fs-local`（Agent 侧）、
`fs-sandbox`、`subprocess-local`、`jobs-local`。

注意与 D3 的区别：**移除的是 provider，不是 tool。**
`dsh-sandbox` 自陈"策略围栏不是内核边界""只支持同机隔离，容器/微虚机/远程执行需要
替换实现而不是加一个 provider"——所以它替代不了我们的 Bubblewrap。

这条同时消解 ADR 0002 的两个阻塞项：`ctx.sandbox` 是同主机 argv 包装（我们不用），
出厂 bwrap profile 的 ephemeral `/tmp` 与 [ADR 0004](0004-session-persistent-tmp.md)
冲突（我们不用它的 profile）。**ADR 0004 无需任何修改。**

## 必须从出厂组合中移除的行

| 行 | 处理 | 理由 |
|---|---|---|
| `session-telemetry-otel` | **显式置 `DISABLED`** | 默认已是 DISABLED，但导出地址默认指向上游服务器；显式钉住并断言实际组合结果（"config cannot disable a row"） |
| `web`、`web-search-deepseek`、`tool-web` | 不组合 | 默认出网 |
| `credentials-local`、`settings` | 不组合 | 无租户维度；热重载设置是多租户下的配置漂移面。**用自建凭据 provider 顶上（D6）** |
| `session-persistence-jsonl`、`session-query-sqlite` | 不组合 | 由 MySQL 后端取代 |
| `sandbox-local`、`sandbox-policy`、`bash-sandbox`、`pwsh-sandbox`、`fs-local`、`fs-sandbox`、`subprocess-local`、`jobs-local` | 不组合 | D11 |
| `user-approval`、`permission-presets` | 不组合 | D4 |
| `hmr` | 不组合 | 生产不需要热重载 |

`tools.mode` 保持 **`native`**，不开 Code Mode：其 worker `maxOutputBytes` 默认 64 MiB，
中间绑定值 execution-local、无字节上限、**无法从会话重放重建**。Code Mode 需单独 ADR。

## 版本策略

- **每个 `@deepseek-ai/*` 包 exact pin**，不用 `^`/`~`，不依赖 dist-tag——子包的
  `latest` 至今仍指向两周前的 `0.0.1-rc.1`，而 CLI 依赖 `^0.1.1-rc.2`
- DSH 包**不声明 `engines`**：`runtime-versions.json` 新增 `dsh` 条目，Node 版本实测钉住
- **CI 断言**：`agent/`、`runtime/`、`exec/` 的直接依赖中不得出现 `@earendil-works/*`
- 需自备 `node-addon-require-builtin`（Loader 的可选 peer，`dsh-app-boot` 文档明确
  "external callers must supply it"）

## 残余风险

| 风险 | 状态 |
|---|---|
| `ctx.subagents` 原生 provider 契约写着"trusted **same-process**" | **未解**。我们的 durable provider 要落到 BullMQ 子 Run，可能对不上契约。Wave 4 实测；对不上就退回自建工具面，只丢工具层的模型体验 |
| `SESSION_FORMAT_VERSION = 0`，无迁移路径 | **大幅降级**（D5）：拒绝发生在我们自己的后端里，且有 `chunk-rows` 无损编解码器 |
| Issues 关闭、14 天 11 版本、自陈会有破坏性变更 | **未解**，靠 exact pin + 自有 compat 套件缓解 |
| 未经安全审计（SAFETY.md） | **未解**，靠 D11（Sandbox 才是安全边界）缓解 |
| 生产网关未冒烟 | **未解**，列为上线准入项（D6） |
| base bundle 单租户假设 | **部分缓解**：多数 `-local` 行已移除；残余是 `ctx.scope` 不是权限边界（D7），租户隔离仍由我们承担，与今天相同 |

## 验证要求

见[设计文档 §9](../design/dsh-rebuild.md)的 14 条。其中三条是本 ADR 的硬指标：

1. **SSE 契约逐字节不变**：`tests/fixtures/sse_events.json` 全量通过，
   `api-server/`、`frontend/` 零改动
2. **组合断言**：遥测、出网、凭据、本机 fs/shell/sandbox 各行**实际未挂载**——
   断言组合结果，不能断言配置意图
3. **本机文件系统不可达**：等价今天 `assertSandboxShadowedTools` 的 fail-closed 断言

## 影响

- [ADR 0001](0001-pi-coding-agent-sdk.md) → **Superseded**。硬规则 1（Sandbox 是安全边界）、
  硬规则 4（secrets 不下发浏览器）、exact pin 政策由本 ADR 继承
- [ADR 0002](0002-dsh-harness-evaluation.md) → **Superseded**，作为调研记录保留
- [ADR 0004](0004-session-persistent-tmp.md) → **不变**（D11）
- [ADR 0005](0005-pi-session-jsonl-persistence.md) → **Superseded**，六条决策由 D5 继承
- [ADR 0006](0006-user-skill-enablement-gate.md) → **不变**（D4）；其 P1 (A) 所需的挂载
  机制由 [ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md) 提供
- `api-server/`、`frontend/` **零改动**
- 需更新：`runtime-versions.json`、`tests/test_runtime_versions.py`、
  `docs/architecture.md`、`docs/module-layout.md`、`docs/STATUS.md`、
  [sdk-upgrade runbook](../runbooks/sdk-upgrade.md)

---

## 实施记录（2026-08-30）

实施过程中有三处偏离本 ADR 的原始描述，都记在这里而不是默默改掉。

### 1. `runtime/` 移到 `agent/runtime/`

本 ADR 与设计文档写的是顶层三包 `contract/` `runtime/` `exec/`。实施后
`runtime/` 只有 `agent/` 一个消费者，既不可独立部署也不被复用，放在顶层与
`agent/`/`exec/`/`api-server/` 平级是误导。已移到 `agent/runtime/`，依赖改成
`file:./runtime`。`contract/` 留在顶层——exec 与 runtime 都消费它。

### 2. MCP facade 一并迁入 `exec/`

[ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md) 原本把
`sandbox/mcp/`（1,192 行 Python）列为「本次不动」。但 exec 镜像是 `node:22-slim`，
里面没有 Python——"不动"实际等价于"删掉它"。已按 D1 一并用 TS 重写进
`exec/src/mcp/`，作为同一镜像的第二入口。`sandbox/` 整个删除。

窄桥（`/internal/mcp/v1/*`）在实施前 exec **一条都没有实现**，而 facade 一直在调，
所以 MCP 面在这段时间是完全断的。现已补齐，并比 Python 版多一道归属校验。

### 3. `tools.mode` 与残余风险的结论

- `ctx.subagents` 的「同进程」契约与我们的 durable BullMQ 子 Run **对不上**，
  按 ADR 预案退回自建工具面（`runtime/src/providers/durable-subagent.ts`）。
- 生产网关冒烟**仍未做**，依旧是上线准入项。

### 4. 阶段 F：`agent/runtime/` 并进 `agent/src/runtime/`（2026-08-31）

上面第 1 条把顶层 `runtime/` 收进 `agent/runtime/` 之后，agent 本身仍是 JS、
没有统一构建步骤，所以组合层只能当独立包存在。阶段 C–E 把 `agent/src/` 迁到
TypeScript 之后，这个异常按构造消失：独立 `@pi/runtime` 包没有了，源码在
`agent/src/runtime/`，与其余模块同一次 `tsc` 出 `dist/`。`tsconfig.runtime.json`
单独给这一棵子树开 `strict`，避免并入主树的宽松规则把联合收窄丢掉。

当前路径以这份记录为准；设计文档正文里的 `runtime/` 与 `agent/runtime/`
都读作 `agent/src/runtime/`。

### 遗留收口：`agent/src/application/dsh-run-executor.ts` 等文件名（2026-09-03）

原 `pi-run-executor.ts` 等 6 个 `pi-run-*` 文件及 `pi-session-journal-repository.ts` 已重命名为 `dsh-run-*` 与 `session-journal-repository.ts`，核心类名与方法规范为 `DshRunExecutor` / `createDshRunExecutorFactory`，测试目录由 `agent/tests/pi/` 规范迁移至 `agent/tests/executor/`。历史 `Pi*` 兼容别名已全量移除，全仓内部调用统一收口为 DSH 执行器与预算。
