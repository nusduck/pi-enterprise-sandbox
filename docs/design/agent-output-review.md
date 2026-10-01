# 智能体交付物人工审核（审核后交付）

日期：2026-10-01。状态：**已实施**（P1–P7 全部落地，真实链路验收见
[evidence/2026-10-01-agent-output-review-live-chain.md](../evidence/2026-10-01-agent-output-review-live-chain.md)）。
锁定决策见 [ADR 0016](../adr/0016-agent-output-human-review.md)（**Accepted**）。依赖
[RBAC 一期](rbac-roles.md)（`reviewer` 角色，已实施）。

需求来源（2026-09-30）：案例分析智能体的**交付物**不能直接给发起人，要先交第三方审核员审阅、
可以修改，确认后才交付。用户已确认的产品决定：

| # | 决定 |
|---|------|
| U1 | 审核员由 admin 在「成员与角色」页授予 `reviewer`（RBAC 一期）；组织内共用一个审核池 |
| U2 | **审核对象是交付物（artifact）**，不是聊天文字。聊天文字照常实时显示给发起人 |
| U3 | 审核员可以修改交付物后通过；驳回时填写反馈并终止，由用户重新发起；一期不做「退回重跑」 |
| U4 | 追问照常进行。追问的回答不审核，除非它又产生了新的交付物 |
| U5 | 审核员要能看到用户的提问和用户上传的文件 |
| U6 | 审核结束后，审核员保留只读权限 |
| U7 | admin 运行控制台可以看到未审核的交付物（不对 admin 隔离） |
| U8 | 禁止审核自己发起的任务 |
| U9 | 接受 §11 的两条边界：review 会话里发起人看不到工作区文件；聊天文字不审核，交付物内容可能经文字泄露 |

---

## 0. 一句话

智能体可以按版本配置「交付物审核」。这类会话里，智能体用 `submit_artifact` 提交的产物先处于
**待审（held）**，发起人看不到也下载不了；Run 结束时，本轮所有待审产物汇成一条审核任务。审核员
通过（可以先上传修订版替换）后，产物**放行（released）**，出现在原会话和产物库里；驳回时发起人
看到反馈。聊天文字、工具过程、审批、提问一律照旧。

核心不变量：

> **交付物在审核通过之前不对发起人可见。** 在 review 会话里，发起人能拿到的正式交付物
> 只有已放行的版本；得到交付物文件的其他途径（直接读工作区里的源文件）同样关闭。

## 1. 已核实的现状（2026-10-01，静态阅读，main @ a7a593f0）

| # | 事实 | 位置 |
|---|------|------|
| F1 | 正式交付只有一条路：模型调用 `submit_artifact` → agent 经 HMAC 内部面调用 exec `/internal/v1/artifacts/submit` → exec 把工作区文件复制成不可变 blob，写入 `tbl_agsvc_exec_artifacts`（owner = org/user，带 `session_id`/`workspace_id`）。 | `agent/src/runtime/providers/submit-artifact.ts`；`docs/artifact-module.md`「Frozen delivery contract」；迁移 `20260904000001_exec_artifacts_datasets.js` |
| F2 | 工具完成时，agent 在**同一事务**里把 `submit_artifact` 的结果记成 `artifact.ready` 运行事件（含 `artifactId/name/mimeType/size/sha256`），前端据此显示交付卡片。 | `agent/src/application/fenced-tool-governance-recorder.ts`（约 1244 行） |
| F3 | 发起人拿交付物的途径：会话产物列表与下载 `/sessions/{sid}/artifacts[/{aid}/download]`（经 `requireOwnedSession`）；跨会话产物库 `GET /artifacts` 与跨会话导入（**不经过** `requireOwnedSession`，BFF 也不经过 agent）。 | `exec/src/http/public/artifacts.ts`；`api-server/src/routes/artifacts.ts` |
| F4 | 发起人还能直接读工作区源文件：`/sessions/{sid}/files`、`files/read`、`files/preview`、`files/download`、`files/ls|find|grep`；进程日志、数据集同理。都经过 `requireOwnedSession`。 | `exec/src/http/public/{files,processes,datasets}.ts`、`ownership.ts` |
| F5 | 会话的 AgentSession 在创建时绑定 `agent_version_id`，复用时校验同一 agent；**同一会话不能换智能体或漂移到新版本**。 | `agent/src/application/parent/run-parent-provisioner.ts`（约 510–565 行） |
| F6 | exec 目前**没有**工作区元数据表，工作区只是目录；exec 的表迁移都在 agent 的迁移目录。 | `exec/src`、`agent/src/infrastructure/mysql/migrations/` |
| F7 | 本轮附件以 `attachment_id` 出现在触发消息里；用户消息落在 `messages`（`role=user`）。 | `agent/src/application/dsh-run-input.ts` `attachmentsFromTriggeringMessage` |
| F8 | Run 状态机是冻结的 plan §10（「no extra edges」）。 | `agent/src/domain/run/run-status.ts` |
| F9 | plan §8.7 冻结的 `message_type` 只有 `text/multimodal/tool_call/tool_result/status/error`。 | `docs/plan.md` §8.7 |

