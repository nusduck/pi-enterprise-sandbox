# 多 Agent 选择：让一个 org 提供多个可选智能体（设计与实施计划）

本文档约束「多 Agent」能力的技术设计与实施规范：**同一个 org 下并列存在多个智能体
（通用助手 / 数据分析助手 / 代码审查助手…），普通用户在建会话时选择用哪一个**。

设计基线：`plan.md` §8.4 / §8.5 已冻结的 `agent_definitions` + `agent_versions` 两张表。
本文档不修改基线，只补上基线定义了、但至今没有写入口与选择入口的那一段。

---

## 0. 一句话

运行时消费面已经建好了——`bindAgentVersionConfig()` 能把 AgentVersion 的 `config_json`
完整投影成 model / systemPrompt / skills / mcpServers / toolPolicy / sandboxPolicy，
executor 每个 Run 都按 `run.agentVersionId` 加载它。**缺的只有三样：目录写入端点、
建会话时的 `agent_id` 参数、前端的 Agent 概念。**

---

## 1. 概念澄清（这一节先读，否则后面全是歧义）

两张表承担**完全不同**的职责，把它们搞混是本次需求最容易走错的一步：

| 表 | 语义 | 关系 | 用户可见性 |
|----|------|------|-----------|
| `agent_definitions` | **一个智能体**。「数据分析助手」是一行 | 并列。org 下 N 行 = N 个可选智能体 | **可见可选**，前端下拉里的每一项 |
| `agent_versions` | 某个智能体的**一次不可变配置快照** | 从属。`UNIQUE (agent_id, version_no)` | **不可见**，admin 改配置的产物 |

**「多一个可选的智能体」= 新增一行 `agent_definitions`（并自带 v1），
不是往已有 Agent 下加 version。**

原因：`agent_definitions.active_version_id` 是**单值**的，一个 Agent 在任一时刻只有一个
活跃版本。往同一个 Agent 下加 10 个 version，用户能用的仍然只有 1 个，其余 9 个是历史。
版本线表达「同一个东西的先后」，不表达「并列的选项」。

目标形态：

```
org
├── agent_definitions「通用助手」(name=default)   ← 用户可选
│   ├── agent_versions v1
│   └── agent_versions v2   ← active_version_id
├── agent_definitions「数据分析助手」              ← 用户可选
│   └── agent_versions v1    systemPrompt + SQL skills
└── agent_definitions「代码审查助手」              ← 用户可选
    └── agent_versions v1    toolPolicy: 工作区只读
```

---

## 2. 已核实的事实（请复现）

以下结论均在 `refactor/dsh-rebuild` @ `e5c400c6` 上核实。行号为核实当时值，
引用前请按 AGENTS.md §7「先 grep 验证机制仍存在」重跑一遍。

```bash
# 目录仓储的写方法齐全（4 个）
grep -n 'async createDefinition\|async createVersion\|async setActiveVersion\|async listDefinitionsByOrg' \
  agent/src/infrastructure/mysql/repositories/agent-catalog-repository.ts
# → 140 / 211 / 247 / 117

# 但全仓没有任何 HTTP 端点调用它们 —— 这是「每个 org 只有一个 Agent」的根因
grep -rn 'createDefinition\|createVersion\|setActiveVersion' agent/src --include='*.ts' \
  | grep -v agent-catalog-repository
# → 输出为空

# Provisioner 已支持显式选 Agent，只是目前只有 A2A 路径在传
grep -n 'async provision(auth' agent/src/application/parent/run-parent-provisioner.ts
# → 154，签名末位是 selection: { agentId?: string | null } = {}

# 建会话这一侧没接上：BFF 只透传 title，agent 侧不带 selection
grep -n 'export async function handleCreateConversation' api-server/src/routes/conversations.ts  # → 59
grep -n 'async create(auth, input' agent/src/application/conversation-service.ts                 # → 325

# 但 follow-up 路径**是**透传 agent_id 的 —— 参数通道已验证过
grep -n 'agent_id: body.agent_id' api-server/src/routes/runs.ts             # → 460
grep -n 'agentId: body.agent_id' agent/src/bootstrap/create-http-server.ts  # → 412
```

---

## 3. 架构定位与权威边界

