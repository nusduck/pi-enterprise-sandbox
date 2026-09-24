# DSH 重建详细设计方案

| 字段 | 值 |
|---|---|
| 状态 | **已落地**（ADR 0007 / 0008 Accepted）。本文是设计原文，实施偏差见 ADR 文末与 [waves/HANDOFF.md](waves/HANDOFF.md) |
| 日期 | 2026-08-29（设计）；2026-08-31 注明实施结果 |
| 基线 | `main` @ `4dda7a9b` |
| 上游基线 | `@deepseek-ai/*@0.1.1-rc.2`（本次逐包下载核实，非二手转述） |
| 取代 | ADR 0001、0002、0005；重写 ADR 0007、0008 |

> **读本文时的路径对照：** D2 写的顶层三包 `runtime/` `exec/` `contract/`，实施后
> `runtime/` 先收到 `agent/runtime/`，再并进 `agent/src/runtime/`。当前只有
> `contract/` 与 `exec/` 是顶层包。Python `sandbox/` 已删除。

## 0. 决策摘要

| # | 决策 | 一句话理由 |
|---|---|---|
| D1 | 全栈统一 TypeScript，**执行面用 TS 重写，Python 版收敛后删除** | 让执行面能直接复用 `dsh-fs-local`，省掉在 Python 里重新实现文件版本与原子写 |
| D2 | 新开三个模块目录 `runtime/`、`exec/`、`contract/`，不在旧目录里改 | 研发阶段无历史包袱，并行开发不互相踩 |
| D3 | 能用 DSH 原生的一律用原生 | 团队方针；核实后可接手的比原计划多得多 |
| D4 | 隔离机制仍是 Bubblewrap，不用 DSH 的沙箱实现 | DSH 自陈"策略围栏不是内核边界""只支持同机隔离" |
| D5 | 会话持久化写一个 MySQL 后端，接 DSH 官方持久化接缝 | 这是上游正式扩展点，不是绕路 |
| D6 | A2A 换用 `@a2a-js/sdk`，只留适配层 | 12 个手写协议文件作废 |
| D7 | 追踪保留自建 span，另挂 DSH 的 OTel 导出 | DSH 那套是日志导出，不是 span，直接换会丢功能 |
| D8 | 记忆（memory）继续自建 | DSH 整个包树里没有记忆组件 |
| D9 | 内部认证保留 HMAC，去掉防重放 Redis | 内部网络不对外，一个独立 Redis 实例换不来相应收益 |
| D10 | 不分期，一次重构到位 | 决策所有者已定 |

---

## 1. 语言统一带来的最大变化

`dsh-fs-local` 是 `ctx.fs` 的本机实现，读它的源码和文档确认它**已经实现了**：

- 12 个基础操作全部
- **文件版本**：`dev:ino:size:mtimeNs:ctimeNs` 的不透明编码
- **原子写**：写进同目录下随机命名的私有暂存目录（`0o700`）里的独占临时文件（`wx`，`0o600`），fsync 后发布；保留已有文件的权限位
- **`createIfAbsent`**：硬链接发布，抢先创建者被保留
- **`editText`**：按目标加锁的读-改-写临界区，版本在字面匹配**之前**校验
- `FS_STALE_VERSION`、`FS_NOT_TEXT`、`FS_TOO_LARGE` 等结构化错误码
- `listDir` 的稳定排序、子目标与版本
- `streamText` 的跨块 UTF-8 解码

**这正是旧 ADR 0008 里工作量最大的三条决策**（决策 3 路径解析收敛、决策 4 文件版本、决策 5 内部接口重写）。执行面改成 TS 后，这些从"要写"变成"要包一层"。

它明确写出的两条限制，是我们要补的：

1. **`config.cwd` 不是沙箱** —— 绝对路径和 `..` 能逃出去，containment 要自己加。做法上游也给了：`dsh-fs-sandbox` 就是 `extends LocalFileSystem` 再加一层模式围栏，可写根从**同一个 `writableRoots` 函数**派生，这样文件围栏和命令执行不会跑偏。
2. **按目标的互斥锁只在进程内有效** —— 见下面 §5.4 的单写者设计。

---

## 2. 模块布局