## 2. 配置：交付策略

AgentVersion 配置新增可选字段：

```json
{ "deliveryPolicy": { "mode": "review" } }
```

- `mode`：`direct`（默认，省略即此值，现有行为）或 `review`。未知值 → `CONFIG_INVALID`。
- 因为会话绑定版本（F5），**同一会话的策略终生不变**。admin 把智能体切到新版本，既有会话仍按原策略执行。
- review 模式一期与以下能力**互斥，保存配置时拒绝**：
  - 委派（`delegation`）：子 Agent 在自己的工作区提交产物，一期不处理；
  - A2A 暴露：外部调用方期望直接拿到产物。
- 定时任务**允许**：定时 Run 产生的产物同样进入审核，放行后发起人在会话和产物库里看到。
- 下文把「会话绑定的版本为 review 模式」简称 **review 会话**。

## 3. 交付物的可见性（exec 负责）

exec 是产物和工作区字节的权威，而产物库路径根本不经过 agent（F3）。所以「待审」必须是 exec
自己记录并执行的事实，不能由 BFF 或 agent 在外面拦。

### 3.1 工作区策略

- 新表 `tbl_agsvc_exec_workspace_policies`：`workspace_id` PK、`org_id`、`delivery`（`review`）、`created_at`。
  迁移放在 agent 迁移目录（F6）。
- agent 在确保会话时（`POST /internal/v1/sessions/ensure`，HMAC 内部面）按绑定版本的策略传入
  `delivery: "review"`，exec 以 `INSERT IGNORE` 写入。**只能设置、不能撤销**，没有撤销接口；
  策略在会话创建时就固定（F5），所以不需要撤销。契约字段加在 `contract/`。

### 3.2 产物的状态

`tbl_agsvc_exec_artifacts` 新增：

- `visibility`：`released`（默认，存量行即此值）| `held` | `withdrawn`；
- `revision_of` NULL：审核员上传的修订版指向原产物；
- `created_by_kind`：`agent` | `reviewer`。

规则：

- review 工作区里提交的产物一律写为 `held`；direct 工作区不变（`released`）。
- 状态只能从 `held` 变为 `released` 或 `withdrawn`，终态不可再变。由 agent 经 HMAC 内部面调用
  （§5.3），exec 在一个事务里完成一组产物的状态变更。

### 3.3 发起人一侧的执行点

| # | 途径 | review 会话中的行为 |
|---|------|--------------------|
| E1 | 会话产物列表 | 只列 `released` |
| E2 | 会话产物下载、预览 | 非 `released` → 与「不存在」同一个 404 |
| E3 | 产物库 `GET /artifacts` | 只列 `released` |
| E4 | 跨会话导入 | 源产物非 `released` → 404 |
| E5 | 工作区源文件：列表、读取、预览、下载、`ls/find/grep` | 404。不关的话，发起人能直接下载 `submit_artifact` 的源文件，绕过审核 |
| E6 | 进程日志、数据集读取 | 404（同上，可以 `cat` 出文件内容） |
| E7 | 上传 | **照常允许**：发起人要能提供材料 |

- E1–E4 按产物的 `visibility` 判断，E5、E6 按工作区策略判断，都在 exec 公共面上执行
  （`requireOwnedSession` 增加「读/上传」参数，产物库与导入两处单独接入）。
- 策略或状态查询失败时 fail-closed：读操作返回 503，不能当作放行。
- 内部面 `/internal/v1/*`（模型工具）不受影响，智能体照常读写工作区。

## 4. 聊天一侧（agent 负责）

聊天文字、思考、工具调用、审批、提问**全部照旧**（U2、U4）。agent 只改和交付物有关的三处：

