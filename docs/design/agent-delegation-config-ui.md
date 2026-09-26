# 智能体设置页的「协作」配置区：结构化编辑 `delegation`（设计稿）

本文档约束 Agent 设置页新增的「协作」分类：**管理员勾选本 Agent 可以委派给哪些同 org Agent、
可以调用哪些已登记的远端 A2A Agent，写入 AgentVersion 配置的 `delegation` 键**。

后端能力已在 main（PR #44）：[`agent-delegation.md`](agent-delegation.md)（`delegation.agents`）、
[`a2a-remote-delegation.md`](a2a-remote-delegation.md)（`delegation.remoteAgents`）。
`agent-delegation.md` §6 阶段 4 把前端结构化控件留作「按需」，本文是这一阶段的设计。

---

## 0. 一句话

纯前端改动：在 `AgentConfigEditor` 加一个与「MCP」同形状的分类，候选数据全部来自页面
**已经加载**的两个来源（Agent 列表、配置能力投影），写入同一份 JSON 草稿，保存、校验、冲突
处理沿用现有流程。**不改 BFF、不改 agent、不新增端点。**

---

## 1. 已核实的事实（请复现）

```bash
# 分类只有 basic/model/tools/mcp/json，没有 delegation
grep -n "export type EditorSection" frontend/src/pages/settings/AgentConfigEditor.tsx
rg -n "delegation" frontend/src/pages/settings ; echo "exit=$?"        # → 无结果

# 每个分类只改自己的字段，同一份 JSON 草稿；JSON 结构错时暂停对应分类
sed -n 360,366p frontend/src/pages/settings/AgentConfigEditor.tsx
grep -n "export function structuredEditorIssues" frontend/src/pages/settings/agentHelpers.ts

# 同 org 候选：页面加载时已拉 /api/agents（name、description、status）
grep -n "listAgents()" frontend/src/pages/settings/AgentsPage.tsx

# 远端候选：配置能力投影只给 id/name/description，不给地址和凭据
grep -n "remoteAgents" agent/src/application/agent-config-validator.ts

# 服务端校验码与 path（UI 按 path 挂错误）
rg -n "code: '(CONFIG_|DELEGATION_)" agent/src/domain/agent/delegation-config.ts
grep -n "DELEGATION_AGENT_UNKNOWN" agent/src/application/agent-catalog-service.ts
grep -n "DELEGATION_REMOTE_AGENT_UNKNOWN" agent/src/application/agent-config-validator.ts

# 名单上限 20；目录没有改名/停用 API，status 目前只写 'active'
grep -n "DELEGATION_MAX_ENTRIES =" agent/src/domain/agent/delegation-config.ts

# 行数：Editor 414、AgentsPage 734（棘轮默认 ≤1000）
wc -l frontend/src/pages/settings/AgentConfigEditor.tsx frontend/src/pages/settings/AgentsPage.tsx
```

`delegation` 的服务端契约（`docs/api.md` 配置字段表）：

| 字段 | 取值 | 保存期校验 | 运行期 |
|---|---|---|---|
| `delegation.agents` | 同 org Agent `name` 数组，≤20，去重 | 名字须存在于本 org，否则 `DELEGATION_AGENT_UNKNOWN`（`path = delegation.agents[i]`） | spawn 时再判 active |
| `delegation.remoteAgents` | `A2A_REMOTE_AGENTS_JSON` 里的 `id` 数组，≤20，去重 | 须已登记，否则 `DELEGATION_REMOTE_AGENT_UNKNOWN` | 调用前再判；默认要审批 |
| 其余子键 | — | `CONFIG_UNKNOWN_FIELD` | — |

省略 `delegation` 或两个数组都为空 = 不可委派。

---

## 2. 目标与非目标

**目标**

- 管理员不写 JSON 就能配置两份白名单，并看到每个候选会以什么描述出现在模型的系统提示里。
- 草稿里的每个名字都有落点：候选列表里没有的名字不会被静默丢弃，服务端错误能挂到对应行。
- 与其他分类同一套草稿、校验、未保存提示、版本差异与 409 冲突流程。

**非目标**

- 在 UI 上登记远端 Agent、查看地址或凭据（运维面，只走环境变量；原因见
  `a2a-remote-delegation.md` D2）。
- 修改 `tool-risk.json` 或 `toolPolicy` 里委派工具的审批级别（仍在「工具权限」分类里做）。
- 编辑目标 Agent 的描述（在目标 Agent 自己的基本信息里改）。
- 任何 BFF / agent 改动。