```
pi-enterprise-sandbox/
  contract/          ← 新增。两侧共享的 TS 类型与 RPC 信封
  runtime/           ← 新增。Agent 侧的 DSH 组合层与 provider
  exec/              ← 新增。执行面（TS），取代 sandbox/
  agent/             ← 保留 domain/application/infrastructure/presentation，删掉 pi/ 与 extensions/
  api-server/        ← 零改动
  frontend/          ← 零改动
  sandbox/           ← 收敛后整个删除
```

### 为什么单独开 `contract/`

两侧都是 TS 之后，Agent 和执行面之间的接口**不需要手写 DTO**——直接复用 `@deepseek-ai/dsh-fs` 和 `dsh-shell` 的类型定义，加一层 RPC 信封即可。`contract/` 存放：

- RPC 信封（请求 id、租户上下文、fence token、错误码映射）
- HMAC 签名与校验（两侧共用一份实现）
- 我们自己的错误码枚举

这一条直接消掉旧方案里"Python 服务端和 JS 客户端怎么保证契约同批"的问题——**类型系统就是契约**，编译不过就发不出去。

### `runtime/` 目录树

```
runtime/
  package.json                 @pi/runtime
  bundle/
    cordis.patch.yml           我们的组合层（叠在 dsh-base 之上）
  src/
    boot.ts                    组合根，取代 pi-runtime-factory.js
    providers/
      remote-fs.ts             ctx.fs     → exec RPC
      remote-shell.ts          ctx.shell  → exec RPC
      remote-jobs.ts           ctx.jobs   → exec RPC
      mysql-session-store.ts   ctx.sessionPersistence 的 MySQL 后端
      durable-subagent.ts      ctx.subagents provider（落到既有 BullMQ 子 Run）
      enabled-skills.ts        ctx.skills provider（ADR 0006 启用集）
      llmio-adapter.ts         ctx.llm 适配器（仅在网关非 OpenAI 兼容时需要）
      memory.ts                memory_write / memory_search（DSH 无原生）
    policy/
      pre-execute.ts           风险表 + 参数守卫 + source_digest + 持久审批
      guards.ts                ctx.tools.guard() 单调兜底
      run-budget.ts            tools/execute 环绕包装：每 Run 工具/轮次/deadline
      post-execute.ts          脱敏 + 账本
    projection/
      run-event.ts             session/event → 平台 Run Event
      sse.ts                   → SSE（契约逐字节不变）
    prompt/
      enterprise-clauses.ts    不可覆盖的企业条款
```

### `exec/` 目录树

```
exec/
  package.json                 @pi/exec
  src/
    main.ts                    HTTP 入口
    http/
      internal-fs.ts           12 primitive 一一对应的内部端点
      internal-shell.ts        run / start
      internal-jobs.ts         status / read / kill / signal / stdin
      internal-artifact.ts     submit / download
      internal-session.ts      ensure
      public/                  给 BFF 的公共面（upload / download / preview / dataset）
    fs/
      workspace-fs.ts          extends LocalFileSystem，加多租户围栏
      writable-roots.ts        **可写根的单一事实源**
      redact.ts                物理路径脱敏
    shell/
      executor.ts              ctx.shell 实现，spawn 前一律过 isolation
      job-registry.ts          MySQL 支撑的作业登记（重启后仍在）
    isolation/
      profile.ts               NamespacePlan / MountPlan / EnvPlan / LaunchPlan
      render.ts                **唯一**把 profile 变成 bwrap argv 的函数
      bubblewrap.ts            runner
      preflight.ts             渲染同一个 profile
    workspace/
      manager.ts  paths.ts  quota.ts
    artifact/  dataset/  attachment/
    security/
      hmac.ts  cidr.ts  ownership.ts
    db/
      client.ts  repositories/
```

---

## 3. 进程与边界模型

```
浏览器 → frontend(nginx) → api-server(BFF) → agent(HTTP) ──┐
                                                            ├→ exec(HTTP)
                                              agent(worker) ┘        │
                                                                     ↓
                                                          bubblewrap 子进程
```

**安全边界只有一条：exec 服务里的 Bubblewrap。** 这条从 ADR 0001 继承，不变。

`runtime/` 里的 `ctx.fs` / `ctx.shell` 是 **RPC 代理**：本机不做任何文件与进程操作，全部转发给 exec。DSH 的接缝本来就是为远程执行世界设计的（`resolve()` 是异步的，理由原文是"远程后端可能需要 I/O"；上游已有 E2B 远程沙箱作为一等实现）。

