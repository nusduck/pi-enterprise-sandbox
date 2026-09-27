# Agent 间委派：让一个 Agent 把子任务交给同 org 的另一个 Agent（设计与实施计划）

本文档约束「异构委派」能力：**Run 执行中，模型调用一个工具，把一段自包含的任务交给同一个
org 下的另一个 Agent（例如「通用助手」把 SQL 分析交给「数据分析助手」），等它跑完并拿回
结果**。

前置能力：

- [`multi-agent-selection.md`](multi-agent-selection.md)：一个 org 下并列多个 `agent_definitions`。
- 子 Run（`architecture.md`「子 Run（sub-agent）」、[ADR 0012](../adr/0012-depth-layered-run-queues.md)）：
  durable 的父子 Run、深度分层队列、级联取消。

跨服务、跨部署的委派（A2A 客户端）见 [`a2a-remote-delegation.md`](a2a-remote-delegation.md)，
两者共用本文的配置键 `delegation` 与工具命名约定。

---

## 0. 一句话

子 Run 的全部 durable 机制已经存在，缺的只是**「子 Run 用哪个 Agent」这一个维度**：
`SubagentSpawnService.spawn()` 把子 Run 钉死在父 Run 的 Agent 与版本上。本设计给 spawn 加一个
经过授权校验的 `targetAgentName`，再加一个自建宿主工具 `delegate_to_agent` 作为模型入口。

---

## 1. 已核实的事实（请复现）

以下在 `feat/multi-agent-delegation` 起点 `2092663a` 上核实。

```bash
# 子 Run 的 Agent 与版本都取自父 Run，没有任何参数能改
grep -n 'agentId: parentConversation.agentId\|agentVersionId: parent.agentVersionId' \
  agent/src/application/subagent-spawn-service.ts
# → 266 / 279（conversation + session）、300（message 选择器）、313（run）

# 出厂 subagent 工具只有 description / prompt / run_in_background 三个参数
sed -n 140,158p agent/node_modules/@deepseek-ai/dsh-tool-subagent/lib/index.js

# 自建宿主工具的现成形状：cordis 插件 + ctx.tools.register
sed -n 50,60p agent/src/runtime/providers/submit-artifact.ts

# 工具调用 id 可经 ALS 取到（幂等键）
grep -n 'callId' agent/src/runtime/providers/tool-execution-context.ts

# 工具名是 fail-closed 契约：不在名单里 → classifyTool 返回 unknown → deny
grep -n "return 'unknown'" agent/src/runtime/policy/risk-table.ts

# AgentVersion 配置的顶层键是白名单，未知键报 CONFIG_UNKNOWN_FIELD
grep -n 'TOP_LEVEL_V1_KEYS' agent/src/application/agent-config-validator.ts
```

**发现的文档漂移**：`architecture.md`「子 Run」一节写着「也可由 AgentVersion 的
`configJson.subagent` 按租户收紧」，但 `rg 'configJson\??\.subagent' agent/src` 无结果，
spawn 的 `maxDepth` 只来自出厂工具请求。本设计不修复该漂移（不属于同一件事），但新增的
`delegation` 键**必须有实际读取方**，并在 §7 的测试里证明。

---

## 2. 目标与非目标

**目标**

- 管理员在 AgentVersion 配置里声明「这个 Agent 可以把任务委派给哪些 Agent」；缺省为**不可委派**。
- 模型通过 `delegate_to_agent` 把自包含任务交给名单内的 Agent，前台等待结果。
- 子 Run 使用**目标 Agent 的活跃版本**：它自己的 systemPrompt、模型、toolPolicy、MCP 授权。
- 复用子 Run 已有的全部性质：独立会话与工作区、深度/并发上限、分层队列、级联取消、同一条 trace、幂等。

**非目标（本轮不做）**

- 后台委派 / 对同一个子 Agent 续聊（与出厂 `subagent` 的 one-shot 决策一致）。
- 父子工作区文件自动互通（见 D6，走现有的产物提交 + 跨会话导入）。
- 跨 org 委派。
- 前端结构化配置控件（配置经 Agent 设置页的「Advanced JSON」编辑；§6 阶段 4 视需要补）。

---

## 3. 设计决策

### D1 模型入口是自建工具 `delegate_to_agent`，不改出厂 `subagent`

出厂 `subagent` 的参数表写死在包里，且 provider 能力位 `persona: false`。给它加参数要么 fork
包，要么在 cordis patch 上做 schema 手术，两者都会在升级 DSH 时静默失效。自建工具与
`submit_artifact` 同一形状，参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `agent` | ✅ | 目标 Agent 的 `name`（org 内唯一，见迁移 `20260729000001`） |
| `description` | ✅ | 3–5 词显示标签，写入 `runs.subagent_label` |
| `prompt` | ✅ | 自包含任务；子 Agent 看不到父会话 |

