# ADR 0009: 出厂工具挂 host；application 做 DSH 管家

| 字段 | 值 |
|---|---|
| 状态 | **Accepted**（2026-08-31 决策锁定；**实施未开始**） |
| 日期 | 2026-08-31 |
| 决策所有者 | Agent runtime maintainers |
| 适用范围 | `agent/` 的 DSH 组合层与 `application/` 对循环的接线；不改 `exec/` 隔离技术、不改 frontend/BFF 契约 |
| 关联决策 | [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)（本 ADR 收窄其组合方式，并改写 D4 中「不组合 `dsh-user-approval`」）、[ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md)（不变）、[ADR 0006](0006-user-skill-enablement-gate.md)（P1 仍待实施；本 ADR 不把它改成「启用闸门」） |
| 上游参照 | 官方 `npx @deepseek-ai/dsh web`（`dsh-base` → `dsh-web-app` → `dsh-agent-presets`）；本仓库 **不采用** 后两层包 |

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
官方 TUI 就是把 `tool-bash` 等放在 host 上。本产品默认所有 Run 看见同一套企业工具，
因此走 host，不走 preset。

另有一条与 0007 相反的产品决定：可以用 `dsh-user-approval`，即使它不携带工具参数。

## 决策

### D1：网页不进 ctx，不采用 `dsh-web-app`

浏览器边界仍是 `frontend → BFF → Agent`。SSE 契约不变。不把官方 `ui-*` /
`dsh-client-connection` 叠进 Agent 进程，也不让浏览器打到 Agent 的 HTTP。

学官方 web 的 **只有组合方式**（空 ctx → base → overlay），不学它把 UI 和循环放进
同一个进程。

### D2：组合是 `dsh-base` + 一份 overlay；overlay 是整棵树的 patch

```text
空 ctx
  ├─ ① @deepseek-ai/dsh-base
  ├─ ② agent/src/runtime overlay（manifest.ts → cordis.patch.yml）
  └─ 网页不进 ctx
```

Overlay 按 `id` 覆盖或插入，不是「给 `tool-bash` 打补丁」。它对 base 做四类事：
改 config（LLMIO）、关掉本机执行族与 jsonl、替换凭据 / 子 Agent provider、插入
`remote-fs` / `remote-shell` / `remote-jobs`。`tool-bash` 仍是出厂插件，只是
`ctx.shell` 换成 RPC。

事实源仍是 `agent/src/runtime/plugins/manifest.ts`，YAML 由 `npm run gen:patch` 生成。

### D3：出厂工具挂在 host（bundle / overlay），默认不用 per-Run preset

`dsh-base` 已包含 `tool-fs`、`tool-fs-search`、`tool-bash`、`tool-jobs`、
`tool-todo`、`tool-skill`、`tool-subagent`、`user-questions` / ask-user。
本产品默认 **所有 Run 同一套工具**，因此它们留在 host，与官方 TUI、与
`dsh plugin add` 加包的方式相同。

**Preset 不是加插件的通则。** 仅当产品需要「这个 AgentVersion 的工具清单与那个不同」
时再引入 `dsh-agent-presets` 或等价的按 Run 过滤。当前不引入第 ③ 层。

每 Run 的工作区 / 租户隔离不靠 preset：由 remote provider + 现有的按 Run RPC
上下文（`runWithExecRpc` 一类）承担。tool 插件是单例，问到的 `ctx.fs/shell/jobs`
必须是这次 Run 的租户。并发 Run 不得靠「`rebind` 根 ctx 上的同一份 provider」——
那会串台。

### D4：旧 Pi Extension 的模型面用 dsh-base 顶掉

| 旧 Extension | 用 dsh-base 的 | application 还留什么 |
|---|---|---|
| `sandbox-bridge` | `tool-fs` / `tool-fs-search` / `tool-bash` / `tool-jobs` | 无（字节在 exec） |
| `task-state` 的 todo | `tool-todo` | 不再当模型 tool；`task_todos` 可停用。前端若还没有独立 todo 页，本阶段不投影 |
| `user-interaction` | `user-questions` / ask-user | `WAITING_INPUT` 停泊 + 现有应答 API，把答案喂回 DSH |
| `skill-lifecycle` 的工具层 | `tool-skill` + skill 目录 | 见 D6：安装/编辑/卸载仍是人在 UI 上操作，不是模型 tool |
| `subagent-spawn` 的工具层 | `tool-subagent` | durable `ctx.subagents` 接到 `SubagentSpawnService`（MySQL + 队列） |
| `enterprise-policy` 的「问人」 | `dsh-user-approval`（D5） | 停泊 `WAITING_APPROVAL` + 现有审批中心 API |

`application/` **不再 `registerTool`。**

### D5：组合 `dsh-user-approval`；审批记录可以不带工具参数