依据 AGENTS.md §1，本次改动的三层职责：

| 服务 | 本次变更职责 | 严禁事项 |
|------|-------------|---------|
| `frontend/` | 建会话时的 Agent 选择器、会话头部显示当前 Agent、Agent 管理页 | 不缓存 `agentVersionId`；不自行判断哪个版本活跃 |
| `api-server/` | `/api/agents` 纯转发 + 鉴权投影；建会话时透传 `agent_id` | **不做 Agent 目录的任何状态判断**，不校验 Agent 归属 |
| `agent/` | Agent 目录的唯一账本：CRUD、org 作用域、版本解析与绑定 | 不接受浏览器直传的 `X-Acting-*` |

Agent 目录是 `agent/` 的权威事实。BFF 若自行缓存或校验 Agent 归属，就会出现
两处状态源——这正是 AGENTS.md §1「不要在 BFF 里补状态」要防的。

---

## 4. 现状地图：两条身份链

需求里纠缠的两个 id 分属两条链，起点、载体、权威层都不同。分开看才不会乱。

### 4.1 链 A —— `orgId`：鉴权投影出来的

**结论：6 跳全通，前端本就不该传，源头待 SSO 替换。**

| # | 环节 | 位置 |
|---|------|------|
| 1 | 签发：org 写进 JWT payload | `agent/src/application/browser-auth-service.ts:246,258` |
| 2 | **源头硬编码 `BOOTSTRAP_ORG_ID`** ← SSO 接入点 | `browser-auth-service.ts:332`（register） |
| 3 | BFF 解析票据 → `actingOrganizationId` | `api-server/src/application/run-access-service.ts:105` |
| 4 | 写成内部头，并**剥掉浏览器伪造的同名头** | `services/agent-client.ts:101` 写入 / `services/sandbox-client.ts:124` 剥离 |
| 5 | agent 读头，`provider` 固定 `'bff'` | `agent/src/presentation/http/request-response.ts:49,56` |
| 6 | 外部标识 → 内部 `CHAR(26)` ULID | `parent/run-parent-provisioner.ts`，`organization_external_refs (provider, external_subject)` |

前端不传 orgId 是**设计正确**，不是缺陷：AGENTS.md §1 明令
「`X-Acting-*` 必须由服务端解析后写入，永远不能透传浏览器的」。
真正的缺口在第 2 跳——所有浏览器用户共用一个 org。

### 4.2 链 B —— `agentVersionId`：账本解析出来的

**结论：两端已建，中间的「写入」与「选择」缺失。**

| # | 环节 | 状态 | 位置 |
|---|------|------|------|
| 1 | 前端提供 Agent 选择 | **缺失** | 仅 `frontend/src/pages/settings/A2aPage.tsx:175` 有只读下拉 |
| 2 | BFF 透传 `agent_id` | **缺失** | `api-server/src/routes/conversations.ts:59` 只取 title |
| 3 | `ConversationService.create()` 传 selection | **缺失** | `agent/src/application/conversation-service.ts:325` |
| 4 | Provisioner 按 agentId 解析活跃版本 | 已建 | `run-parent-provisioner.ts:154`（校验同 org + active + 有 activeVersionId） |
| 5 | 版本钉进 AgentSession，复用会话不漂移 | 已建 | `run-parent-provisioner.ts:465-504` `boundAgentVersionId` |
| 6 | Executor 按版本加载不可变配置 | 已建 | `dsh-run-executor.ts:429` + `agent-version-bindings.ts:179` |

---

## 5. 目标与非目标

**目标**

- 一个 org 下可存在多个 Agent；admin 能创建、改配置、切活跃版本。
- 普通用户建会话时可选本 org 内 `status=active` 的任一 Agent。
- 不传 `agent_id` 时行为与现在**完全一致**（租户默认 Agent），现有前端零改动可用。

**非目标（本轮不做）**

- 会话中途切换 Agent（见 D2）。
- Agent 级别的按用户/角色可见性控制（见 §8 开放问题）。
- Agent 配置的可视化编排、模板市场、跨 org 共享。

---

## 6. 设计决策

### D1 前端选 `agentId`，不选 `agentVersionId`

