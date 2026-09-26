# 同一个 MCP 按智能体注入不同参数（宿主参数，设计稿）

本文档约束「宿主参数」能力：**同一台 MCP Server 被多个智能体使用时，某些工具参数
（例如智能问答平台的知识库 ID、应用 ID）由平台按智能体配置填入，模型看不到、也改不了**。

典型场景：智能问答平台以一台 MCP Server 暴露 `ask(question, kb_id, app_id)`。
「人事助手」固定问 `kb_id=hr`，「财务助手」固定问 `kb_id=finance`；模型只负责写 `question`。

---

## 0. 一句话

运维在 `MCP_SERVERS_JSON` 里声明某台 Server 的哪些参数归宿主所有（`hostArguments`），
管理员在 AgentVersion 的 `mcpServers[i].toolArguments` 里给这些参数赋值。每个 Run 启动时，
在本 Run 的工具作用域里为受影响的 MCP 工具注册一个**同名影子定义**：对模型的 schema 去掉
宿主参数，执行时把本 Agent 的值并入参数，再调用原来的 MCP 执行器。连接只有一条、
Server 登记只有一份，不 fork 出厂 `dsh-mcp-client`。

---

## 1. 已核实的事实（请复现）

```bash
# AgentVersion 的 MCP 条目只有三个键；连接材料（url/headers/env/args…）明确禁止
sed -n 82,110p agent/src/application/agent-config-validator.ts

# 运维清单：每台 Server 进程内只连一次，凭据只经 authTokenRef/envRefs/headerRefs 引用
grep -n "headerRefs" agent/src/infrastructure/mcp/mcp-server-registry.ts

# 出厂客户端的 tools/call 只带 name + arguments：没有按调用的 headers，也没有 _meta
sed -n 93,104p agent/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js

# MCP 工具以 Server 声明的 inputSchema 注册在 **global** 层，所有 Agent 共用一份 schema
grep -n "definitions.set(publicName, createDefinition" agent/node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js

# DSH：scope（agent.ctx）里的注册遮蔽同名 global；get(name, scope) 按作用域解析
grep -n "Scoped registrations shadow globals\|Scoped tools shadow" agent/node_modules/@deepseek-ai/dsh-tools/lib/index.js
grep -n "^\s*get(name, scope)" agent/node_modules/@deepseek-ai/dsh-tools/lib/index.js

# 工具体收到的是 exec.arguments（模型参数校验在 createExecution，早于 pre-execute）
grep -n "tool.execute(exec.arguments, exec)" agent/node_modules/@deepseek-ai/dsh-tools/lib/index.js

# 本仓库已按 Run 作用域收窄可见工具（ctx.tools.restrict），即本设计要复用的挂载层
grep -n "4.5) ctx.tools.restrict" agent/src/runtime/policy/install.ts

# 配置校验进程只知道 Server 的工具名，不知道 inputSchema
grep -n "readonly mcpServers: Array<{ serverId: string; toolNames: string\[\] }>" \
  agent/src/application/agent-config-validator.ts
```

推论：

- 按 Agent 区分**连接级**参数（请求头、凭据）只能靠多份登记（见 §7 替代方案 A），不在本设计范围。
- 按 Agent 区分**工具参数**，挂载点在本仓库这一侧就够：schema 需要按 Agent 不同 → 只能在 Run 作用域
  遮蔽；执行参数需要按 Agent 不同 → 影子定义的执行体里合并。

---

## 2. 目标与非目标

**目标**

- 一台 MCP Server、一份连接，多个 Agent 各自给同一个工具参数填不同的值。
- 宿主参数对模型不可见（不在 schema 里），模型传了也会被覆盖，不能越权切换知识库。
- 值随 AgentVersion 版本化、可在智能体设置页编辑；审批卡与工具账本记录**实际发出**的参数。
- 缺值时 fail-closed：需要该参数的工具在本 Run 里不可见，不会带着空值发出去。

**非目标**

- 密钥类参数。宿主参数写在 AgentVersion 里（MySQL 明文、管理员可见），密钥仍走
  `headerRefs` / `authTokenRef`；需要按 Agent 区分凭据时用多份登记（§7 A）。
- 按用户、按会话变化的参数（例如把当前用户 ID 传给 MCP）。本设计的值只来自 AgentVersion。
- 修改出厂 `dsh-mcp-client`，或在 MCP 协议里加 `_meta`。
- 嵌套对象参数：宿主参数只支持 `inputSchema.properties` 下的顶层标量。

---

## 3. 设计决策

### D1 运维声明「哪些参数归宿主」：`MCP_SERVERS_JSON` 新增 `hostArguments`