---

## 4. Agent 侧设计（`runtime/`）

### 4.1 DSH 原生接手清单

核实后确认可以直接用、把我们的自建版本删掉的：

| 能力 | DSH 包 | 删掉我们的 |
|---|---|---|
| 文件工具（read/write/edit） | `dsh-tool-fs` + `dsh-fs-observation-policy` | `extensions/sandbox-bridge/tools/` |
| 文件搜索 | `dsh-tool-fs-search` | 同上 |
| 命令工具 | `dsh-tool-bash` | 同上 |
| 后台作业工具 | `dsh-tool-jobs` | `process_*` 四个工具的模型面 |
| 上下文压缩 | `dsh-compaction` + `-basic` + `-tool-result-pruner` + `dsh-token-meter` | `application/context-policy-service.js` |
| 待办 | `dsh-tool-todo` | `extensions/task-state` 的 todo 一半 |
| 向用户提问 | `dsh-tool-ask-user` + `dsh-user-questions` | `extensions/user-interaction` |
| 会话标题 | `dsh-session-title` + `-first-prompt-llm` | `application/conversation-title.js` |
| 子 Agent 工具面 | `dsh-tool-subagent` / `-control` / `-report` | `extensions/subagent-spawn` 的工具层 |
| Skill 工具面与目录 | `dsh-tool-skill` + `dsh-skill` | `extensions/skill-lifecycle` 的工具层 |
| 大结果溢出 | `dsh-spill` + `-local` + `-policy` | 自写的截断逻辑 |
| 工具超时 | `dsh-tool-call-timeout-policy` | 预算逻辑的一部分 |
| 重复调用提醒 | `dsh-repeat-tool-reminder` | 自写的重复调用守卫 |
| LLM 抽象与重试 | `dsh-llm` + `-retry` + `-deepseek` | `infrastructure/model-registry.js`、`provider-gate.js` |
| 工具管线 | `dsh-tools` | `extensions/index.js` 注册表（669 行） |
| 系统提示词骨架 | `dsh-system-prompt` + `dsh-agent-instructions` | `enterprise-system-prompt.js` 的骨架部分 |

### 4.2 必须自建的清单

| 能力 | 为什么不能用原生 |
|---|---|
| `ctx.fs` / `ctx.shell` / `ctx.jobs` 的 provider | 我们的执行世界在另一个容器里 |
| `ctx.sessionPersistence` 的 MySQL 后端 | 原生只有 JSONL 与 SQLite，都不满足多租户账本 |
| `ctx.subagents` 的 durable provider | 原生 provider 是**同进程**的；我们的子 Run 要能跨 Worker 重启存活 |
| `ctx.skills` 的启用集 provider | 多租户 + ADR 0006 的启用闸门 |
| 企业策略（风险表/审批/审计） | 原生审批不携带工具参数，与我们的 `source_digest` 互斥 |
| 每 Run 预算 | 原生只有单次工具超时，没有 Run 级预算 |
| **memory** | DSH 无此组件 |
| **凭据 provider** | 原生 `dsh-credentials-local` 无租户维度且热重载设置文件；但 LLM 适配器强依赖 `ctx.credentials`，必须自写一个只读环境变量的最小实现（见 §4.5） |
| 平台事件投影 → SSE | 我们自己的对外契约 |
| 追踪 span | DSH 那套是日志导出，不是 span 树 |

### 4.3 策略挂载点

| 挂载点 | 承载 | 关键性质 |
|---|---|---|
| `tools/pre-execute` | 风险表、参数守卫、`source_digest`、持久 PENDING 审批 | 可读参数（原生审批不行）；**不能改写参数**，这是上游明确的限制，我们也不需要改写 |
| `ctx.tools.guard()` | 租户与 fence 的单调兜底 | 返回拒绝后**后续监听器无法翻案** |
| `tools/execute`（环绕包装） | 每 Run 工具数、轮次、deadline | 这是该接缝的声明用途 |
| `tools/post-execute` | 脱敏、账本、上下文附加 | — |

**不组合 `dsh-user-approval`、`dsh-permission-presets`、`dsh-sandbox-policy`。** 两套审批并存只会制造绕过路径。ADR 0006 的设计一行不改。