---

## 3. 设计决策

### D1 新分类「协作」，放在 MCP 之后

`EditorSection` 增加 `'delegation'`，标签「协作」，计数 = 两份名单条目数之和
（与「工具权限」「MCP」的计数语义一致）。顺序：基本信息 · 模型 · 工具权限 · MCP · **协作** ·
版本历史 · JSON。

新代码放 `frontend/src/pages/settings/DelegationFields.tsx`，纯函数放 `agentHelpers.ts`，
`AgentConfigEditor.tsx` 只增加分派一行，避免把 414 行的文件继续做大。

### D2 布局

```
协作
  这个智能体可以把自包含的子任务交给下列对象。不勾选 = 不能委派。

  同组织智能体                                         已选 2 / 20
  ┌─────────────────────────────────────────────────────────────┐
  │ ☑ data-analyst     擅长 SQL 与报表分析                         │
  │ ☑ code-reviewer    （没有描述：模型不知道它擅长什么）  ⚠        │
  │ ☐ writer           中文写作与润色                              │
  │ ☑ legacy-bot       已保留 · 组织内找不到这个名字   [移除]       │
  └─────────────────────────────────────────────────────────────┘
  子任务以同一用户身份运行，使用目标智能体自己的模型、工具权限和审批。

  远端智能体（A2A）                                    已选 1 / 20
  ┌─────────────────────────────────────────────────────────────┐
  │ ☑ 财务助手  finance-bot   查询报销与预算           需审批       │
  │ ☐ 法务助手  legal-bot     合同条款检索             需审批       │
  └─────────────────────────────────────────────────────────────┘
  每次调用都需要人工批准；只发送任务文字，不带附件、工作区文件或对话记录。
  远端清单由运维配置（A2A_REMOTE_AGENTS_JSON），这里只能选择。
```

- 每行：勾选框、`name`（远端为 `name` + `id`）、描述。描述就是进系统提示的文本
  （`agent-delegation.md` D4），空描述给一个行内提示，不阻止勾选。
- 远端行固定显示「需审批」：风险分类 `external_high`，平台默认必审批。不读 `toolPolicy`
  推导实际级别——租户只能再收紧，文案「需审批」始终成立。

### D3 候选与「已保留」行

| 情况 | 显示 |
|---|---|
| 同 org 候选 | `/api/agents` 列表中除**当前 Agent 自身**以外的 Agent，按名字排序 |
| 草稿里有、列表里没有的名字 | 列末「已保留 · 组织内找不到这个名字」行，可取消勾选（移除），不可新增 |
| 草稿里含当前 Agent 自身的名字 | 同上一行形状，提示「委派给自己请用同构子任务（subagent）」；服务端允许，UI 不擅自删 |
| 列表中 `status ≠ active` 的 Agent | 可见、不可新勾选，已勾选的可取消；提示「已停用，运行时会被拒绝」 |
| 远端候选 | `options.platformConstraints.remoteAgents`，保持服务端顺序 |
| 草稿里有、登记表里没有的远端 id | 「已保留 · 当前部署未登记」，可移除；服务端会报 `DELEGATION_REMOTE_AGENT_UNKNOWN` |

排除自身的理由：A → A 等同 `subagent`，却要多一次目录解析与一段系统提示；深度上限虽然能
截断，但不应作为推荐用法出现在候选里。

目前目录没有改名 / 停用 API（§1），「已保留」与「已停用」两类行主要覆盖直接改库、
从 JSON 粘贴、复制旧版本三种来源。

### D4 写入规则（`agentHelpers.ts`）

- `delegationOf(config)` → `{ agents: string[], remoteAgents: string[] }`，非数组视为空。
- `setDelegationList(config, key, list)`：
  - 保持草稿原有顺序，新勾选追加在末尾（顺序会进系统提示，不按字母重排制造无意义 diff）；
  - 列表为空时删掉该子键；两个子键都没有且 `delegation` 下也没有其他键时，删掉 `delegation`；
  - **不触碰 `delegation` 下的未知子键**：它们留在草稿里，由服务端报 `CONFIG_UNKNOWN_FIELD`，
    与「未知字段保留在 JSON 里」的现有原则一致。
- `structuredEditorIssues` 增加：`delegation` 不是对象、`agents` / `remoteAgents` 不是字符串数组
  → 暂停「协作」分类编辑，提示去 JSON 修。