| # | 位置 | review 会话中的行为 |
|---|------|--------------------|
| A1 | `artifact.ready` 事件（F2） | 事件类型保持不变，负载增加 `review_status: "pending"`。前端据此显示「已提交审核」卡片，不显示下载按钮（即使点了，exec 也会 404） |
| A2 | 放行与驳回 | 发布 `artifact.released` / `review.rejected` 运行事件和一条会话消息（§5.3），SSE 实时刷新 |
| A3 | Run 终态邮件 | 不变（它只报告 Run 结束）；审核结果另发 `review_released` / `review_rejected` 通知（复用投递账本，`kind` 列本来就是预留的） |

## 5. 审核账本与流程

### 5.1 表（agent MySQL，命名按 UPspec / ADR 0013）

**`tbl_agsvc_review_tasks`**：一行对应「一个 Run 提交的一组待审产物」。

| 列 | 说明 |
|----|------|
| `review_task_id` CHAR(26) PK | |
| `org_id`、`requester_user_id` | 发起人 |
| `conversation_id`、`agent_session_id`、`run_id` | `UNIQUE(run_id)` |
| `agent_id`、`agent_version_id`、`run_status` | 审计用：当时的配置，以及 Run 以什么状态结束 |
| `status` | 见 5.2 |
| `assignee_user_id` NULL、`claimed_at` | |
| `revision` INT | 乐观并发版本号，每次改动 +1 |
| `feedback` TEXT NULL | 驳回反馈（必填）或通过备注（可选） |
| `decided_by`、`decided_at`、`created_at`、`updated_at` | |

索引：`(org_id, status, created_at)` 用于审核池，`(org_id, assignee_user_id, status)` 用于「我领取的」。

**`tbl_agsvc_review_items`**：任务里的每件交付物。`(review_task_id, item_no)` PK；
`original_artifact_id`（智能体提交的）；`current_artifact_id`（最新修订版，初始等于原件）；
`name`、`mime_type`、`size`、`sha256`（跟随 current）。修订历史就是 exec 里的 `revision_of` 链，
永不覆盖原件。

**`tbl_agsvc_review_materials`**：审核材料快照（U5）。`(review_task_id, material_id)`；`attachment_id`；
`filename`、`mime_type`、`size`；`snapshot_artifact_id`（exec 不可变快照，`visibility=withdrawn`，
永远不对发起人可见，只供审核员读取）。

**`tbl_agsvc_review_events`**：只追加审计。`created / claimed / released_claim / revised / approved / rejected`，
记 actor、item、前后 artifact id 和时间。与状态变更在同一事务里写入。

### 5.2 状态机

```text
  Run 进入终态，且本轮有 held 产物
                 │ 同一事务建任务、items、材料快照记录
                 ▼
   ┌────────► PENDING ──claim──► IN_REVIEW ──approve──► APPROVED（终态，产物放行）
   │                               │  │
   └─────────── release ───────────┘  └──reject(feedback)──► REJECTED（终态，产物撤回）
                        （revise 只替换某件产物的 current，状态不变）
```

- **建任务的时机**：Run 进入**任意终态**时，只要本轮有 `held` 产物就建任务，任务上记录 `run_status`。
  失败或取消的 Run 也可能已经提交了正式交付物，不能让它们永远悬空；是否放行由审核员判断。
  本轮没有产物就不建任务，这就是「追问的回答不审核」（U4）。
- **领取**：条件更新 `WHERE status='PENDING'`，影响 0 行 → 409 `REVIEW_ALREADY_CLAIMED`。
- **修订**（U3）：领取人对某件产物上传一个修订文件，经 agent → exec 内部面生成新产物
  （`held`、`revision_of` 指向上一版、`created_by_kind=reviewer`），更新该 item 的 `current_artifact_id`。
  请求带 `base_revision`，不一致 → 409 `REVIEW_VERSION_CONFLICT`。一期修订就是「下载 → 本地修改 → 上传替换」，
  不做在线编辑。
- **释放领取**：领取人或 admin 可以把任务放回 `PENDING`，admin 用于改派。一期不做自动超时。
- **职责分离**（U8）：发起人本人即使持有 `reviewer`，领取自己的任务 → 403 `REVIEW_SELF_FORBIDDEN`。

### 5.3 通过与驳回

**通过**：

