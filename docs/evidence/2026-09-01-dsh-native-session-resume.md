# DSH 原生 session persistence resume 真机证据（2026-09-01）

## 范围

在 `refactor/dsh-rebuild` 当前工作树重建 `agent` 镜像（含 `api-server` /
`sandbox` / `sandbox-mcp` 同轮重建）后，验证同一 Agent Session 的后续 Run
走原生 `ctx.sessionPersistence` 的 `agents.resume`，而不是再次 `agents.create`。
本文不含 cookie、token、密钥或内部凭据。

## 先复现的缺陷

1. `requireMysql: true` 只读 `MYSQL_HOST/USER/PASSWORD/DATABASE`。compose 里
   Agent 只有 `AGENT_DATABASE_URL`，第一轮真机 Run 立即
   `FAILED / missing MySQL config`，`dsh_sessions` 为空。
2. 补上 URL 解析后，第一轮 Run `SUCCEEDED` 并写入 `dsh_sessions` /
   `dsh_session_events`；第二轮同一 `agent_session_id` 确实走了
   `dsh session resume`，但 `loadStored` 对 mysql2 已经解析过的 JSON 列再
   `JSON.parse`，报 `"[object Object]" is not valid JSON`。

## 修复后的真实链路

- 迁移 `20260901000002_dsh_session_persistence.js` 已应用到 compose MySQL，
  表 `dsh_sessions` / `dsh_session_events` 存在。
- 新用户登录并建立 Conversation / Agent Session。
- Run 1（`01M1E00HVV2V19KX41JT6KA1BA`）`SUCCEEDED`。Worker 日志
  `dsh session create`；该 session 在 `dsh_session_events` 有 24 行。
- 同一 Conversation 的 follow-up Run 2（`01M1E00RDG5RDB6VMXR93Y91P1`）复用
  `agent_session_id=01M1E00HTC6MYQJ8XGM83SP05A`，`SUCCEEDED`。Worker 日志
  `dsh session resume`。
- 同一 session 的事件行从 24 增到 43，出现 `session/end-seed`，以及两套
  `turn/start` / `turn/end` / `assistant/message`。

## 结论与边界

- 原生 DSH persistence 已在 compose 上完成 create → 落盘 → resume。
- A4 仍是 `partial`：DSH Worker 重启后的模型上下文真机 gate 未跑。
- 本文不关闭 C7 / G7。