- 达到 20 条时禁用未勾选项，显示「已达上限 20」；上限读 `fieldSupport.delegation.fields.*.maxItems`，
  读不到时退回 20。

### D5 错误挂载

服务端诊断按 `path` 挂到行上：

| path | 挂在 |
|---|---|
| `delegation.agents[i]` / `delegation.remoteAgents[i]` | 草稿中第 i 个名字所在行（包括「已保留」行） |
| `delegation.agents` / `delegation.remoteAgents` | 对应分组标题下 |
| `delegation` / `delegation.<未知键>` | 分类顶部 |

保存时 BFF 返回的 400 只有通用 `VALIDATION_ERROR`（evidence 2026-09-24 发现 3），具体码在 `error`
文本里；本页已有的实时 validate 会先给出逐字段 `errors[].code`，所以 UI 以 validate 结果为准，
不解析保存错误的文本。

### D6 依赖不可用

| 数据源失败 | 行为 |
|---|---|
| Agent 列表失败 | 同 org 分组显示 `CatalogNotice`；草稿中的名字全部按「已保留」行展示，只能移除 |
| `options` 为空 | 远端分组同上处理 |

发布**不**因此被拦截：两份名单的存在性由服务端在 validate 与保存事务中校验，前端拿不到
候选不影响服务端判定。这与 `configNeedsCapability` 对模型 / 工具 / MCP 的拦截不同——那几项
UI 需要目录才能判断草稿是否仍然有效，这里不需要。

### D7 草稿、差异与并发

全部沿用：写入同一份 `configDraft`，所以未保存圆点、「N 处未保存修改」、`configDiff` 版本差异、
切换 Agent 保留草稿、409 冲突后保留草稿重试都自动覆盖 `delegation`。需要确认的只有一点：
`configDiff` 对数组给出的是可读的增删，而不是整段替换——实施时核对，必要时为 `delegation.*`
加一个按元素比较的分支。

---

## 4. 权威边界

| 层 | 本设计中的职责 |
|---|---|
| `frontend/src/pages/settings/` | 分类、候选投影、写入草稿、错误挂载 |
| `api-server/` | 无改动（配置经 `/api/agents` 与 config-options 已有转发） |
| `agent/` | 无改动；名字存在性、登记表、上限、运行期判定仍是服务端权威 |

---

## 5. 实施阶段

1. **helper**：`delegationOf` / `setDelegationList` / `structuredEditorIssues` 扩展 + 单测
   （顺序保持、空列表删键、未知子键保留、结构错暂停、上限）。
2. **分类组件**：`DelegationFields.tsx` + `EditorSection` / tabs 接线 + 组件测试
   （候选排除自身、已保留行、停用行、错误按 path 挂载、依赖失败只可移除）。
3. **文档**：`webui.md` Agent 设置一节加「协作」分类；`agent-delegation.md` §6 阶段 4 标注由本文实现
   （只追加说明，不改原决策）；`CHANGELOG.md` `[Unreleased]`。

---

## 6. 验收

- `npm test --prefix frontend`、`npm run build --prefix frontend`、`uv run pytest -q`（行数棘轮与文档位置）。
- **浏览器实际操作**（AGENTS.md §4：前端行为变更）。重建 `frontend` 容器，`A2A_REMOTE_AGENTS_JSON`
  登记至少一个远端：
  1. A 勾选 B 与一个远端 → 保存成新版本 → JSON 分类里是 `{"agents":["B"],"remoteAgents":["<id>"]}`；
     用 A 建会话让它委派，确认实际走通（复用 evidence 2026-09-24 的场景即可）；
  2. 在 JSON 分类手填不存在的名字 → 切回「协作」出现「已保留」行，行上显示 `DELEGATION_AGENT_UNKNOWN`
     的文案，发布按钮不可用；移除后可发布；
  3. 全部取消勾选 → 保存后配置里没有 `delegation` 键；
  4. 在 JSON 分类把 `delegation` 改成数组 → 「协作」分类暂停并提示；
  5. 两个标签页同时改同一 Agent → 后保存的一方拿到冲突提示且草稿保留；
  6. 停掉 agent 的 config-options（或断网模拟）→ 远端分组只读，已有条目保留。
- 不涉及 agent / api-server 运行路径，不要求重建后端容器；验证记录写明这一点。

---

## 7. 待决问题

- 当前 Agent 自身不进候选（D3）是否符合产品预期，还是希望显式允许「委派给自己」。
- 远端行是否要显示最近一次调用状态（需要新的查询端点，本稿不做）。
