# 长任务完成邮件通知（设计与 TODO）

状态：**已实施**（2026-09-28，阶段 0–2、4–6；阶段 3 `notify_me` 工具未做）。真实链路证据见
[evidence/run-completion-email-live-2026-09-28.md](../evidence/run-completion-email-live-2026-09-28.md)。部署变量见
[deployment.md](../deployment.md)「长任务完成邮件通知」，接口见 [api.md](../api.md) `/api/auth/profile`。

决策（2026-09-28）：T2 开关放在**用户偏好**（`users.notify_run_complete`，默认关）+ 部署级时长阈值
`NOTIFY_MIN_RUN_DURATION_MS`（从 `runs.created_at` 起算，含排队时间）；T3 **直连 SMTP**（nodemailer，
口令只从 `SMTP_PASSWORD_FILE` 读）。未新增 ADR：没有与 plan 冲突或需锁定的跨模块约束。

---

## 0. 一句话

Run 进入终态后给发起人发邮件。**收件人由服务端从账本推导（`runs.user_id → users.email`），
模型不参与、也不能指定收件人**。实现为 agent-worker 内新增的 outbox 消费者，不做成 MCP。

## 1. 为什么不是「MCP + 模型传 user_id」

1. **身份可伪造**：模型可控参数不可信（prompt 注入），收件人一旦是参数，就能给任意人/跨租户发信。
2. **终态不一定轮得到模型**：失败、取消、worker 崩溃恢复时模型没有下一轮，而这些恰是最该通知的场景。
   通知必须挂在 Run 状态机终态上。
3. **MCP 接线无 per-run 身份**：`agent/src/runtime/plugins/mcp-entries.ts` 的 headers 来自
   `headerRefs`（环境变量），按 server 静态配置。
4. **数据边界**：`users.email`（plan §8.2）在 agent 的 MySQL 账本，外置 MCP 查邮箱要么新开查人接口，
   要么越界连库。

## 2. 已核实的事实（2026-09-25，静态阅读）

```bash
# Run 终态迁移与 domain_outbox 同事务写入
rg -n "append domain_outbox" agent/src/application/fenced-run-event-recorder.ts
# 终态事件名：成功是 run.completed（不是 run.succeeded）
sed -n 1355,1363p agent/src/application/execute-run-service.ts
# OutboxPublisher 按 eligibility 只认领匹配行，其余留给别的 publisher
sed -n 1,20p agent/src/infrastructure/outbox/outbox-publisher.ts
# runs 行带 user_id；users 表有 email 列（可空）
rg -n "userId: String\(row.user_id\)" agent/src/infrastructure/mysql/row-mappers.ts
# 工具调用 ALS 不带用户；按 Run 的租户在 run-services 的 ALS 里
rg -n "tenant" agent/src/runtime/providers/run-services.ts
```

**T0 结论（2026-09-28，静态核对 + 单测）**：Run 状态只有两种写法——`applyRunTransitionInTxn`（CAS + RunEvent
+ outbox 同事务）与三处直接 `updateStatusIf`。后者只写非终态（`fenced-tool-governance-recorder` 的
`WAITING_APPROVAL` / `WAITING_INPUT`，`run-queued-projection` 的 `QUEUED`）；Run 创建一律是 `ACCEPTED`。
因此所有终态都经过 `applyRunTransitionInTxn`，判别按**目标状态**（`isTerminalRunStatus(to)`），不按事件名：

| 终态路径 | 调用点 | 目标状态 |
|---|---|---|
| 执行完成 / 失败 / 取消收尾 | `execute-run-service.ts`（`opts.to`） | SUCCEEDED / FAILED / CANCELLED |
| 挂起在审批时取消 | `parked-approval-cancel.ts` | CANCELLED |
| 挂起在用户输入时取消 | `parked-interaction-cancel.ts` | CANCELLED |
| 恢复扫描：取消中收尾、已完成补记 | `run-recovery-service.ts` | CANCELLED / SUCCEEDED |

T8 走的是「终态时额外插入一行」：RunEventStream publisher 按 `aggregate_type='run'` **或** payload 带 `runId`
认领，共用同一行会被它抢走。新行 `aggregate_type='run_notification'`，run id 放在 `aggregate_id`，payload 只有
`{ status, orgId, userId }`。

## 3. 目标形态

```
Run 终态 ──同事务──▶ domain_outbox
                         │
     agent-worker: NotificationPublisher（独立 eligibility，只认终态）
                         │
         runId → runs.user_id → users.email（账本解析，不经模型）
                         │
         notification_deliveries 唯一键去重（run_id, kind）
                         │
         SMTP / 企业邮件网关（带超时；缺配置 = 能力关闭）
```

## 4. TODO（2026-09-28 实施状态）

已完成：T0–T3、T5–T12、T14–T19。T4 未新增 ADR（见文首）。T13 属可选阶段 3，未做。
与原计划的差异：T17 的 mailpit 没有写进 Compose（写进去要改端口发布与生产 overlay 的拓扑测试），改为
`docker run` 接入后端内部网络，做法写在 development.md。

### 阶段 0：核实与决策

- [ ] **T0** 枚举所有 Run 终态写入点（`execute-run-service`、`run-recovery-service`、
      `cancel-run-service`、`parked-*-cancel`、租约/超时路径），确认每条都写 outbox，
      并确定终态判别规则（事件名 vs payload 目标状态）。补一张「终态路径 → outbox 事件」表。
