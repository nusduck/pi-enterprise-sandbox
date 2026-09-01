# DSH 多轮与长进程收口真机证据（2026-09-01）

## 范围

在 `refactor/dsh-rebuild` 当前工作树重建并启动 `agent`、`api-server`、
`sandbox`、`sandbox-mcp` 四个镜像，验证登录 → 会话 → 模型驱动工具 Run →
同会话后续 Run → 后台进程 → logs/signal → 跨租户 404。本文不含 cookie、token、
密钥或内部凭据。

## 先复现的缺陷

1. 浏览器认证请求仍被 BFF 转发到已删除的 exec `/auth/*`，`/api/auth/me` 返回 404。
2. 同一会话后续 Run 重建 runtime 时丢弃恢复出的 journal header；连续空 checkpoint
   又把 manifest 接到 content leaf，形成 header 冲突或多根 journal。
3. Agent migration 没有 `exec_jobs`，长进程缺少 exec-owned 持久账本。
4. DSH `run_in_background` 只返回 Agent 本地生成的假 id，`RemoteJobs.start()` 没有
   真正让 exec registry 启动/登记进程。
5. MySQL prepared statement 的 `LIMIT ?` 数字绑定在真实 MySQL 上报
   `Incorrect arguments to mysqld_stmt_execute`，进程列表返回 500。
6. 浏览器持有 Sandbox Session id，而 exec 按 Workspace id 归属；BFF 未做授权后的
   session→workspace 映射，导致已登记进程查不到。

## 修复后的真实链路

- 四个镜像均重新构建，compose 服务进入 healthy。
- 用户 A 登录并建立 Conversation / Agent Session / Sandbox Session / Workspace。
- 模型完成前台 `bash pwd` ToolExecution；同一会话后续多轮 Run 成功，不再出现
  journal header conflict 或 multi-root。
- 最终模型 Run 成功，`bash` 以 `run_in_background=true` 启动 `sleep 120`；返回的
  process id 与 `exec_jobs`、浏览器进程列表中的 id 一致，且 `run_id` 正确。
- `/api/processes?session_id=...&run_id=...` 返回 200；logs 返回 200 和有效游标字段，
  `sleep` 没有输出，因此空日志是预期结果。
- 对同一进程发送 `SIGTERM` 返回 200，状态先为 `stopping`，随后收敛为
  `cancelled` 并带 `finished_at`。
- 用户 B 查询用户 A 的同一 session/run 返回 404，未泄漏存在性。

## 结论与边界

- A2 的模型驱动策略/工具闭环已有 compose 证据，可关闭。
- A4 只能到 `partial`：连续 Run 和 journal 重建已验证，但当前 runtime factory 尚未把
  原生 DSH session persistence backend 挂成可 resume 的会话，Worker 重启后的模型上下文
  恢复也没有在本轮真机验证。
- C7 只能到 `partial`：浏览器控制链与 exec 持久进程事实已验证；模型侧同步
  `job_list` / `job_output` 仍没有异步 RPC 结果，日志缓冲与活进程句柄也不能跨 exec
  重启恢复。
- G7 保持 `unknown`：本轮没有硬杀 exec 服务并验证 Bubblewrap orphan recovery。

## 最终离线验证

- `uv run --frozen pytest -q`：98 passed。
- `npm test --prefix exec`：312 passed，1 skipped。
- `npm test --prefix contract`：29 passed。
- `npm test --prefix agent`：1174 passed。
- `npm test --prefix api-server`：144 passed。
- `npm test --prefix frontend`：323 passed。
- exec / contract / agent / frontend 四套 TypeScript typecheck 全部通过。
- `node --check scripts/smoke-cross-service.mjs`、`docker compose config --quiet`、
  `git diff --check` 全部通过。