### 4.4 会话持久化（吸收原 ADR 0005）

DSH 的持久化接缝 `SessionPersistence` 需要一个后端，接口是明确的 8 个方法：

| 方法 | 我们的 MySQL 实现 |
|---|---|
| `name` | 常量 |
| `loadStored(id, signal?)` | 按 `agent_session_id` 读事件前缀 |
| `readStoredRevision(id, signal?)` | 读一行元数据，不读事件 |
| `loadStoredFrom?(id, fromSeq, signal?)` | `WHERE seq >= ?`，**这是增量恢复的关键**，SQLite 后端已有先例 |
| `appendBatch(meta, events, isMaterialized)` | 事务内追加，首事件 seq 必须等于存储的 next-seq |
| `commitRepair(meta, tornMarker, closers)` | 崩溃修复：截断残尾 + 追加闭合事件 |
| `list(signal?)` | 元数据列表 |
| `close?()` | 连接池关闭 |

**原 ADR 0005 的六条决策全部继承，只换绑定对象：**

1. **日志文件是适配器格式，不是在线事实源** —— DSH 的 `.jsonl.zstd` 只用于导出与冷归档；在线权威是 MySQL。
2. **引擎原生事件拆到独立物理表** —— 原 ADR 0005 决策 2。现在消息和引擎日志挤在同一张 `messages` 表里（靠 `pi_entry_id` 是否为空区分），宽 JSON 行会干扰普通会话查询。新设计：`messages` 只留用户可见消息，引擎事件进 `session_events`（1:1 扩展表，带 `seq` 主序）。
3. **快照按阈值触发，不是每 Run 全量复制** —— 避免累计写放大近似二次增长。
4. **容量限制写入前统一判定** —— 一个入口，不再是 JSONL 8 MiB 与图片准入两套阈值互相矛盾。
5. **一致性、租户与错误语义不变** —— 所有查询直接带 `org_id + user_id + agent_session_id`。
6. **冷归档与导出不在在线提交事务里。**

**新增一条**：上游的 `chunk-rows` 存储编解码器能"无损把事件序列转成紧凑行再转回来，且原样保留不认识的事件"。**直接用它**，我们只负责把行落进 MySQL。原 ADR 0007 担心的"上游格式变更让历史会话不可恢复"因此大幅缓解——而且版本拒绝逻辑发生在**后端层**，后端是我们写的，兼容策略由我们掌握。

> 研发阶段，**无历史数据迁移**。现有 Pi 会话数据直接丢弃，不写转换器。

### 4.5 LLM 接入

`dsh-llm` 是完整抽象层，两个现成适配器。base bundle 里 DeepSeek 适配器的 key 和 endpoint **都是按请求从设置里解析的，不写死**。

**核实结论（2026-08-29，读 `dsh-llm-deepseek@0.1.1-rc.2` 文档）：不需要写适配器。**

| 事实 | 依据 |
|---|---|
| 适配器接受自定义 `baseURL` | 配置项 `baseURL`，"optional; `$DEEPSEEK_BASE_URL` then the public API when omitted" |
| 我们的网关是 OpenAI 兼容 | `config/agent/model-registry.json` 每条都是 `"api_protocol": "openai-completions"`；`.env.example:26` 的 `LLMIO_BASE_URL` 形如 `.../openai/v1` |
| 模型 id 就是 deepseek 系列 | `deepseek-v4-flash` / `deepseek-v4-pro` |
| 密钥不写进配置 | 配置只放 `apiKeyEnv` 引用，实际值经 `ctx.credentials` 按请求解析 |

所以接入 = **配置 `baseURL` + `apiKeyEnv`**，`MODEL_ID` 映射成 `provider: deepseek-official` + `model`。

### 由此暴露的一个洞：凭据 provider 必须自建

适配器**要求** `ctx.credentials` 存在才能取到 key。而 base bundle 里那一行是 `dsh-credentials-local`，我们不能用它——它没有租户维度，且带热重载的设置文件，在多租户下是配置漂移面。

**因此必须自写一个最小凭据 provider**：只从服务端环境变量解析，不落盘、不热重载、不进模型上下文。这一条原方案漏了，现补进 §4.2 的自建清单。

