# 邮件通知场景扩展：待我审核、定时任务完成、定时任务等待处理

日期：2026-10-03。状态：**已实施，待真实链路验收**。
前置：[长任务完成邮件通知](run-completion-email.md)（已实施，阶段 3 `notify_me` 按 2026-10-03 产品决定不做）、
[交付物人工审核](agent-output-review.md)（已实施，审核结果通知 A3）。

## 0. 一句话

在已有的「Run 完成」「审核结果」两类邮件之外，补三类：**待我审核**（发给组织内的审核员）、
**定时任务完成**（按每个定时任务的设置发给任务所有者）、**定时任务等待处理**（定时任务触发的 Run
停在审批或提问时发给所有者）。同时把两个几乎相同的消费者合并成一个分发器。

不变的原则（沿用 run-completion-email.md §1）：

- 收件人只由服务端从账本推导，模型不参与、不能指定。
- 能力关闭（SMTP 配置不全）时整体关闭，不回退默认地址。
- 邮件不含产物内容、模型输出原文、工具参数；只给标题、状态、时间和前端链接，链接打开后照常登录与鉴权。
- 投递账本只记收件地址的 sha256，不落明文邮箱和正文。

## 1. 现状（2026-10-03，main @ a1d8fe3f，静态核对）

| # | 事实 | 位置 |
|---|------|------|
| F1 | Run 终态只经 `applyRunTransitionInTxn`，同事务写 `run_notification` outbox（`run.terminal.notification`），并调用 `ensureReviewTaskForTerminalRun` 建审核任务 | `agent/src/application/run-transition.ts` |
| F2 | 审核决定时写 `review_notification` outbox（payload：`reviewTaskId/orgId/requesterUserId/decision`） | `agent/src/application/review-service.ts` |
| F3 | 两个消费者 `NotificationPublisher`（`run_notification`）与 `ReviewNotificationPublisher`（`review_notification`）结构几乎相同：认领 → 解析上下文 → 占投递行 → 发信 → 记账 | `agent/src/infrastructure/notification/` |
| F4 | 投递账 `tbl_agsvc_notification_deliveries`：`UNIQUE(run_id, kind)`（`ind_agsvc_nd_a1`，同时承接 `run_id` 外键）。一个 Run 一种通知只能一行，**无法给多个审核员各发一封** | 迁移 `20260928000001_run_completion_notifications.js` |
| F5 | 用户偏好只有 `tbl_agsvc_users.notify_run_complete`（默认关）；审核结果通知也受它控制 | 同上；`review-notification-publisher.ts` 注释 |
| F6 | Run 停到 `WAITING_APPROVAL` / `WAITING_INPUT` 不经 `applyRunTransitionInTxn`，在 `FencedToolGovernanceRecorder` 的两处直接写（约 L630、L830）。该文件行数预算钉在当前值 1557，只能减不能增 | `agent/src/application/fenced-tool-governance-recorder.ts`；`tests/test_repository_layout.py` |
| F7 | 定时任务执行时经 `createRunService.execute` 建 Run，并在 `cron_job_runs` 记 `run_id` | `agent/src/application/cron-job-service.ts` |
| F8 | 审核员 = 持有 `reviewer` 角色的成员；禁止审核自己发起的任务（U8） | `member-role-repository.ts`；agent-output-review.md |
| F9 | 前端：账户设置里一个「运行完成通知」开关；定时任务页 `/schedules`；审核工作台 `/reviews`（无详情路由） | `frontend/src/widgets/settings/`、`frontend/src/pages/schedules/` |

## 2. 产品决定（2026-10-03，用户授权由实现方定默认值）

| # | 决定 |
|---|------|
| D1 | **待我审核**：审核任务建立时，发给组织内所有持有 `reviewer` 角色、状态有效、**不是发起人本人**的成员，每人一封；受个人偏好 `notify_review_pending` 控制，**默认开**。 |
| D2 | **定时任务完成**：每个定时任务一个设置 `notify_policy`：`never` / `failure`（默认）/ `always`。`failure` 指终态为 `FAILED` 或 `CANCELLED`。由定时任务触发的根 Run 进入终态时，按该设置发给任务所有者；**不受**「运行完成」开关和 `NOTIFY_MIN_RUN_DURATION_MS` 阈值影响（任务级设置是更具体的选择）。 |
| D3 | **定时任务等待处理**：由定时任务触发的 Run（含其委派子 Run，按根 Run 判定）停在 `WAITING_APPROVAL` 或 `WAITING_INPUT` 时，立即发给所有者；受个人偏好 `notify_run_waiting` 控制，**默认开**。每次停住各发一封（以审批 / 提问的 ID 去重），同一次停住不重复发。交互式（非定时）Run 不发：用户在界面前。 |
| D4 | 「运行完成」开关 `notify_run_complete` 语义不变，但**不再覆盖定时任务触发的 Run**（由 D2 接管），避免一个 Run 收两封。 |
| D5 | 审核结果通知改由独立偏好 `notify_review_result` 控制，迁移时取值 = 该用户当前的 `notify_run_complete`（保持现有行为）。新用户默认开。 |
| D6 | 子 Run 不单独发「完成」类通知（沿用现状）；D3 的等待通知按根 Run 判定是否定时任务。 |
| D7 | 不做模型主动发信工具（`notify_me`）。 |