`subagent` 工具保持原样：同构分身继续走它。

### D2 授权：AgentVersion 配置的显式白名单，缺省拒绝

```jsonc
{
  "schemaVersion": 1,
  "delegation": {
    "agents": ["data-analyst", "code-reviewer"]
  }
}
```

- `delegation` 缺省或 `agents: []` = 本 Agent **不可委派**；工具调用返回
  `DELEGATION_NOT_CONFIGURED`，不建子 Run。
- 条目是 Agent `name`。保存时校验：必须是本 org 内存在的 Agent；不存在报
  `DELEGATION_AGENT_UNKNOWN`（跨 org 的名字与不存在同一个错误码）。
- 名单**在运行时再校验一次**（spawn 事务内）：保存后目标 Agent 可能被停用或删除。

> **这不是权限提升面**，但仍然缺省拒绝。同一个用户本来就能在 UI 里直接选任何 active 的
> org Agent 建会话，委派并不让他获得额外能力——子 Run 以**同一个 org/user 身份**执行，
> 并受目标 Agent 自己的 toolPolicy 与审批约束。白名单约束的是「模型可以自主把任务
> 交给谁」，属于管理员意图；fail-closed 的理由是 AGENTS.md §2：能力缺省关闭。

### D3 子 Run 绑定目标 Agent 的活跃版本，在 spawn 事务内解析

`SubagentSpawnService.spawn()` 新增可选 `targetAgentName`：

- 缺省：行为与现在**逐字节一致**（继承父 Run 的 Agent 与版本）——出厂 `subagent` 走这条。
- 给出：在同一事务内按 `(org_id, name)` 读 `agent_definitions`（`LOCK IN SHARE MODE`），
  校验 `status = active`、活跃版本存在且属于它且 `status = active`（与建会话选 Agent 的
  `run-parent-provisioner.ts` 同一套规则），否则抛
  `SubagentLimitError('DELEGATION_TARGET_UNAVAILABLE')`。按 org 查询，别的 org 的同名
  Agent 天然查不到；不存在、跨 org、停用返回同一个码与同一句消息。
- 子会话 `agent_id`、子 session / run 的 `agent_version_id`、触发消息的 `agentId`
  全部取目标值。
- 幂等请求散列加入 `targetAgentName`（仅在给出时）：同一 toolCallId 换目标重放会被
  idempotency 层判冲突；未委派的 spawn 散列不变。

版本在 spawn 时解析并钉进子 AgentSession，与 multi-agent-selection D1/D2 同一原则：
admin 之后切换活跃版本不影响已经建好的子 Run。

### D4 可委派名单进系统提示，而不是另开一个列表工具

工具在 boot 时注册一次（进程级），描述无法按 Run 变化。模型需要知道「可以交给谁、各自
擅长什么」，做法是在本 Run 的 persona 段后追加一段：

```
## Delegation
You can hand a self-contained task to another agent with `delegate_to_agent`.
Available agents:
- data-analyst — <agent_definitions.description>
- code-reviewer — <...>
```

- 只在名单非空时追加，且只列出**当下** active 的目标（Run 启动时查一次目录）。
- 描述来自 `agent_definitions.description`（管理员可控文本），按 persona 同级对待；
  企业条款仍在其后且不可覆盖。
- 不另开 `list_agents` 工具：多一次往返，且出厂 `tool-subagent-list-agents` 已按
  ADR 0009 关闭，不重新引入同类面。

### D5 前台等待，轮询节奏与 durable-subagent 相同

工具体：`spawn` → 按 200 ms 起、指数退避到 2 s 轮询 `getStatuses` → 终态返回
`resultSummary`（上限沿用 `DEFAULT_RESULT_SUMMARY_CHARS`）。`AbortSignal` 触发时立即
停止轮询、退出；子 Run 的取消由父 Run 取消级联负责（已存在），工具本身不另发取消。

幂等键用 DSH 的 `callId`（`currentToolExecutionContext()`），不用随机 jobId：同一
tool call 重试会领回已建的子 Run 继续等。**待验证**：父 Run 被 Worker 重启恢复后，
重放的这次调用是否沿用同一 `callId`；若不是，结果是多建一个子 Run（与现有 `subagent`
的行为相同，不是回退），在 §7 真机步骤里记录实际行为。

返回值形状与前端 `subagentFields.ts` 已认识的形状对齐（`childRunId` / `status` /
`resultSummary`），让时间线卡片复用子 Agent 的展示，不新增前端分支。

### D6 父子工作区不共享