- [ ] **T1** 确认 `users.email` 在 SSO / 外部身份同步里的实际填充率；空邮箱的处理（跳过 + 记录）。
- [ ] **T2** 决定通知开关粒度：Run 级 `notifyOnComplete`、会话级、用户偏好级，或时长阈值
      （如运行 ≥ N 分钟才发）。决定是否默认开启（建议默认关）。
- [ ] **T3** 决定发信通道：直连 SMTP 还是公司统一通知平台（HTTP）。后者同样由 worker 以服务间
      凭据调用，**不暴露为模型工具**。
- [ ] **T4** 若结论需要锁定为架构决策，新增 ADR（先检查 `docs/adr/` 未占用编号）。

### 阶段 1：存储与配置

- [ ] **T5** 迁移：`notification_deliveries(delivery_id, org_id, run_id, kind, recipient_hash,
      status, attempts, last_error, created_at, sent_at)`，`UNIQUE(run_id, kind)`。
      不落明文邮箱以外的敏感内容；错误信息走现有 `sanitize-error`。
- [ ] **T6** 开关字段的落点（按 T2）：Run 创建 DTO / 会话设置 / 用户偏好，服务端校验，
      未知字段显式报错。
- [ ] **T7** 环境变量：`NOTIFY_EMAIL_ENABLED`、`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/
      `SMTP_PASSWORD_FILE`（或网关 URL + token）、`NOTIFY_EMAIL_FROM`、`NOTIFY_EMAIL_TIMEOUT_MS`、
      `NOTIFY_MIN_RUN_DURATION_MS`、`PUBLIC_WEB_BASE_URL`（邮件内链接）。
      **fail-closed**：启用但配置不全 → 启动时关闭能力并打日志，不回退默认地址。

### 阶段 2：消费者

- [ ] **T8** `agent/src/infrastructure/notification/`：`NotificationPublisher`，复用
      `OutboxRepository.claimBatch` + 独立 `eligibility`；与 RunEventStream publisher 互不阻塞。
      注意 outbox 行只能被一个 publisher 认领并标记——若终态行已被 RunEventStream publisher
      认领，需评估改为「终态时额外插入一行 `notification.requested` outbox」而不是共用同一行
      （**T0 结论决定这里走哪条**）。
- [ ] **T9** 收件人解析：`runs.user_id → users.email`，带 org scope；子 Run（委派/子 Agent）
      不单独通知，只通知根 Run。
- [ ] **T10** 发送器：出站调用有超时与 AbortSignal；瞬时错误重试（复用 `retry-delay`），
      永久错误（地址无效等）标记失败不重试；`UNIQUE(run_id, kind)` 保证至少一次投递下不重复发。
- [ ] **T11** 邮件内容：任务标题、状态、耗时、前端链接。**不含产物内容、模型输出原文、
      工具参数**；链接进入后仍走登录与租户校验（跨租户 404）。
- [ ] **T12** 接入 `worker-main.ts`：启动顺序在 drain gate / schema 核对之后，停机时纳入
      `worker-drain.ts` 的期限。注意 `container.ts` 行数预算（1066，当前 1048），装配拆到独立文件。

### 阶段 3（可选）：模型主动通知工具

- [ ] **T13** 若需要「跑完把摘要发给我」：DSH provider 工具 `notify_me(subject, body)`，
      **无收件人参数**，从 `run-services` ALS 的 tenant 取 userId；按 Run 限频，走策略/审批层；
      实际投递写 outbox 由 T8 消费者完成，共享幂等与审计。改了 `cordis.patch.yml` 须跑
      `agent/tests/runtime/boot.test.ts`。

### 阶段 4：前端

- [ ] **T14** 开关 UI（按 T2），覆盖加载失败、保存失败、未配置邮件能力时的禁用态与提示；
      服务端返回能力是否可用，前端不自行猜测。

### 阶段 5：测试与验收

- [ ] **T15** 单测：终态三种 × 开关开/关 × 邮箱空/有；重复投递只发一次；发送超时与永久失败；
      配置缺失时能力关闭（拒绝对照 + 成功对照）。
- [ ] **T16** 跨租户：伪造/错配 run 与 org 时不发信、不泄漏存在性。
- [ ] **T17** 真实链路：compose 增加本地 SMTP 捕获容器（如 mailpit，仅开发用），
      重建 `agent agent-worker api-server`，跑 登录 → 建会话 → 带工具的长 run → 成功/失败/取消
      各一次 → 核对捕获邮件与 `notification_deliveries`；worker 重启恢复场景验证不重发。
- [ ] **T18** 六套测试 + 各包类型检查 + 前端 build。

### 阶段 6：文档

- [ ] **T19** 同 PR 更新：`architecture.md`（新消费者）、`deployment.md` 与 `.env.example`
      （环境变量，仅占位符）、`api.md`（开关字段/能力查询端点）、`webui.md`（开关 UI）、
      `CHANGELOG.md [Unreleased]`；本文状态改为「已实施」并链接证据。

## 5. 开放问题

- 通知是否也覆盖 `waiting_approval` / `waiting_input`（长任务卡在审批时提醒）？
- 多收件人（抄送组织管理员）是否需要？若需要，收件人同样只能来自账本，不能来自模型。
- 是否需要退订链接 / 发送频率上限（按用户每小时）？