## 3. 数据

### 3.1 迁移（新文件，命名按 UPspec / ADR 0013，用 `withPartialDdlCleanup`）

`tbl_agsvc_notification_deliveries`：

- 新增 `user_id` 已有；新增 `dedupe_key VARCHAR(191) NOT NULL`。回填：`CONCAT(kind, ':', run_id)`。
- 新唯一索引 `UNIQUE(dedupe_key)`；**先**为 `run_id` 外键建普通索引（首列 `run_id`），**再**删除旧唯一索引
  `ind_agsvc_nd_a1`——否则 MySQL 拒绝删除承接外键的索引。
- `dedupe_key` 规则：
  - `run_terminal:<runId>`（不变的语义）
  - `review_released:<runId>` / `review_rejected:<runId>`（不变）
  - `cron_terminal:<runId>`
  - `run_waiting:<runId>:<approvalId 或 interactionId>`
  - `review_pending:<reviewTaskId>:<userId>`

`tbl_agsvc_users`：新增 `notify_review_result BOOLEAN NOT NULL DEFAULT TRUE`（回填为 `notify_run_complete`）、
`notify_review_pending BOOLEAN NOT NULL DEFAULT TRUE`、`notify_run_waiting BOOLEAN NOT NULL DEFAULT TRUE`。

`cron_jobs` 表（物理名以 UPspec 迁移后的实际表名为准）：新增 `notify_policy VARCHAR(16) NOT NULL DEFAULT 'failure'`。

`down` 完整回滚上述变更。迁移要能在已有数据上执行（本地库有历史投递行）。

### 3.2 outbox

| 场景 | 聚合类型 | eventType | 写入点 | payload（**不得含 `runId` / `run_id` 键**，见 outbox-status.ts） |
|---|---|---|---|---|
| Run 终态（含定时任务） | `run_notification`（不变） | `run.terminal.notification`（不变） | `applyRunTransitionInTxn`（不变） | 不变 |
| 定时任务等待处理 | `run_notification` | `run.waiting.notification`（新） | Run 停到 WAITING_* 的同一事务 | `{ status, orgId, userId, waitKind: 'approval'|'input', waitId }` |
| 待我审核 | `review_notification` | `review.pending.notification`（新） | `ensureReviewTaskForTerminalRun` 新建任务的同一事务 | `{ reviewTaskId, orgId, requesterUserId }` |
| 审核结果 | `review_notification`（不变） | 不变 | 不变 | 不变 |

等待通知的写入**不要在 `fenced-tool-governance-recorder.ts` 里展开**：新建一个小模块（例如
`application/run-waiting-notification.ts`）导出 `enqueueRunWaitingNotificationInTxn(...)`，
recorder 里各加一行调用，并在同文件内等量压缩，保证该文件行数 ≤ 1557。

## 4. 消费者：合并为一个分发器

`agent/src/infrastructure/notification/notification-dispatcher.ts`（名字可调整）：

- 认领 `run_notification` 与 `review_notification` 两类聚合（各用现有 eligibility，或合并为一个）。
- 按 `eventType` 路由到处理器：`runTerminal`、`runWaiting`、`reviewPending`、`reviewDecided`。
- 处理器只负责「解析收件人列表 + 渲染邮件」，返回 `[{ userId, email|null, dedupeKey, kind, message }]`
  或一个结清原因（disabled / not_found / child_run / opted_out / too_short / no_email …）。
- 共享的投递流程：按 `dedupe_key` 占行 → 已是 sent/skipped/failed 直接跳过 → 发信 → 记账；
  永久错误 / 瞬时错误 / 重试用尽的处理与现有实现一致。一个 outbox 行对应多个收件人时，
  任一收件人瞬时失败 → 整行交给 outbox 退避重试；已发出的收件人因 `dedupe_key` 不会重发。
- 原两个类删除，`worker-notification.ts` 等装配点改为只起这一个分发器；对外行为（已有两类通知）不变，
  现有测试改为针对分发器，断言保持。

### 4.1 各处理器规则

- **runTerminal**：Run 查不到 → not_found；有 `parentRunId` → child_run。查 `cron_job_runs` 是否有该 `run_id`：
  - 是定时任务 Run：读该任务 `notify_policy`；`never` → 结清；`failure` 且终态是 `SUCCEEDED` → 结清；
    否则收件人 = 任务所有者，`kind=cron_terminal`。
  - 否则保持现状（`notify_run_complete` + 时长阈值，`kind=run_terminal`）。
- **runWaiting**：沿 `parentRunId` 找根 Run；根 Run 不是定时任务 → 结清（not_cron）；Run 已离开 WAITING_* → 结清
  （stale）；所有者 `notify_run_waiting=false` → opted_out；否则发信，`dedupe_key = run_waiting:<runId>:<waitId>`。