Agent 是稳定的产品概念，Version 是不可变实现快照。前端传 `agent_id`，
由服务端**在事务内**解析 `active_version_id` 并钉进 AgentSession。

这与 `provision(auth, {agentId})` 现有签名完全一致，Provisioner 一行不用改。

> **否决**：让前端直接传 `agentVersionId`。会把实现细节泄漏到 UI，且前端必须自行
> 追踪哪个版本活跃——admin 一旦切版本，前端缓存的 versionId 立刻过期。

### D2 绑定发生在 Conversation 创建时，此后不可变

一个会话 = 一个 Agent。换 Agent = 新建会话。

AgentSession 携带工作区、快照、journal 与 sandbox 身份，中途换 Agent 等于换掉这
一整套状态的语义：journal 里可能存在对「新版本已移除的工具」的调用记录，
recovery replay 会对不上；toolPolicy 收紧后，先前已批准操作的副作用已经落在工作区里。

该约束**已在代码中强制执行**（`run-parent-provisioner.ts:356,386`
抛 `Conversation is bound to a different agent`），本次只是补上入口。

> **否决**：会话中途切换。需要同时解决「旧版本 journal 能否被新版本 replay」，
> 撕开 §2 的 fail-closed 不变量，收益远小于成本。

### D3 写入面落在 `agent/`，BFF 只做转发

新增 `/internal/agents` 一族端点；BFF 加 `/api/agents` 纯转发 + 鉴权投影。

> **否决**：复用 `/internal/a2a/config`（`admin-http-handler.ts:145`）做管理面。
> 那个端点的语义是 A2A 对外协议配置，塞进通用 Agent CRUD 会让两个关注点长在一起。
> 它可以继续作为 A2A 侧的读视图，但数据源应统一到新的目录服务。

### D4 改配置 = 建新版本，永不原地改写

`agent_versions` 不可变：编辑配置产生 `version_no + 1` 的新行，旧行保留。
`setActiveVersion()` **只影响新建的会话**——正在运行的 Run 与已存在的 AgentSession
继续使用它们钉住的版本（D2 那条 `boundAgentVersionId` 逻辑）。

回滚 = 把 `active_version_id` 指回旧版本，无需任何数据修复。

> **否决**：原地更新 `config_json`。会让 `config_hash` 失去意义，且正在跑的 Run
> 可能在中途读到不同配置，直接破坏可复现性。

---

## 7. 详细设计与代码变更点

### 7.1 Agent 服务层（`agent/`）

1. **新增 `agent/src/application/agent-catalog-service.ts`**
   - `listAgents(auth)` — 按 org 列 Agent，附活跃版本号。
   - `listVersions(auth, agentId)` — 某个 Agent 的版本线，新的在前。
   - `createAgent(auth, { name, description, config })` — 建 definition + v1 + 指向 v1，
     单事务内完成。
   - `createVersion(auth, agentId, { config, activate })` — 取当前
     `MAX(version_no) + 1` 建新版本，`activate` 为真时一并切活跃。
   - `setActiveVersion(auth, agentId, versionId)` — 校验 version 属于该 agent 后切换。
   - **写入即校验**：所有接受 config 的入口都先跑一遍
     `bindAgentVersionConfig()`（`agent-version-bindings.ts:179`），
     让非法配置在建版本时就失败，而不是等到 Run 起不来。

2. **新增 `agent/src/presentation/http/agents-routes.ts`**

   | 方法 | 路径 | 角色 |
   |------|------|------|
   | GET | `/internal/agents` | member |
   | POST | `/internal/agents` | **admin** |
   | GET | `/internal/agents/:id/versions` | admin |
   | POST | `/internal/agents/:id/versions` | **admin** |
   | POST | `/internal/agents/:id/active-version` | **admin** |

   - 一律经 `authSubjectsFromRequest()`（`request-response.ts:49`）取 org 作用域。
   - **跨租户返回 404，不用 403**（AGENTS.md §2）——存在性本身不能泄漏。
   - 写操作要求 `X-Acting-Role: admin`；角色缺失时 fail-closed 拒绝。

3. **`agent/src/application/conversation-service.ts:325`**
   - `create(auth, input)` 读取 `input.agent_id`，作为 `selection` 透给 `provision()`。
   - 不传时维持现有 `ensureTenantDefaultAgent()` 行为（向后兼容）。