### Wave 0 冒烟结果（2026-08-29 实跑，四个探针）

| 探针 | 结果 |
|---|---|
| 纯净头 + 流式文本 | ✓ 1407ms / 17 帧 / finish=stop |
| **加上 `x-deepseek-harness-user-id` 与 harness `User-Agent`** | ✓ 1118ms / 29 帧，**额外头被接受** |
| **归属头 + 流式工具调用** | ✓ 765ms / 30 帧 / **10 个工具增量** / finish=tool_calls |
| `stream_options.include_usage` | ✓ 回传 usage |

**门槛通过。** 而且 usage 里带 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`——KV cache 命中率是可观测的，这让本方案采纳的 Model Experience 文档标准（每个改动都要回答"会不会打断 KV cache 复用"）有了可量化依据。

### 拓扑已确认：自有网关，DeepSeek 协议一致，会有额外模型

决策所有者确认（2026-08-29）：生产是**自有网关**，协议与 DeepSeek 官方一致，但会承载别的模型。

**结论：仍然不需要写适配器。** `dsh-llm-deepseek` 的配置里有一个可配的模型目录，官方示例原文就包含一个自建模型的例子：

```yaml
config:
  baseURL: https://<我们的网关>/…      # 指向自有网关
  apiKeyEnv: LLMIO_API_KEY            # 只放引用，不放字面值
  defaultContextWindow: 262144        # 未列出模型的兜底
  models:
    - id: deepseek-v4-flash
      name: DeepSeek V4 Flash
    - id: deepseek-v4-pro
      name: DeepSeek V4 Pro
    - id: private-reasoner            # ← 官方示例里就有这一条
      description: Company-hosted reasoning model
      contextWindow: 512000
```

`config/agent/model-registry.json` 的字段几乎 1:1 映射过去：`model_id → id`、`name → name`、`context_window → contextWindow`、`input_modalities → inputModalities`。**目录仍由我们的 JSON 生成**，保持单一事实源。

两个要记下的注意点：

1. **路由名固定叫 `deepseek-official`**，这是包自己占的名字。会话日志和 UI 里会显示这个 provider 名，即使它指向的是我们自己的网关——**命名有点别扭但无害**，不值得为它写适配器。
2. **将来若网关接入非 DeepSeek 方言的模型**（比如原生 Anthropic 或 Gemini 端点），再加一个适配器即可：`ctx.llm.registerAdapter(providers, adapter)` 支持多个适配器占不同路由，**这是加法，不是重新设计**。

### ⚠️ 冒烟覆盖范围的边界

本次冒烟跑的是 `.env` 里配的地址，实际值是 `https://api.deepseek.com`（**开发环境直连官方**，`.env.example` 里描述的"OpenAI 兼容网关"是生产形态）。

**因此本次冒烟没有覆盖生产网关。** 上线前必须对着它重跑同一个脚本，重点看三件事：

1. 是否剥离未知请求头（`x-deepseek-harness-user-id`、harness `User-Agent`）
2. 是否支持 `stream_options.include_usage`
3. 额外模型是否也回传 `prompt_cache_hit_tokens`（影响 KV cache 可观测性）

> 脚本在 `scripts/llmio-smoke.mjs`，改 `LLMIO_BASE_URL` 直接重跑。这条列为**上线准入项**。

---

## 5. 执行面设计（`exec/`）

### 5.1 文件系统：包一层，不重写

```ts
class WorkspaceFileSystem extends LocalFileSystem {
  // 继承：12 primitive、版本、原子写、编辑临界区、错误码
  // 覆盖：resolve 的租户根解析 + 每次写入前的 containment 复查
}
```

围栏规则：

- 可写根**只从 `writableRoots(ctx)` 一个函数派生**，文件围栏和命令执行共用，两边不会跑偏（这条纪律直接抄上游）
- 可写根 = 当前会话的 workspace 根 + 当前会话私有 `/tmp`
- Skill 树全部只读
- 拒绝规则逐条保留：`..`、`~` 展开、盘符、其它绝对根、软链接解析后的越界检查
- 错误文本一律经 `redact()`，物理根显示成 `<workspace>`

**不消除 TOCTOU**（与上游同一判断），但"写入前紧邻再规范化一次"是必须动作。

### 5.2 隔离层：建模成数据