- **reviewPending**：任务查不到 → not_found；列出该 org 的 reviewer（排除发起人、排除停用成员）；
  每人按 `notify_review_pending` 和邮箱过滤，没有邮箱的记 `skipped`。
- **reviewDecided**：现有逻辑，开关改为 `notify_review_result`。

所有查询带 `org_id`，与 outbox 记录的 org/user 对不上就查不到、不发信（跨租户不泄漏）。

### 4.2 邮件内容

| 场景 | 标题 | 正文要点 | 链接 |
|---|---|---|---|
| 定时任务完成 | `【定时任务】<任务名> 运行成功/失败/已取消` | 任务名、状态、开始与结束时间 | `<PUBLIC_WEB_BASE_URL>/c/<conversationId>` |
| 定时任务等待处理 | `【定时任务】<任务名> 等待你审批/回答` | 任务名、等待类型、时间 | 同上 |
| 待我审核 | `【待审核】<会话标题或智能体名> 有新的交付物待审核` | 发起人显示名、交付物数量、时间 | `<PUBLIC_WEB_BASE_URL>/reviews` |

模板与现有 `run-completion-email.ts` / `review-notification-email.ts` 同风格（纯文本 + 简单 HTML），所有插值做 HTML 转义。

## 5. 接口

### 5.1 账户资料 `GET/PATCH /api/auth/profile`（BFF 透传 agent）

响应新增布尔字段：`notify_review_result`、`notify_review_pending`、`notify_run_waiting`；`editable` 名单同步加入。
PATCH 接受这三个字段（类型不是布尔 → 422 `AUTH_INPUT_INVALID`，字段级错误，与 `notify_run_complete` 一致）。
打开任一通知时的已有校验（部署未配置邮件 → `NOTIFICATION_UNAVAILABLE`；没有邮箱 → `NOTIFY_EMAIL_REQUIRED`）
对四个开关一视同仁。单独清空邮箱时只看 `notify_run_complete`：其余三个开关默认开也不拦清空，
没有邮箱时照常保存，投递时记 skipped（`no_email`）。

### 5.2 定时任务 `POST/PATCH /api/cron-jobs…`（以现有路由为准）

请求与响应新增 `notify_policy`：`'never' | 'failure' | 'always'`，缺省 `failure`；其他值 → 400
`VALIDATION_ERROR`（字段级）。列表与详情都返回该字段。

## 6. 前端

- 账户设置：原一个开关改为「邮件通知」小节，四个开关：运行完成、审核结果、定时任务等待处理、待我审核
  （最后一个只对持有 reviewer 角色的用户显示）。复用现有的不可用禁用态、错误映射与草稿逻辑。
- 定时任务新建 / 编辑表单：新增「完成后通知」下拉：不通知 / 仅失败时（默认）/ 每次。
- 列表或卡片上不必展示该字段。

## 7. 验收

- 单测：每个处理器的结清分支与发送分支；`failure` 策略 × 三种终态；定时任务 Run 不再按 `notify_run_complete` 发；
  多审核员各一封、发起人本人不收、无邮箱 skipped；同一 outbox 行重认领不重发；等待通知同一 waitId 只发一次、
  不同 waitId 各发一次；跨 org 错配不发信。拒绝对照与成功对照都要有。
- 迁移：在有历史投递行的库上 up → down → up。
- 真实链路（compose + mailpit）：定时任务成功（policy=always）/ 失败（policy=failure）各一次；定时任务触发需审批的工具，
  收到等待邮件；审核型智能体产生交付物，reviewer 收到待审核邮件、发起人不收；worker 重启后不重发。
- 文档：`api.md`（两处接口字段）、`webui.md`（设置与定时任务表单）、`deployment.md`（如有新变量）、本文状态、
  `run-completion-email.md` 指向本文、`CHANGELOG.md` `[Unreleased]`。

## 8. 实施记录（2026-10-03）

与上文设计稿的偏差（以实现为准）：

- 新增结清原因：`policy_skipped`（`notify_policy=never`，或 `failure` 下终态非 `FAILED`/`CANCELLED`）、
  `not_cron`（等待通知的根 Run 不是定时任务触发）、`stale`（处理时 Run 已离开 `WAITING_*`）。
- 未知 `notify_policy` 值 fail-closed：只认 `never` / `always`，其余一律按 `failure` 处理
  （不会按 `always` 全发；API 层另用 `requireChoice` 拒绝非法值）。
- 邮件只有纯文本：分发器经 `mailer.send({ to, subject, text })` 发信，不拼 HTML（§4.2 的「简单 HTML」未做）。
- 账户资料开关类型错误：四个开关一律 422 `AUTH_INPUT_INVALID`，消息 `<field> must be a boolean`
  （§5.1 原定的新开关 400 `VALIDATION_ERROR` 已废弃，与 `notify_run_complete` 一致）。
- 清空邮箱只看 `notify_run_complete`：其余三个开关默认开也不拦清空，没有邮箱时照常保存，
  投递时记 skipped（`no_email`）；打开任一开关时的 `NOTIFICATION_UNAVAILABLE` /
  `NOTIFY_EMAIL_REQUIRED` 校验不变。