4. **挂载点**：`bootstrap/create-http-server.ts`。
   该文件已接近棘轮预算，新路由**必须**落在独立 handler 文件里，
   挂载点只加一次委派调用（见 §10）。

### 7.2 BFF 代理层（`api-server/`）

1. **新增 `api-server/src/routes/agents.ts`** — `/api/agents` 全套转发到
   `/internal/agents`，经 `resolveTrustedAuth()` 投影身份，不做任何目录状态判断。
2. **`api-server/src/routes/conversations.ts:59`** — `handleCreateConversation`
   透传 `body.agent_id`（与 `runs.ts:460` follow-up 的既有写法保持一致）。

### 7.3 前端（`frontend/`）

1. **新增 `frontend/src/shared/api/agents.ts`** — 列表与管理 API 封装。
2. **建会话流程** — Agent 选择器。**只有一个 Agent 时不渲染**，
   保持现有单 Agent 体验完全不变；多于一个才出现。
3. **会话头部** — 显示当前会话绑定的 Agent 名（配合 D2，让用户明白换 Agent 要新建会话）。
4. **新增 `frontend/src/pages/settings/AgentsPage.tsx`**（P1）— 列表 / 新建 /
   配置编辑 / 版本历史与激活。UI 上须明确「保存 = 建新版本」，
   避免用户误以为是原地修改。
5. **`A2aPage.tsx:175`** 的 Agent 下拉改为消费同一数据源，避免两套列表长期漂移。

---

## 8. 开放问题（需产品拍板）

**Agent 的可见性粒度。** `agent_definitions` 目前只有 `org_id` + `status`，
**没有 per-user / per-role ACL**。按当前 schema，org 内所有 active Agent 对全体成员
可见可用。

若后续存在「财务 Agent 只给财务组用」这类需求，需在 P1 之前决定实现形态
（独立 ACL 表，或 `config_json` 内的角色白名单）。上线后再加的代价显著更高。
本文档其余部分按「org 内全员可用」假设推进。

---

## 9. 实施顺序（每阶段单独可验证、单独提交）

### P0 — 打通目录写入与会话选择

`agent/` + `api-server/` + `frontend/`（最小）。完成后多 Agent 即可用（经 API 建 Agent）。

对应 §7.1 全部、§7.2 全部、§7.3 第 1–3 项。

同 PR 须更新：`docs/api.md`（新端点条目）、`docs/CHANGELOG.md` 的 `[Unreleased]`。

### P1 — Agent 管理界面

§7.3 第 4–5 项。前端为主。若 §8 的 ACL 决定为「要做」，其后端改动在本阶段一并落地。

同 PR 须更新：`docs/webui.md`。

### P2 — SSO 租户收口与版本可观测

1. SSO 登录把 IdP 的 org claim 写入 credential 的 `organizationId`，
   替代 `BOOTSTRAP_ORG_ID`（`browser-auth-service.ts:332`）。
   **claim 缺失时拒绝签发 token，不回落默认 org**——AGENTS.md §2 第一条 fail-closed。
2. Run 详情 / TracePanel 展示本次 Run 实际绑定的 Agent 名与 `version_no`。
   多 Agent 上线后，「为什么这次行为不一样」的第一诊断信息就是它。
3. 复核 `BFF_DEV_ACTING_ORGANIZATION_ID`（`api-server/src/config.ts:76`）
   这条开发态旁路在生产镜像中确实够不到。

> **P2 迁移陷阱：不要顺手把 `provider` 从 `'bff'` 改成 `'oidc'`。**
> `organization_external_refs` 的唯一键是 `(provider, external_subject)`，
> 而 `request-response.ts:56` 硬编码了 `'bff'`。改动它会让所有既有 org 映射失配：
> provision 会为同一批用户建出**全新的 org ULID**，历史会话、工作区、审批记录
> 在新租户下一条都查不到——表面像「数据丢了」，实际是映射换了命名空间。
>
> 建议保持 `provider = 'bff'`，只把 `external_subject` 从 `BOOTSTRAP_ORG_ID`
> 换成 IdP 的 org 标识。确需区分 provider 时，必须配一次 `external_subject` 迁移，
> 并按 §3 先在真实栈上复现「老用户登录后仍能看到自己的会话」。
>
> 若 SSO 最终改变了 org 映射语义，按 AGENTS.md §5 起新 ADR
> ——`docs/adr/0010` 已被占用，**下一个可用编号是 0011**。