1. agent 事务：任务 → `APPROVED`，写审计；在原会话追加一条消息：`role=assistant`、`message_type=text`
   （F9 的冻结枚举内），`content_json = { kind: "review_released", review_task_id, artifacts: [{artifact_id, name, mime_type, size, revised}] }`；
   追加 `artifact.released` 运行事件（挂在原 Run 上）；写入 outbox：exec 放行和 `review_released` 通知。
2. outbox 消费者调用 exec 内部面：各 item 的 `current_artifact_id` → `released`，同一任务里其他版本
   （被替换的原件和中间修订）→ `withdrawn`。exec 一个事务，幂等。
3. 如果有修订：exec 同时把修订版导入工作区的 `审核版/` 目录（沿用 artifact import）。这样模型在追问中改报告时，
   基于的是审核员改过的版本（§5.4）。

放行走 outbox 而不是在 agent 事务里直接调用 exec：跨服务调用不能放进数据库事务里。outbox 是至少一次投递，
exec 侧幂等，所以不会出现「任务已通过、产物却永远不放行」。放行完成前，前端卡片显示「已通过，正在发布」。

**驳回**：任务 → `REJECTED`，追加 `role=system`、`message_type=status`、
`content_json = { kind: "review_rejected", review_task_id, feedback }` 的消息，发布 `review.rejected` 事件；
经 outbox 把本任务的全部版本 → `withdrawn`，并发送 `review_rejected` 通知。发起人重新发起（U3）。

### 5.4 追问时的模型上下文

聊天文字不经过审核，模型上下文本来就和发起人看到的一致。只有交付物的决定需要告诉模型：

- 下一个 Run 派生提示词时，对尚未注入的已决任务，在触发消息前**前置一段平台文本**，每个任务只注入一次
  （任务行记录 `context_injected_run_id`）：
  - 已通过：「以下交付物经人工审核后已交付给用户：… 其中 X 由审核员修订，修订版在工作区 `审核版/X`，后续修改以它为准。」
  - 已驳回：「以下交付物未通过人工审核，没有交付给用户。审核反馈：…」
- 这段文本由服务端生成，用户不能伪造，也不会显示在会话界面中。

## 6. 审核员工作面

### 6.1 访问规则

- 需要 `reviewer` 角色（RBAC `hasRole`）；非 reviewer → 403 `REVIEWER_REQUIRED`。
- 作用域是本组织：其他组织的任务与不存在的任务返回同一个 404。
- 组织内的 reviewer 都能看到审核池与历史任务（U6 按池模型实现）。修订和决定只能由当前领取人执行。
- 审核员**不获得**发起人工作区的访问权，只能看到：
  - 任务元数据：发起人显示名、智能体名称与版本、时间、Run 结束状态；
  - **用户提问**（U5）：本会话截至该 Run 的全部 `role=user` 消息文字；
  - **用户上传的文件**（U5）：同一范围内全部附件的快照（§6.2）；
  - 待审交付物的全部版本，以及审计事件。
- 聊天里智能体的文字回复一期不给审核员看（U5 没有要求）。需要时二期加入，只读。

### 6.2 附件快照

建任务时，agent 对本会话截至该 Run 的全部附件（F7）调用 exec 新增的内部端点，复制成不可变快照
（`withdrawn`，永远不对发起人可见），记入 `review_materials`。审核员下载时经 BFF → agent（校验 reviewer 与组织）
→ exec 内部窄端点。

- 快照的意义：发起人之后删改工作区文件，审核依据不变，审计可复现。
- exec 新增的内部端点（快照、按 id 读取、修订上传、状态变更）只接受 agent 的 HMAC 凭据，
  不接受 MCP 窄桥凭据（与 AGENTS.md §1 对 `sandbox-mcp` 的边界一致）。
- 快照失败：任务照常建立，材料标记为不可用，审核员界面明确提示，不静默缺失。

## 7. API

发起人一侧没有新增端点：审核状态通过既有的会话事件和 SSE 获得（§4、§5.3）；放行后的产物经既有的产物下载和产物库获取。

