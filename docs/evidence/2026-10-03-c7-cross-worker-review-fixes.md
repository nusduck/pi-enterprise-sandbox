# C7 跨 Worker job 工具复审修正（2026-10-03）

## 对象

- 分支 `test/c7-cross-worker-job-gate`，基于 `1a43a0af` 加本次未提交改动（`remote-jobs.ts`、`remote-job-tools.ts`、回归用例）。
- 重建 `dsh-enterprise-agent:latest`（`5c8d629c254c`，Agent HTTP 与 Worker 共用）；exec 镜像同分支重建（`enterprise-sandbox` / `enterprise-sandbox-mcp`）。

## 修正内容

1. 模型 `job_kill` 对本 Worker 启动的 bash 作业改走 exec 后，本地条目不再置 `reported`，结算时出厂 `onJobDone` 会再发一条完成通知。现在 kill 与读到终态时置 `reported`。
2. 替换 `execute` 绕过了出厂 `defineTool` 的参数校验；补 `wait`（布尔）、`timeout_ms`（正有限数）、`reason`（字符串）校验。
3. 进程级 `RemoteJobs` 单例上的读游标表按插入序封顶 1024。
4. 复核确认 `execute` 与 `finalizeContent` 拿到同一个 execution 对象（`dsh-tools` 的 `contentFinalizers` 以该对象为键），输出字节上限的接线成立，无需改动。

## 验证

- 新增用例 `agent/tests/runtime/remote-job-tools.test.ts` 第二条：修复前 1 通过 / 1 失败，修复后通过。
- Node 22 容器内 Agent `npm test` **2100/2100**，`npm run typecheck` 通过。
- K8s `dsh-sim`（两 Worker Pod，假模型）`cross-worker-job` **5/5**（tag `mus3rohm`）：作业在 `agent-worker-577cbf8f9b-7v5sh` 启动，`g48xg` 的模型 `job_list`/`job_output` 读到 `running` 与输出，`job_kill` 返回 `cancellation-requested`，exec 快照 `killed`。验证后 `down.sh sim` 清理。
- Compose 开发栈换新镜像（带开发覆盖层）后，Playwright 阶段 1（SSO 登录 → 带工具 Run → 后台进程登记/日志/SIGKILL → 跨用户 404 与本人合法对照）全部通过。

## 范围

C7 仍为 `partial`：exec 重启后的输出与活句柄恢复不在本次范围。