---

## 10. 不可破的安全不变量（AGENTS.md §2 逐条适用）

- **跨租户一律 404**：用别的 org 的 `agent_id` 建会话、查版本、切活跃版本，
  全部返回 404，响应体不得泄漏该 Agent 是否存在。
- **fail-closed**：角色解析不出来时拒绝写操作，不回退到「默认允许」。
- **不透传浏览器身份**：`/api/agents` 的 org 作用域只能来自
  `resolveTrustedAuth()`，绝不能取请求体或浏览器头里的 org/agent 归属。
- **写入即校验**：非法 config 必须在建版本时被拒，不允许落库后在 Run 期爆炸。
- **行数棘轮**：`tests/test_repository_layout.py` 生产文件默认 ≤1000 行，
  热点文件预算只减不增。新代码按职责拆分为新文件，
  **不要撑大 `create-http-server.ts`**。

---

## 11. 验证（缺一不可）

P0 触及 `agent/` 与 `api-server/` 的运行路径，按 AGENTS.md §4
**必须重建容器并跑真实链路**；六套单测全绿不代表链路可用。

**回归测试（须先失败后通过，§3）**

- 建会话带 `agent_id` → 会话绑定到该 Agent；改 `conversation-service.ts` 之前应失败。
- 跨租户 `agent_id` → 404。
- 非 admin 调 `POST /internal/agents` → 拒绝。
- **版本不漂移**：会话建立后切换该 Agent 的 `active_version_id`，
  该会话后续 Run 仍用原版本；**新**会话才用新版本。
- 非法 config（`toolPolicy` 非对象、model 内嵌 `apiKey` 字段）建版本时即被拒。
- 不传 `agent_id` 时行为与改动前完全一致。

**六套测试 + 类型检查**

```bash
uv run pytest -q
npm test --prefix exec && npm test --prefix contract
npm test --prefix agent && npm test --prefix api-server
npm test --prefix frontend && npx tsc --noEmit -p frontend/tsconfig.json
npm --prefix agent run typecheck && npm --prefix api-server run typecheck
```

**真实链路**

```bash
docker compose build agent api-server sandbox sandbox-mcp && docker compose up -d
```

最少覆盖：登录 → 建 Agent（admin）→ 建会话并**指定该 Agent** → 一轮带工具的 run →
进程 logs/signal → 跨租户 404。

**文档同步（AGENTS.md §6）**

- `docs/api.md`：新端点有条目。
- `docs/CHANGELOG.md`：`[Unreleased]` 有用户可感知变化条目。
- `docs/webui.md`：P1 的 UI 结构变化同 PR 更新。
- `docs/STATUS.md`：仅当某行 §32 状态实际改变时，与实现同 commit 更新。

---

## 12. 交付与提交

- 一个 PR 一件事：P0 / P1 / P2 分开提。
- 用**显式路径**提交，不用 `git add -A`（AGENTS.md §7 最后一条）。
- squash 合并意味着 PR 描述与 commit message 是这批改动在 `main` 上的唯一记录，
  须写清「改了什么、为什么、怎么验证的」。

---

## 13. 实施状态（2026-09-04）

P0 与 P1 已实现并在真实栈上验证，证据见
[`../evidence/multi-agent-selection-p0-p1-2026-09-04.md`](../evidence/multi-agent-selection-p0-p1-2026-09-04.md)。
P2 未做——它依赖尚不存在的 IdP 接入，属于产品决策而非本轮开发范围。

### 落地位置

| 层 | 文件 |
|----|------|
| 目录服务 | `agent/src/application/agent-catalog-service.ts` |
| 内部路由 | `agent/src/presentation/http/agents-routes.ts`（挂载点只加一次委派） |
| 仓储补齐 | `agent-catalog-repository.ts` 的 `listVersionsByAgent` / `nextVersionNo` |
| 角色错误 | `application/errors.ts` 的 `AdminRoleRequiredError` → 403（error-mapper） |
| BFF | `api-server/src/routes/agents.ts` + `services/agent-catalog-client.ts` |
| 前端 | `shared/api/agents.ts`、`features/chat/useAgentSelection.ts`、`widgets/composer/AgentPicker.tsx`、`pages/settings/AgentsPage.tsx` |