```jsonc
{
  "id": "qa-platform",
  "transport": "streamable-http",
  "url": "https://qa.example/mcp",
  "authTokenRef": "QA_PLATFORM_TOKEN",
  "hostArguments": {
    "kb_id":  { "description": "知识库 ID" },
    "app_id": { "description": "应用 ID" }
  }
}
```

- 作用于该 Server 下**所有**在 `inputSchema.properties` 顶层声明了同名参数的工具；没声明的工具不受影响。
- 名字须匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`，每台 Server 最多 10 个。
- **名字看起来像密钥的拒绝启动**（不区分大小写包含 `token` / `secret` / `password` / `passwd` /
  `api_key` / `apikey` / `credential` / `authorization`）：这是启发式护栏，防止把凭据设计成宿主参数、
  落进 AgentVersion 明文。误伤时改参数名或改走 `headerRefs`。
- 为什么由运维声明、而不是管理员在 AgentVersion 里随便写：哪些参数「模型不许碰」是 Server 契约的一部分，
  与 Server 登记同一责任人；AgentVersion 只负责赋值。这也保证 schema 遮蔽的范围可审计。

### D2 管理员赋值：AgentVersion `mcpServers[i].toolArguments`

```jsonc
"mcpServers": [
  {
    "serverId": "qa-platform",
    "enabledTools": ["ask"],
    "toolArguments": { "kb_id": "hr", "app_id": "uprc-assistant" }
  }
]
```

- `MCP_ENTRY_V1_KEYS` 增加 `toolArguments`。不叫 `arguments` / `args`：`args` 已在
  `MCP_FORBIDDEN_V1_KEYS` 里表示 stdio 命令行参数，避免混淆。
- 保存期校验（`agent-config-validator` + `bindAgentVersionConfig`，两处共用一个纯解析）：

| 情况 | 码 | path |
|---|---|---|
| 不是对象 | `CONFIG_TYPE` | `mcpServers[i].toolArguments` |
| 键不在该 Server 的 `hostArguments` 里 | `MCP_ARGUMENT_UNKNOWN` | `mcpServers[i].toolArguments.<key>` |
| 值不是 string / number / boolean，或字符串超过 1024 字符 | `MCP_ARGUMENT_INVALID` | 同上 |
| 该 Server 未登记或不可用（沿用） | `MCP_SERVER_UNAVAILABLE` | `mcpServers[i]` |

- 保存期**不**校验值与工具 schema 的类型是否一致：配置校验进程只有工具名（§1）。类型在运行期由
  DSH 对合并后的参数做校验前，由影子执行体按原 schema 检查（D4），不一致作为工具错误返回。
- `config/options` 的 `platformConstraints.mcpServers[]` 增加 `hostArguments`（只有名字与描述），
  前端据此渲染输入框（§5）。不暴露 url、凭据引用。

### D3 每个 Run 注册同名影子定义

Run 装配时（与 `install.ts` 4.5 的 `ctx.tools.restrict` 同一个作用域），对本 Agent **已授权**的每个
MCP 工具 `mcp__<server>__<tool>`：

1. 用 `tools.get(name)`（global 视图）取出厂定义；拿不到则跳过（Server 未连上，已有的 readiness 语义负责报告）。
2. 求本工具受影响的宿主参数 `H = hostArguments ∩ inputSchema.properties 的键`。`H` 为空则不做任何事。
3. 若 `H` 中有参数出现在 `inputSchema.required`，而本 Agent 的 `toolArguments` 没给值 →
   **本 Run 不可见**：从可见名单里去掉该工具（fail-closed），并打一行
   `[mcp-host-args] hidden tool=<name> missing=<keys>`。
4. 否则在 Run 作用域注册同名定义：
   - `parameters`：原 schema 深拷贝，删掉 `properties` 里的 `H`，并从 `required` 里去掉它们；
   - `description`：原描述不变；
   - `execute(args, exec)`：见 D4。

影子定义只存在于本 Run 的作用域，Run 结束随作用域一起释放；其他 Agent 的 Run 看到的仍是各自的影子或原定义。
子 Run（`subagent` / `delegate_to_agent`）按**子 Run 自己绑定的** AgentVersion 装配，不继承父的值。

### D4 执行：宿主值覆盖，调用时才解析原定义

```ts
execute: async (modelArgs, exec) => {
  const original = tools.get(name);                 // 调用时再取：MCP 重连会换掉 global 定义
  if (!original) throw toolError('MCP_TOOL_UNAVAILABLE');
  const merged = { ...omit(modelArgs, H), ...hostValues };   // 宿主赢；模型写了也删掉
  assertHostValueTypes(originalSchema, hostValues);           // 类型不符 → MCP_ARGUMENT_TYPE_MISMATCH
  return original.execute(merged, exec);
}
```

- **先删后并**：即使 Server 的 schema 允许额外属性、模型硬塞了 `kb_id`，也会被删掉，再由宿主值填入；
  宿主没配值的非必填参数则保持缺省——模型永远不能设置宿主参数。
- 合并逻辑是一个纯函数 `mergeHostArguments(toolName, modelArgs, authorization)`，D5 的审批与账本复用它，
  保证三处看到的是同一份参数。

### D5 审批、账本与重放用「实际发出的参数」

- `tools/pre-execute` 与账本的 `started/ended` 目前拿的是 `exec.arguments`（模型参数）。对 MCP 工具，
  改为 `mergeHostArguments(...)` 的结果：
  - 审批卡显示的是会发给 MCP 的完整参数，宿主参数带「平台填入」标记（前端据 `hostArgumentKeys` 字段渲染）；
  - 审批的参数摘要（digest）按合并后的参数计算。AgentVersion 在 Run 内钉死，所以恢复/重放时合并结果不变，
    与现有「同一 callId + 同一 digest 才放行」的语义一致。
- 结构化日志与账本都不需要脱敏宿主参数：它们按 D1 的约束不是密钥。

### D6 与现有授权的关系

- 宿主参数不改变授权：`enabledTools`、`toolPolicy`、风险分类（MCP 默认 `external_high`）照旧。
- 影子定义与原定义同名，所以 `restrict` 可见名单、`toolPolicy.tools.<name>`、审批与风险表都无需知道影子的存在。
- 不引入新的出站路径：执行最终仍走出厂客户端的同一条连接、同一套超时与重连。

---

## 4. 权威边界

| 层 | 职责 |
|---|---|
| `agent/src/infrastructure/mcp/mcp-server-registry.ts` | 解析 `hostArguments`，启动期校验（名字、数量、密钥启发式），非法即拒绝启动 |
| `agent/src/domain/agent/`（新纯模块） | `toolArguments` 解析与诊断；`mergeHostArguments`；schema 裁剪 |
| `agent/src/application/agent-config-validator.ts` / `infrastructure/dsh/agent-version-bindings.ts` | 保存期与 Run 启动期校验；授权投影带上宿主值 |
| `agent/src/runtime/policy/install.ts`（或同层新模块） | Run 作用域注册影子定义、缺值隐藏、审批/账本改用合并参数 |
| `api-server/` | 无改动（配置与 options 已有转发） |
| `frontend/` | MCP 分类里的宿主参数输入框；审批卡的「平台填入」标记 |

---

## 5. 前端

智能体设置页「MCP」分类，已选中的 Server 卡片里、工具勾选区下方增加「平台参数」：

```
☑ 智能问答平台  qa-platform · connected                已开放 1 个工具
   ☑ ask
   平台参数（模型看不到，调用时由平台填入）
   知识库 ID   kb_id   [ hr             ]
   应用 ID     app_id  [ uprc-assistant ]
   ⚠ ask 需要 kb_id：留空时该工具在对话中不可用