保留 Bubblewrap 的全部安全性质（user/pid/ipc/uts 命名空间、私有 procfs、`cap-drop ALL`、`setpriv` 剥离、netns fail-closed、in-namespace nproc），只改表达方式：

```
IsolationProfile
├── NamespacePlan  namespaces / uid,gid / as_pid_1 / die_with_parent / cap_drop
├── MountPlan      有序 Mount[]：kind ∈ {ro_bind, bind, dir, proc, dev, tmpfs}
│                  required=true  → 源缺失即失败
│                  required=false → 仅 ENOENT 可恕
├── EnvPlan        clearenv + 键值
└── LaunchPlan     argv / cwd / nproc 包装
```

`render(profile) → argv` 是**唯一**产出 bwrap 参数的函数。由此得到：

- **`preflight()` 渲染同一个 profile**，只替换 argv 为探针命令。今天两份列表悄悄分叉的问题**由构造消除**
- 测试直接对 `MountPlan` 断言，不再字符串匹配 argv
- `required` 的语义进类型，不再靠注释

**采用 DSH 的模式词汇**：`read-only` / `workspace-write` / `danger-full-access`。**不采用它的实现**——`dsh-sandbox-local` 是单用户、同世界，我们要多租户绑定 + 断网 fail-closed。

### 5.3 Skill 绑定：启用集的函数

```
for pkg of enabledPackages(org, user):
    mountPlan.add(ro_bind, userSkillsRoot/org/user/pkg, `${AGENT_USER_SKILL_PATH}/${pkg}`, required=false)
```

未启用的包**根本不在挂载里**——ADR 0006 P1 的"启用必须控制绑定"由构造成立。

保留今天那条来之不易的健壮性：**单个包挂载失败不得让整个 bwrap 起不来**，否则一个坏包会让用户连 `pwd` 都用不了。

ADR 0006 P1 落地前，启用集的实参先传"该用户已安装的全部包"，行为与今天等价。

### 5.4 单写者：解决进程内锁的边界

`dsh-fs-local` 明说"按目标的互斥锁只在进程内有效"。生产上 exec 服务可能多进程（现在 Python 版就有 `SANDBOX_UVICORN_WORKERS`）。

**决策：前期单实例部署，但把多实例扩展点预留出来。**

- exec 服务**单进程** + `worker_threads` 处理 CPU 密集项，**不开多进程 HTTP worker**（禁止 `UVICORN_WORKERS` 那类配置重现）
- 进程内按目标加锁因此完整有效，`dsh-fs-local` 的机制原样成立
- 跨实例的兜底本来就在：`createIfAbsent` 用硬链接发布，`replaceIfVersion` 靠版本守卫——这两条不依赖进程内锁

**预留的扩展点**（现在就要写进代码，不是以后再说）：

1. 所有内部端点的请求信封**必带 `workspace_id`**，路由层可以据此做一致性哈希，不用改接口
2. 加锁抽象成 `WorkspaceLock` 接口，进程内实现是默认；将来换成 MySQL 咨询锁或 Redis 锁只换实现
3. 启动时断言 `execConcurrency === 1`，**多实例部署必须显式开开关**，防止有人悄悄加副本导致静默丢写

**验收**：单实例下测并发编辑不丢写；同时断言"进程数 > 1 时启动失败"。

### 5.5 作业（长进程）管理

`dsh-jobs-local` 全部记录在内存里，重启即丢——不满足我们"Worker 重启后仍能查到进程"的要求。

**自建 `MySqlJobRegistry`**，实现 `dsh-jobs` 的登记契约，记录落 MySQL。保留今天已有且正确的部分：

- 增量读游标（连续读不重复返回，丢数据时标记）——形状与上游 `ShellProcess.readOutput()` 完全一致
- 孤儿进程检测与清理
- 归属校验（只有起进程的租户能操作）
- stdin 写入、信号发送

### 5.6 内部接口

因为两侧都是 TS，端点与 `ctx.fs` 的 12 个方法**一一对应**，请求/响应类型直接来自 `contract/`：

```
POST /internal/v1/fs/{resolve,stat,lstat,list,read-text,read-bytes,write-text,edit-text}
GET  /internal/v1/fs/stream-text
POST /internal/v1/shell/{run,start}
POST /internal/v1/jobs/{status,read,kill,signal,stdin}
POST /internal/v1/artifacts/{submit,download}
POST /internal/v1/sessions/ensure
```