### 与本文原计划的五处偏差

1. **选择 Agent 的入口是三个，不是一个。** §7.2.2 只写了 `POST /api/conversations`，
   但当前前端的「新建会话」并不调它——首轮消息的 `POST /api/runs` 才是真正建会话
   的那一次调用。只接 `/api/conversations` 会让选择器在主流程里完全不生效。
   现在 `POST /api/runs`（`conversation_id` 为空时）、`POST /api/conversations`、
   `POST /api/sessions/ensure`（不带 `conversation_id` 时）都接受 `agent_id`。

2. **顺带修掉一个 D2 的实现缺口。** 不带 `agent_id` 的 follow-up 过去会先解析成
   租户默认 Agent，再与会话已绑定的 Agent 比对，然后抛
   `Conversation is bound to a different agent`——也就是说，一旦有会话绑在非默认
   Agent 上（A2A 建的会话早就如此），它的下一轮就跑不起来。现在没有显式选择时
   由**会话自己**决定 Agent。`run-parent-provisioner.ts` 的
   `#conversationAgentId()` 是这一步。

3. **§7.3.5 没有改 `A2aPage.tsx` 的下拉。** 前提不成立：A2A 配置里的 `agents`
   已经来自同一张 `agent_definitions`（`admin-http-handler.ts` 直接调
   `catalog.listDefinitionsByOrg`），不存在两套列表；它额外携带的
   `agentCardUrl` / `endpoint` 只有 A2A 那一侧算得出来。改成消费 `/api/agents`
   反而要多发一次请求去补这两个字段。

4. **`agents-handler.ts` → `agents-routes.ts`。** 仓库里同层的兄弟文件都叫
   `cron-routes.ts` / `skill-routes.ts` / `auth-routes.ts`，它们导出的也都是
   `handleXxxRoute(...) => Promise<boolean>`（true = 这个请求归我处理了）。
   叫 `-handler` 会让唯一一个不守约定的文件是最新加的那个。**§7.1.2 已按真实
   文件名改写**——留着旧名字等于让 `grep agents-handler` 什么也搜不到，正是
   AGENTS.md §7「不让文档描述不存在的机制」要防的。

5. **`createAgentVersion()` → `createVersion()`，并补上 `listVersions()`。**
   类名已经是 `AgentCatalogService`，方法再带一次 `Agent` 前缀是重复；同一个类里
   `createAgent` 与 `createVersion` 的对仗也比 `createAgent` / `createAgentVersion`
   清楚。`listVersions()` 是 §7.1.1 漏列的：§7.1.2 的路由表要求
   `GET /internal/agents/:id/versions`，没有它这条路由无法实现。**§7.1.1 已按真实
   方法名与真实方法集改写。**

以上两条只改名字，不改行为：路径、HTTP 方法、member/admin 角色、返回形状都与
§7.1.2 的路由表逐条一致。

另外，§10 的行数棘轮在前端也咬到了一次：`ChatContext.tsx` 的预算钉在当前行数，
加不进 Agent 选择。按 AGENTS.md「优先按职责拆分」把模型选择抽成
`features/chat/useModelSelection.ts`，再把 Agent 选择作为同级 hook 加入。

### §11 回归项对照

| 回归项 | 位置 |
|--------|------|
| 建会话带 `agent_id` → 绑定该 Agent | `agent/tests/run-services/agent-catalog-service.unit.test.js` |
| 跨租户 `agent_id` → 404 | 同上（两个真实 org）+ `agent/tests/http/agent-catalog-http.unit.test.js` |
| 非 admin 调 `POST /internal/agents` → 拒绝 | 同上两处（服务层 403 语义 + HTTP 状态） |
| 版本不漂移 | `agent-catalog-service.unit.test.js`「切活跃版本只影响新会话」 |
| 非法 config 建版本时即被拒 | 同上「非法 config 在建版本时就被拒」 |
| 不传 `agent_id` 行为不变 | 同上「不传时行为不变」 |