```

- 输入框来自 `platformConstraints.mcpServers[].hostArguments`；清空即删键，`toolArguments` 为空时删整个键。
- 草稿里有、登记表里已没有的键显示为「已保留」行，只能移除，`MCP_ARGUMENT_UNKNOWN` 挂在该行（与协作分类同一套做法）。
- 「必填但未填」的提示需要知道工具的 required 列表，而 options 只有工具名（§1）。本期提示文案写成
  「如工具要求该参数，留空时工具不可用」；若要精确提示，需要让 options 带上每个工具的宿主参数必填性，列为 §8 待决。

---

## 6. 实施阶段

1. **Spike（先做，失败则回到方案 A）**：用 `mcp-live.test.ts` 的真实 stdio MCP Server 证明
   - S1 Run 作用域同名注册确实遮蔽 global，模型拿到的 schema 不含宿主参数；
   - S2 影子执行体经 `get(name)` 调到原执行器，Server 收到合并后的参数；
   - S3 另一个 Agent 的 Run 同时进行时看到的是自己的值（并发两个 scope）；
   - S4 MCP 断线重连后，影子仍调到新一代定义；
   - S5 `run_code`（Code Mode）嵌套调用解析到影子而不是原定义。
   **Spike 结果（2026-09-26，`node:22-slim`，真实 stdio MCP Server
   `agent/tests/runtime/fixtures/mcp-host-args-server.mjs`，两个经 `createDshRuntimeFactory` 建的 Run）**：
   - S1 通过：两个 Run 的**模型最终请求**（`llm/stream` 截获）里 `mcp__qa__ask` 只有 `question, top_k`；
     global 定义始终保留 `kb_id`，Run 释放后不受影响。注意 `tools.schemas()` 不传 scope 时返回 global 视图，
     断言必须用 `schemas(agent)` 或模型请求。
   - S2 通过：Server 收到 `{"question":"q-from-a","kb_id":"hr"}`；模型硬塞 `kb_id=finance` 被覆盖为 `hr`。
   - S3 通过：A、B 并发调用分别发出 `hr` / `finance`，同一 Server 进程。
   - S4 通过：Server 崩溃重连后（pid 变化）global 定义被替换，影子经调用时 `get(name)` 调到新一代。
   - S5 不适用：本仓库未调用 `presentAs`，DSH 默认 `native`，没有 `run_code` 嵌套调用路径。
   - **附带发现**：直接执行 global 定义**不校验 `required`**（缺 `kb_id` 的调用照样发给了 Server）。
     所以 D3 的「缺值隐藏」必须由我们实现，不能指望 DSH 的参数校验兜底。
2. **登记表**：`hostArguments` 解析与启动期校验；`.env.example`、`deployment.md` 同步。
3. **配置**：`toolArguments` 解析、保存期诊断、`bindAgentVersionConfig` 投影、`fieldSupport` 与 options。
4. **运行期**：影子注册、缺值隐藏、合并执行、审批与账本改用合并参数；`boot.test.ts` 证明装配生效。
5. **前端**：MCP 分类输入框、审批卡标记。
6. **文档**：`architecture.md`（MCP 一节）、`api.md`（config 字段表）、`deployment.md`、`webui.md`、`CHANGELOG.md`。

---

## 7. 替代方案

| 方案 | 为什么不选作主方案 |
|---|---|
| A. 同一 Server 按 Agent 登记多份（不同 `id`、不同 `headerRefs`） | 零代码，适合 2–3 个 Agent 或**凭据级**差异；但每份一条连接、工具重复、增删 Agent 要改环境变量并重启。保留为密钥类参数的推荐做法 |
| B'. 只在 `tools/execute` 环绕里改 `exec.arguments`，不遮蔽 schema | 模型仍看到并必须填写宿主参数（`required` 在 pre-execute 之前就校验），会编造值、浪费 token，且审批卡显示的是被覆盖前的值 |
| C. 由 MCP Server 按调用方身份自行映射 | 出厂客户端不支持按调用的 headers / `_meta`（§1），需要 fork，违背 ADR 0009 不改出厂包的约束 |

---

## 8. 验收

- 单测：登记表（合法、重名、超数量、密钥启发式拒绝）；`toolArguments` 诊断全表；schema 裁剪
  （properties 与 required 同时去掉、原对象不变）；`mergeHostArguments`（宿主覆盖、模型塞入被删、未配非必填保持缺省）；
  缺必填值时工具不可见。
- `npm test --prefix agent`（含 `boot.test.ts`、`mcp-live.test.ts`）、`npm --prefix agent run typecheck`、
  前端测试与 build、`uv run pytest -q`。
- **真机**（重建 `agent` / `agent-worker` / `frontend`）：登记一台回显参数的测试 MCP Server，
  `hostArguments = { kb_id }`：
  1. Agent A `kb_id=hr`、Agent B `kb_id=finance`，各建会话调用 → Server 分别收到 `hr` / `finance`；
  2. 让模型在参数里写 `kb_id=finance`（提示注入式要求）→ A 的调用仍发出 `hr`；
  3. 请求里的工具 schema（模型最终请求为证）不含 `kb_id`；
  4. A 清空 `kb_id` 且该参数必填 → 对话中该工具不可见，调用不会发出；
  5. 该工具设为需审批 → 审批卡显示 `kb_id=hr（平台填入）`，批准后账本记录的参数与 Server 收到的一致；
  6. 跨租户读取该 Run → 404。

## 9. 待决问题

- 智能问答平台的真实工具签名：宿主参数是否都在 `inputSchema.properties` 顶层、是否必填、有无密钥类参数。
- 是否需要按用户变化的参数（例如当前用户 ID 透传给平台做数据权限）。若需要，另立设计：值来自服务端解析的身份，
  不来自 AgentVersion，也不能由模型提供。
- options 是否要带上每个工具的宿主参数必填性，以便前端精确提示（§5）。