`files/find`、`files/grep` 继续单独存在，服务 `dsh-tool-fs-search`（搜索面返回命中，接缝面返回子目标与版本，两者形状不同）。

**认证简化**（D9）：保留 HMAC 签名 + 请求体摘要；**去掉防重放 jti 与它专用的 Redis 实例**。内部网络不对外，入站 CIDR 白名单保留。

### 5.7 公共面

`upload` / `download` / `preview` / dataset / 会话进程 —— **对 BFF 的契约逐字节不变**，只是实现语言换了。这是 `api-server/` 与 `frontend/` 零改动的依据。

---

## 6. 数据库

- Agent 的 Knex 迁移**继续是唯一 schema 权威**
- exec 侧用同一个 MySQL，**只写自己的表**（workspace、execution、process、dataset、artifact、audit）
- 新增：`session_events`（引擎事件，替代挤在 `messages` 里的做法）
- 删除：`messages.pi_entry_id` / `pi_entry_kind` 两列，`agent_session_snapshots.snapshot_format` / `pi_sdk_version` 换成引擎无关的字段
- 研发阶段可以**重置数据库**，不写数据迁移

---

## 7. 删除清单

| 删除 | 行数 |
|---|---|
| `agent/src/infrastructure/pi/` 全目录 | 3,315 |
| `agent/src/extensions/` 全目录（策略逻辑搬到 `runtime/policy/`） | ~3,900 |
| `agent/src/application/pi-run-*.js`、`context-policy-service.js`、`conversation-title.js` | ~600 |
| `agent/src/application/a2a/` 手写协议（换 SDK，保留适配层） | ~2,000 |
| `sandbox/` 整个 Python 包 | 35,958 |
| `agent/tests/sdk-compat/`、`agent/tests/pi/` | — |

新增 TS 约 12,000–15,000 行（`exec/` 大头）。**净减少两万行以上，且换来上游工具层的模型体验。**

---

## 8. 执行计划与分工

我负责主控与评审，实现由 subagent 承担。波次内的任务可并行，跨波次有依赖。

### Wave 0 — 地基（我做）
- 重写 ADR 0007 / 0008，ADR 0005 转 Superseded
- 建三个包的骨架、tsconfig、构建与测试脚手架
- **LLMIO 接入实测**：DeepSeek 适配器配 baseURL 能不能直连我们的网关

### Wave 1 — 契约与文件面
| 任务 | 产出 |
|---|---|
| W1-A | `contract/`：RPC 信封、HMAC、错误码 |
| W1-B | `exec/src/fs/`：`WorkspaceFileSystem` + `writableRoots` + `redact` |
| W1-C | `exec/src/isolation/`：Profile 模型 + `render()` + `preflight()` 同源 |

### Wave 2 — 执行与作业
| 任务 | 产出 |
|---|---|
| W2-A | `exec/src/shell/executor.ts`：spawn 前一律过 isolation |
| W2-B | `exec/src/shell/job-registry.ts`：MySQL 支撑，含游标/孤儿/归属 |
| W2-C | `exec/src/workspace/`：管理、配额、路径 |

### Wave 3 — 执行面其余
| 任务 | 产出 |
|---|---|
| W3-A | `exec/src/http/internal-*`：内部端点 + HMAC 中间件 |
| W3-B | `exec/src/artifact/` + `dataset/` + `attachment/` |
| W3-C | `exec/src/http/public/`：公共面，**对 BFF 契约逐字节不变** |
| W3-D | `exec/src/db/`：仓储层 |

### Wave 4 — Agent 侧 provider
| 任务 | 产出 |
|---|---|
| W4-A | `runtime/providers/remote-{fs,shell,jobs}.ts` |
| W4-B | `runtime/providers/mysql-session-store.ts`（8 个方法） |
| W4-C | `runtime/providers/{durable-subagent,enabled-skills,memory}.ts` |
| W4-D | `runtime/boot.ts` + `bundle/cordis.patch.yml` 组合层 |

### Wave 5 — 策略与投影
| 任务 | 产出 |
|---|---|
| W5-A | `runtime/policy/`：四个挂载点 |
| W5-B | `runtime/projection/`：**SSE 契约逐字节不变** |
| W5-C | `runtime/prompt/enterprise-clauses.ts` |