子 Run 有自己的 sandbox workspace（spawn 服务已如此，理由见其文件头：共享会话会死锁）。
需要传文件时，子 Agent 用 `submit_artifact` 提交，父侧在结果里拿到 `artifact_id` 后按现有
「跨会话 Import」导入。本轮不做自动互通。

### D7 风险与策略

`delegate_to_agent` 加入 `SANDBOX_TOOL_NAMES`（模型侧工具名的唯一事实源），
`tool-risk.json` 登记为 `low`：它不产生外部副作用，子 Run 的每一个工具调用仍然各自走
目标 Agent 的策略与审批。租户可以在自己的 `toolPolicy` 里把它收紧成
`require_approval` 或 `deny`。

### D8 限额共用子 Run 的深度与并发

委派出的子 Run 就是 `source='subagent'` 的普通子 Run，计入同一个 `subagent_depth` 与
活跃兄弟数。A → B → A 这类环由深度上限（默认 2）截断，不另做环检测。
子 Run 的 `delegation` 由**子 Agent 自己的**版本配置决定，不继承父的名单。

---

## 4. 权威边界

| 层 | 本设计中的职责 |
|---|---|
| `agent/src/application/` | spawn 目标解析与校验（账本、事务）、工具的等待逻辑 |
| `agent/src/runtime/providers/` | `delegate_to_agent` 插件：参数校验、经 ALS 取本 Run 的服务 |
| `agent/src/application/agent-config-validator.ts` | `delegation` 键的保存期校验 |
| `api-server/` | **无改动**。配置经已有的 `/api/agents` 转发 |
| `frontend/` | 本轮无改动（Advanced JSON 可编辑；时间线复用子 Agent 卡片） |

---

## 5. 错误码

| 码 | 何时 | 模型看到 |
|---|---|---|
| `DELEGATION_NOT_CONFIGURED` | 本 Agent 无 `delegation.agents` | 工具错误，说明本 Agent 不能委派 |
| `DELEGATION_AGENT_NOT_ALLOWED` | `agent` 不在白名单 | 工具错误，附当前可用名单 |
| `DELEGATION_TARGET_UNAVAILABLE` | 目标不存在 / 跨 org / 非 active / 无活跃版本 | 工具错误 |
| `SUBAGENT_DEPTH_LIMIT` / `SUBAGENT_CONCURRENCY_LIMIT` / `SUBAGENT_PARENT_NOT_RUNNABLE` | 沿用 | 沿用 |
| `DELEGATION_AGENT_UNKNOWN`（保存期） | 配置引用不存在的 Agent | `valid:false`，`path = delegation.agents[i]` |

---

## 6. 实施阶段

每阶段测试通过后进入下一阶段。

1. **spawn 支持目标 Agent**：`SubagentSpawnService.spawn({ targetAgentId })` + 单测
   （缺省继承、合法目标、跨 org、非 active、无活跃版本、幂等散列）。
2. **配置键**：`agent-config-validator` 接收 `delegation`（v1 键、类型、名字存在性），
   `fieldSupport` 暴露；`bindAgentVersionConfig` 投影 `delegation`。
3. **工具与提示**：`delegate_to_agent` 插件、`tool-names.ts` / `tool-risk.json` 登记、
   `buildRunServices` 带上委派服务与白名单、系统提示追加 Delegation 段；
   `boot.test.ts` 证明插件真的装上（cordis patch 装不上不报错）。
4. **（按需）前端**：结构化控件；如只用 Advanced JSON，则只更新 `webui.md` 说明。
   （2026-09-26 补记：由 [`agent-delegation-config-ui.md`](agent-delegation-config-ui.md) 实现为「协作」分类。）
5. **文档**：`architecture.md`（子 Run 一节）、`api.md`（config 字段表）、`CHANGELOG.md`。

---

## 7. 验收

- 单测：spawn 的目标解析分支全覆盖；validator 的 `delegation` 合法/非法对照；工具的
  未配置 / 不在名单 / 成功三条路径；提示段只在名单非空时出现。
- `npm test --prefix agent`、`npm --prefix agent run typecheck`、仓库卫生 `uv run pytest -q`。
- **真机**（重建 `agent` / `agent-worker`）：
  1. 建 Agent B（systemPrompt 能被识别的口头禅），Agent A 的新版本 `delegation.agents=["B"]`；
  2. 用 A 建会话，让它委派 → 断言子 Run 的 `agent_version_id` = B 的活跃版本、结果回到父 Run；
  3. A 的名单去掉 B 后再试 → `DELEGATION_AGENT_NOT_ALLOWED`，且**没有**子 Run 生成；
  4. 另一个 org 的用户用同名 Agent 不可见（保存期 `DELEGATION_AGENT_UNKNOWN`）；
  5. 取消父 Run → 子 Run 级联取消。
