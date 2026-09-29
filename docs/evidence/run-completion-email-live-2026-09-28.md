# 长任务完成邮件通知：真实链路验证（2026-09-28）

对象：分支 `feat/run-completion-email` 的未提交改动（基于 `ce0e163f`），设计见
[design/run-completion-email.md](../design/run-completion-email.md)。

## 环境

- 运行时：Node 22（`node:22-slim` 容器；宿主 Node 26 未参与）、MySQL 5.7、Redis 5.0.14。
- 重建镜像：`docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend`，
  确认 6 个运行容器的镜像 ID 均与重建前不同。
- 独立库：同一 MySQL 上新建空库 `sandbox_notify`，`scripts/dev/schema-apply.sh sandbox_notify` 建表，
  按新清单核对 `drifts: []`。未动共享的 `sandbox` 库（K8s dsh-dev 旧镜像仍连着它）。
- 邮件：`axllent/mailpit:v1.27` 接入 compose 后端内部网络（不发布宿主端口），`SMTP_HOST=dsh-mailpit`、
  `SMTP_PORT=1025`、无认证；`NOTIFY_MIN_RUN_DURATION_MS=15000`、`PUBLIC_WEB_BASE_URL=http://localhost:3000`。
  队列前缀 `AGENT_RUN_QUEUE_PREFIX={compose-ds}`。
- 模型：部署默认模型（真实 provider，非 fake）。
- 验证后删除 `sandbox_notify` 与 mailpit，compose 还原为旧镜像。

## 结果

| 检查 | 结果 |
|---|---|
| worker 启动日志 `run completion email enabled min_duration_ms=15000` | PASS |
| `GET /api/auth/profile`：`notifications.email = {available:true, min_run_duration_ms:15000}`，`notify_run_complete:false`，`editable_fields` 含开关 | PASS |
| 没有邮箱时打开开关 → 422 `NOTIFY_EMAIL_REQUIRED`；带邮箱一起打开 → 200；开着时单独清空邮箱 → 422 `NOTIFY_EMAIL_REQUIRED`；非布尔 → 422 `AUTH_INPUT_INVALID` | PASS |
| 短 Run（约 1 秒，SUCCEEDED）不发信 | PASS |
| 带 bash 工具的长 Run（`sleep 20`，SUCCEEDED，23 秒）→ 一封「[任务已完成]」 | PASS |
| 后台进程：`/api/processes/{id}/logs` 200（`tick-1..4`），`signal` 200；另一用户读该进程日志 404 | PASS |
| 长 Run 中取消（CANCELLED，21 秒）→ 一封「[任务已取消]」 | PASS |
| 另一用户（开关关、有邮箱）长 Run SUCCEEDED → 不发信 | PASS |
| 跨租户 `GET /api/runs/{id}`、`GET /api/conversations/{id}` → 404 | PASS |
| 邮件内容：收件人是本人；会话标题里的 `https://evil.example/x` 被替换为 `…`；唯一链接为 `http://localhost:3000/c/<conversationId>`；不含模型回答 | PASS |
| `notification_deliveries`：两行 `sent`、`attempts=1`，只存地址 sha256 | PASS |
| 6 个终态 Run 各有一行 `run_notification` outbox，全部 `PUBLISHED`；这些行的 payload 都没有 `runId` 键 | PASS |
| 把已发送 Run 的通知行改回 `PENDING`（模拟确认前崩溃）→ 被重新认领（attempts 2）并结清，mailpit 仍 2 封 | PASS |
| 重启 agent-worker → 不重发，仍 2 封 | PASS |
| 去掉 `PUBLIC_WEB_BASE_URL` 重启：worker 日志 `disabled: PUBLIC_WEB_BASE_URL is missing or invalid`；profile `available:false`；打开 → 422 `NOTIFICATION_UNAVAILABLE`；关闭 → 200 | PASS |
| 浏览器（设置 → 账户）：不可用时开关带提示，已打开的可关掉并保存，之后禁用；可用时清空邮箱保存 → 开关下显示「打开通知时必须保留邮箱」且草稿保留；还原后勾选保存成功 | PASS |
| 浏览器：15 秒阈值显示为「0 分钟」 | 发现后修复为按秒显示，重建前端镜像复验显示「15 秒」 |

## 未覆盖

- FAILED 终态没有在真实链路里造出（单次请求无法设预算，真实模型也不稳定失败）。它与完成、取消经过同一个
  `applyRunTransitionInTxn` 写入点，由单测矩阵覆盖。
- 未接真实 SMTP 服务：认证（`SMTP_USER` + `SMTP_PASSWORD_FILE`）与 5xx 拒收只有单测；超时由对不应答的 TCP
  服务器的单测证明有界。
- 本地共享的 `sandbox` 库与 K8s dsh-dev 仍是旧结构、跑旧镜像；换新镜像前需按 development reset runbook 重建库
  （研发阶段不做增量升级）。