### Wave 6 — 接线与收敛
| 任务 | 产出 |
|---|---|
| W6-A | `agent/` 接线；删除 `infrastructure/pi/` 与 `extensions/` |
| W6-B | A2A 换 `@a2a-js/sdk` + 适配层 |
| W6-C | 追踪：保留 span，挂 OTel 导出 |
| W6-D | 删除 `sandbox/`；文档与 `runtime-versions.json` 同步 |

---

## 9. 验收标准

1. **模型能跑通**（Wave 0 就要有结论）
2. **SSE 契约逐字节不变**：`tests/fixtures/sse_events.json` 全量通过，`api-server/`、`frontend/` 零改动
3. **`ctx.fs` 契约测试**：含同一文件经相对路径/绝对路径/含 `.` 拼写/软链接抵达必须产出同一 `targetKey`
4. **版本守卫**：`createIfAbsent` 竞态下抢先创建者被保留；版本不匹配返回 `FS_STALE_VERSION`；`editText` 在字面匹配**之前**校验版本
5. **并发编辑必须在多实例下测**（§5.4）
6. **plan 断言**：可写挂载恰为 `writableRoots()` 的结果；skill 层全部只读；`/tmp` 恰好绑定当前会话
7. **preflight 同源**：断言与 `prepare` 渲染自同一 profile
8. **组合断言**：遥测、出网、凭据、本机 fs/shell/sandbox 各行**实际未挂载**（断言结果，不是断言配置）
9. **本机文件系统不可达**：等价今天 `assertSandboxShadowedTools` 的 fail-closed 断言
10. **审批链路**：拦截 → 风险表 → 持久 PENDING → `WAITING_APPROVAL` → 恢复重放，含 `source_digest` 不匹配的拒绝
11. **租户隔离**：跨租户 404
12. **恢复**：Worker 崩溃重启后从 MySQL 重建会话
13. **依赖断言**：`agent/`、`runtime/`、`exec/` 的直接依赖中不得出现 `@earendil-works/*`
14. **真实链路**（AGENTS.md §4）：重建镜像后 登录 → 建会话 → 带工具 Run → Worker 重启恢复 → 进程日志/信号 → 跨租户 404

---

## 10. 风险

| 风险 | 状态 |
|---|---|
| LLMIO 网关与 DSH 适配器协议不匹配 | **Wave 0 先验**，不匹配就写适配器（只需实现 `stream()`） |
| `ctx.subagents` 原生 provider 契约写着"同进程"，我们的 durable provider 可能对不上 | **Wave 4 要实测**；对不上就退回自建工具面，只丢工具层的模型体验 |
| 执行面 TS 重写 36k 行 Python 的等价性 | 逐 Wave 用现有 pytest 用例改写成 TS 用例做对照；隔离与路径安全的用例**一条不减** |
| 上游 14 天 11 个版本、issues 关闭 | 逐包 exact pin，不用 `^`/`~`，不依赖 dist-tag（子包的 `latest` 至今仍指向两周前的 rc） |
| Bubblewrap 在 Node 侧的进程组与信号语义 | Wave 2 单独验；Python 版的 `setpriv`/nproc 包装要逐条对照 |
| 无回退目标 | 研发阶段，决策所有者已确认：不考虑回退 |

---

## 11. 已确认事项

1. **部署形态：前期单实例**，多实例扩展点按 §5.4 预留。
2. **MCP 门面**（`sandbox/mcp/`，1,192 行）：本次不动，Wave 6 之后单独补齐。
3. **`sandbox/skill-runtime/`** 已查清：不是空目录，是三个 **shell 启动垫片**（`baoyu-chromium`、`baoyu-format-markdown`、`baoyu-markdown-to-html`，提交于 `c4923703`）。它们存在的原因是 Bubblewrap 子进程只暴露一个很小的 `/etc` 白名单，而 Chromium 的 Debian 启动器要读 `/etc/chromium.d/*`，所以绕开发行版启动器直接调二进制。

   **这是运行时资产，不是代码**——TS 重写时原样保留，跟着 `exec/` 的镜像走。Dockerfile 里对应的安装步骤也要一并迁移。