**改写 [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) D4 的「不组合
`dsh-user-approval`」。** 问人走原生审批。overlay 打开 `approval`（及为它服务的
`permission`，若原生审批依赖它）。

原生审批不携带 arguments / `source_digest`。产品接受这一点：审批中心可以只展示
「某次 tool call 要不要过」。

**执行时仍核 `source_digest`（及租户 / fence）。** 那是 `tools/pre-execute` /
`ctx.tools.guard()`，不是审批 UI。人点同意之后、真正落地之前，digest 对不上必须拒绝。
否则「批准后再掉包 zip」回得来。

Worker **不得**堵在 `whenIdle()` 里等人。听到 DSH pending → 把企业 Run 写成
`WAITING_APPROVAL` 并释放 Worker；现有 `approval-decision-service` 把浏览器的
decide 转成 resolve 那次 DSH ask，再入队续跑。审批中心的 HTTP 形状尽量不变。

`dsh-permission-presets` 与 `dsh-sandbox-policy` **仍然不组合**（隔离权威是
Bubblewrap / exec，不是 DSH 本机围栏）。

### D6：`skill_install` 等变更工具本阶段不提供给模型

DSH 的 skill 是目录发现与调用，没有「上传 ZIP / digest / 审批后写入租户根」。
本阶段模型只用 `tool-skill` 使用已存在的包。安装、编辑、卸载留在
`skills/manager` 与现有 Capabilities HTTP，由人操作。不把 Pi 的
`skill_install` / `skill_edit` / `skill_create` / `skill_uninstall` 再注册进 DSH。

[ADR 0006](0006-user-skill-enablement-gate.md) 的 P1（闸门移到启用）仍是未实施的
后续，本 ADR 不提前做。

### D7：不做 memory

`memory_write` / `memory_search` 本阶段不做。DSH 无此组件；
`runtime/providers/memory.ts` 不挂到循环上。

### D8：`application/` 是管家，不是工具面

留下：Run 队列与 lease、session lock / fence、取消与恢复、Conversation / Message /
RunEvent → BFF SSE、跨租户 404、A2A、trace 查询。

改接线：executor 听 DSH `session/event` 与审批/提问 pending，负责停泊与续跑；
diagnostics 投影 DSH tool 注册表，不再投影空的 Extension 名单；
`getAllTools()` 不再把 `fs/shell/jobs` 三个 provider 当成工具列表。

删或停用生产路径上的：`extensionBundleFactory`、无人调用的
`createTaskStateStore` / 未接线的 spawn 工厂（spawn 接到 durable provider 之后，
死装配删掉）。自建 compaction / 单次 tool 超时 / 会话标题，能交给 base 的就关。

`PiRunExecutor` 文件名可后改，不阻塞本 ADR。

## 拒绝

- 用 `dsh-web-app` 替换 frontend / BFF。
- 默认引入 per-Run preset 作为「把 tool 挂上」的手段。
- 在 application 里重新 `registerTool` 一套与 base 同名的工具。
- 把 Run 队列、审批中心、SSE 搬进 ctx。
- 用 `dsh-sandbox-local` 替换 Bubblewrap。
- 本阶段做 memory。
- 让原生审批单独承担 digest 绑定（digest 在执行闸门，不在审批 UI）。

## 现状与实施顺序（未开始）

代码对照本 ADR 的已知差距，供实施时核对，不在本文件里当已完成：

1. Overlay 打开 `dsh-user-approval`；确认 host 上 `tool-fs` / `tool-bash` /
   `tool-todo` / `tool-skill` / `tool-subagent` / ask-user 在 boot 后出现在
   DSH tool 注册表（没有的话补依赖，不是加 preset）。
2. Remote provider 按 Run 隔离（不得并发 `rebind` 根 ctx）。
3. Durable `ctx.subagents` 接到 `SubagentSpawnService`，去掉内存队列当生产路径。
4. Executor：DSH 审批 / 提问 → 停泊企业 Run → 现有 HTTP decide/respond → 续跑。
5. `source_digest` 留在 `pre-execute`。
6. 本机 compose + 现有 LLMIO 跑通：登录 → 建会话 → 带工具 Run → 一轮原生审批停泊。

验证仍遵守：断言语义；改运行时装配必须起栈，不能只靠单测。

## 影响

- [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) D2（能用原生用原生）、D3（提供
  provider，不重写 tool）维持。D4：**问人改走 `dsh-user-approval`**；四个工具管线
  挂载点仍用于 digest / 租户 / 预算 / 账本，不再承担「问人」。
- [ADR 0008](0008-sandbox-isolation-and-fs-seam-redesign.md) 不变。
- `api-server/`、`frontend/` 仍以零改动为目标；审批中心与提问应答的 URL 尽量不动，
  只换后端是谁发出 pending。
- 实施落地时再改 `architecture.md` 的工具面描述与 `STATUS.md` 的 A2 取证对象。