审核员一侧（BFF `/api/reviews*` → agent `/internal/reviews*`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/reviews?status=&mine=&cursor=&limit=` | 审核池与历史 |
| GET | `/api/reviews/{id}` | 详情：元数据、用户提问、材料列表、交付物及其版本链、审计事件 |
| GET | `/api/reviews/{id}/materials/{mid}/download` | 附件快照（流式、有超时） |
| GET | `/api/reviews/{id}/artifacts/{aid}/download` | 交付物的任一版本（限本任务内的 artifact） |
| POST | `/api/reviews/{id}/claim` | 领取 |
| POST | `/api/reviews/{id}/release` | 释放领取（领取人或 admin） |
| POST | `/api/reviews/{id}/items/{no}/revisions?base_revision=` | 上传修订文件（流式 body，大小上限与产物一致） |
| POST | `/api/reviews/{id}/approve` | 通过：`{ base_revision, note? }` |
| POST | `/api/reviews/{id}/reject` | 驳回：`{ base_revision, feedback }`，`feedback` 必填 |

错误码：403 `REVIEWER_REQUIRED` / `REVIEW_SELF_FORBIDDEN` / `REVIEW_NOT_ASSIGNEE`；404 `NOT_FOUND`；
409 `REVIEW_ALREADY_CLAIMED` / `REVIEW_VERSION_CONFLICT` / `REVIEW_ALREADY_DECIDED`；
422 `REVIEW_FEEDBACK_REQUIRED` / `REVIEW_FILE_INVALID`。

## 8. 前端

- **智能体配置页**：「交付策略」单选，可选「直接交付」或「交付物需人工审核」。选 review 时提示一期限制
  （不可用于 A2A、委派）。
- **发起人聊天界面**（review 会话）：
  - 聊天文字、工具过程照常显示。
  - 交付卡片分三种状态：「已提交审核」（没有下载按钮）；「已交付」（可以下载，修订过的标注「经审核员修订」）；
    「未通过审核」（显示反馈）。
  - 工作区文件面板在 review 会话中隐藏（服务端本来就会 404，这里只是不引导用户去点），并说明原因。
- **审核工作台**（`/reviews`，持有 `reviewer` 时出现在主导航中，**不放在 admin 控制台里**，因为 reviewer 不一定是 admin）：
  - 列表：待领取、我领取的、历史，可按状态筛选。
  - 详情：用户提问（按时间排列）、上传的文件（可下载）、交付物列表（每件显示当前版本，可下载任一历史版本、上传修订）、
    审计时间线。
  - 操作：领取、释放、上传修订、通过、驳回（驳回弹窗要求填写反馈）。版本冲突时提示「任务已被更新」并刷新，
    已选择的待上传文件不丢失。
  - 列表加载失败要显示错误态，不能渲染成「没有待审任务」。

## 9. 实施阶段

每个阶段都要先让回归测试失败再修复（AGENTS.md §3），阶段结束时跑受影响的检查。

1. **P1 配置与策略传递**：`deliveryPolicy` 校验（含互斥）；`sessions/ensure` 契约字段（`contract/`）；
   exec `workspace_policies` 表。
2. **P2 exec 可见性**：产物 `visibility/revision_of/created_by_kind` 列（存量默认 `released`）；
   E1–E7 执行点与 fail-closed；状态变更、快照、修订上传、按 id 读取四个内部端点。
   改了 `exec/`，`sandbox` 与 `sandbox-mcp` 两个镜像都要重建。
3. **P3 审核账本**：迁移（四张表）；Run 终态建任务（与终态同一事务）；A1 的事件负载。
4. **P4 审核员 API**：§7 全部端点。
5. **P5 通过与驳回**：消息、事件、outbox 放行与撤回、通知、修订版导入工作区、§5.4 上下文注入。
6. **P6 前端**：§8。
7. **P7 验收**：六套测试、类型检查、前端 build；重建 `agent agent-worker api-server sandbox sandbox-mcp frontend`，
   跑 §10 的真实链路；同步 `api.md`、`architecture.md`、`webui.md`、`artifact-module.md`、CHANGELOG；
   把本文状态改为已实施，并附上证据链接。

**实施记录（2026-10-01）**：P1–P2 = `048eac18`，P3 = `0e30077f` + `717f1d24`，P4 = `01cdd134`，
P5 = `68a27731`，P6 = `80341922`，P7 = 本次提交。§10 逐条结果与三处**验收期才发现**的问题
（exec 明文 baseUrl 漏传 `allowInsecureHttp` 导致 agent 进程起不来；审核 outbox 消费者拿到
未绑定的 `createRepositories` 卡在 PUBLISHING；另一个运行栈的旧镜像 worker 抢走队列任务）
记在证据文档里——前两个是代码缺陷，第三个是环境陷阱。

## 10. 验收清单（真实链路、真实模型）

准备：一个 review 智能体（system prompt 要求把分析报告写成文件并用 `submit_artifact` 交付），
发起人 U，审核员 R，第二审核员 R2，另一个组织的审核员 X，admin A；再准备一个 direct 智能体作正向对照。

1. U 上传材料并发起分析：聊天文字和工具过程正常显示；交付卡片显示「已提交审核」，没有下载按钮。
2. 交付物拿不到（逐条验证）：会话产物下载、产物库、以该产物为源的导入、工作区源文件下载与 `grep`、进程日志，
   全部 404。direct 会话里做同样的请求都成功（正向对照）。
3. R 领取后 R2 领取 → 409；U 自己持有 reviewer 时领取自己的任务 → 403；X 读取任务 → 404；非 reviewer → 403。
4. R 看到 U 的全部提问，下载的附件快照与 U 的上传一致；U 在工作区删除原文件后，快照仍能下载。
5. R 上传修订版；R 用旧的 `base_revision` 再上传 → 409；R 通过：U 的会话出现「已交付」卡片，下载到的是修订版，
   产物库里有它，原件仍然 404；邮件（若开启）此时发出。
6. U 追问一个不产生文件的问题：不建新任务，回答直接显示。U 要求「把报告第二节改一下」：新 Run 的提示词里有
   §5.4 的注入文本，模型基于 `审核版/` 修改；新产物产生新任务，R 驳回；U 看到反馈卡片，该产物始终 404。
7. 一个在提交产物后被 U 取消的 Run：仍然建了任务，`run_status=CANCELLED`。
8. A 在运行控制台能看到待审产物的事件（U7）。
9. exec fail-closed：临时让策略查询失败，U 的读请求 → 503，而不是放行。
10. AGENTS.md §4 最少链路（direct 会话）：登录 → 建会话 → 带工具的 Run → 进程 logs/signal → 跨租户 404。

## 11. 已知边界（需要知道，不是缺陷）

- **聊天文字不审核，所以交付物的内容可能经文字泄露。** 模型可能在回复里复述报告内容，或者用 `cat` 把文件内容
  打到工具输出里，发起人都能实时看到。审核管住的是「正式交付物的发布」，不是内容保密。如果需要内容层面的保密，
  就要回到隐藏文字和工具输出的方案（即本设计的上一版），代价是聊天体验变成只有「处理中」。
  一期的缓解措施：review 智能体的 system prompt 要求结论只写进交付文件，聊天中只说明进度。
- **review 会话里发起人看不到工作区文件。** 这是 E5 的代价：不关工作区就能绕过审核直接下载源文件。
  自己上传的文件，发起人在自己的消息里仍能看到文件名，但不能再从工作区下载。

## 12. 本期不做

退回重跑；在线编辑交付物；多人会签或串行多级审核；按智能体指定审核员名单；领取超时自动释放；
审核员查看智能体的文字回复；review 模式用于 A2A 或委派。

## 13. 实施交接

- 分支：`feat/agent-output-review`（基于含 RBAC 的 `main`）。一个 PR 完成 P1–P7；若体量过大，
  可按「P1–P2（exec 可见性）」「P3–P7」拆成两个叠放的 PR，前者单独可验收（review 工作区产物 404）。
- 动手前重新核对 §1 的文件与行为（本文是 2026-10-01 的静态阅读），发现偏差先修正本文。
- 这是跨 `contract/`、`exec/`、`agent/`、`api-server/`、`frontend/` 的改动：必须按 AGENTS.md §4 重建
  `agent agent-worker api-server sandbox sandbox-mcp frontend`，跑 §10 的真实链路；只跑单测不算完成。
  改 `exec/` 后跑 `exec/test/mcp-import-boundary.test.ts`，确认 facade 没有带进新的执行面代码。
- 同步文档：`api.md`（§7 接口与 `REVIEW_*` 错误码）、`architecture.md`（产物可见性与审核账本）、
  `artifact-module.md`（`visibility` 与冻结交付契约的关系）、`webui.md`（交付卡片三态与审核工作台）、
  CHANGELOG `[Unreleased]`。实施完成后把本文与 ADR 0016 的状态改为已实施 / Accepted，并附证据链接。
- 行数棘轮：`fenced-tool-governance-recorder.ts`、`dsh-run-executor.ts`、`exec/src/http/public/artifacts.ts`
  等热点文件不能加行，新逻辑按职责拆到新模块。
