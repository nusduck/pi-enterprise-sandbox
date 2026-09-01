# DSH Worker 重启后的模型上下文真机证据（2026-09-01）

## 范围

在已挂载原生 `ctx.sessionPersistence` 的 compose 栈上，验证 **Agent Worker
进程死亡之后**，同一 Agent Session 的后续 Run 仍能 `agents.resume`，并且模型
能从落盘事件里读到上一轮用户给定的一次性口令。本文不含 cookie、token、
密钥或内部凭据。

本轮测的是 A4（多轮会话可恢复），不是 G2（运行中 SIGKILL 后的 lease/UNKNOWN
回收）。Worker 在 Run 1 终态之后才被杀死。

## 步骤

1. 新用户登录并建立 Conversation / Agent Session。
2. Run 1 要求模型记住一次性口令 `OXBIRD-B7D12629`，只回复 `OK`，不使用工具。
3. 对 `agent-worker` 发 `SIGKILL`（`docker compose kill -s SIGKILL`）。容器停在
   `exited`；`unless-stopped` 在本机 Docker Desktop 上没有自动拉起，随后
   `docker compose up -d agent-worker` 启动新进程。
4. 同一 Conversation 发 follow-up：只回答上一轮的口令。

## 观测

- Run 1 `01M1E1FF4Y3DH89B9CSRTW9J7D` `SUCCEEDED`。Worker 日志
  `dsh session create`，`dsh_session_events` 38 行。助手可见文本为 `OK`。
- Worker PID `1342045` → `1362044`，`StartedAt` 从 `08:04:56Z` 变为
  `08:31:50Z`。
- Run 2 `01M1E1HC4HZQP2PKDX2X255J12` 复用
  `agent_session_id=01M1E1FF43271JE2F88R69R25G`，`SUCCEEDED`。Worker 日志
  `dsh session resume`。事件行 38 → 58，含 `session/end-seed` 与两套
  `turn/start` / `turn/end` / `assistant/message`。
- 第二轮 `assistant/message` 的可见文本块为 `OXBIRD-B7D12629`（与 Run 1 用户
  消息中的口令一致）。`usage.cacheReadTokens` 从 3584 升到 3968，说明 resume
  后的请求带着上一轮上下文。

平台 `messages` 表本轮只写了 user 文本与 journal 条目，没有 `role=assistant`
行；模型上下文以 DSH `dsh_session_events` 为准。

## 结论与边界

- A4 的「Worker 重启后模型上下文」compose 门已通过。
- G2 不因此关闭：没有在工具执行中途 SIGKILL Worker，也没有验证 lease 过期后的
  中途 Run 回收。
