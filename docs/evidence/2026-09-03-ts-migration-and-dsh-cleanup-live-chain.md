# TypeScript 迁移与 DSH 命名收口真机证据（2026-09-03）

## 范围

针对审查意见（Finding 1–5）完成彻底修复并清理后，在当前工作树重建并启动 `agent`、`api-server`、`sandbox`、`sandbox-mcp` 四个服务镜像。按 `AGENTS.md` §4 硬性要求完成真机端到端链路验证：登录 → 会话 → 工具 Run（SSE 流式）→ 后台长进程 logs/signal → 跨租户 404 隔离。本文不含任何密钥明文或敏感凭据。

## 先复现的缺陷

1. **`api-server` smoke 在干净检出中失败（Finding 2）**：移开 `api-server/dist` 后执行 `npm run smoke --prefix api-server`，因缺失前置构建且脚本回退到已删除的 `server.js`，复现 `ECONNREFUSED` 崩溃。
2. **`DshRunExecutor` 构造函数弱化校验（Finding 3）**：构造参数传入 `{ ...deps, sessionLockManager: {} }`（空对象无 `acquire` 方法），复现未抛出 TypeError 的弱化行为。
3. **`Pi*` 兼容别名导致模块无法加载（Finding 4）**：直接 `import('./agent/dist/src/application/pi-run-executor.js')` 复现 `ERR_MODULE_NOT_FOUND`，证明深层导入兼容性失效，决定彻底清理无用别名与历史名称。

## 修复与彻底清理

1. **BFF Smoke 强化**：`api-server/package.json` 的 `smoke` 命令前置 `npm run build &&`，`tests/listen-smoke.test.js` 直接断言并拉起 `dist/server.js`，无 `dist/` 测试通过。
2. **强化校验恢复**：`agent/src/application/dsh-run-executor.ts` 构造函数恢复严格检查 `!deps.sessionLockManager?.acquire`，并补全回归单测。
3. **彻底移除 `Pi*` 遗留别名**：不再保留 `PiRunExecutor`、`createPiRunExecutorFactory`、`PiRunExecutorDeps` 等伪兼容别名，全仓收口为统一的 `DshRunExecutor`、`createDshRunExecutorFactory`；测试目录迁移至 `tests/executor/`。
4. **文档同步更新**：修正 `docs/development.md`、`docs/module-layout.md`、`README.md`、`docs/CONTRIBUTING.md`、`docs/runbooks/sdk-upgrade.md`、`docs/adr/0007-agent-runtime-rebuild-on-dsh.md` 以及 `docs/CHANGELOG.md` 中失效的文件路径与测试指令。

## 真实链路验证结果

通过 `docker compose build agent api-server sandbox sandbox-mcp && docker compose up -d` 重新构建并拉起 4 个容器，全部服务通过健康检查进入 `healthy` 状态后，运行真实调用链路（`scripts/verify-full-live-chain.mjs`）：

1. **健康探测**：`GET /health/ready` 返回 HTTP 200，BFF、Agent（MySQL 权威）与 Sandbox 状态均正常。
2. **注册与登录**：用户 A 成功注册（`POST /api/auth/register`）并获取会话 Cookie，通过 `GET /api/auth/me` 验证身份。
3. **会话创建**：用户 A 成功创建 Conversation，返回 HTTP 201 与 Crockford ULID。
4. **模型带工具 Run**：
   - 用户 A 提交包含 `bash pwd` 工具调用的 Run 请求（`POST /api/runs`，带 `Idempotency-Key`），返回 HTTP 202 Accepted。
   - 订阅 `/api/runs/:id/events`，实时接收到 87 条 SSE 事件帧（包含 `run.accepted`、`run.started`、`tool.execution.completed`、`message.delta`、`message.completed`、`session.snapshot.saved`、`run.completed`）。
   - 模型成功在 Bubblewrap 沙箱容器内执行 `pwd` 并返回正确的工作区路径 `/home/sandbox/workspace`，Run 终态收敛为 `SUCCEEDED`。
5. **后台长进程与信号控制**：
   - 启动后台命令 `sleep 60`（`run_in_background=true`），`GET /api/processes?session_id=...` 正确查得后台进程 `bash-ccb113cf15924405a25267a860627944`。
   - `GET /api/processes/:id/logs?session_id=...` 返回 HTTP 200 与日志游标。
   - `POST /api/processes/:id/signal` 发送 `SIGTERM` 信号，返回 HTTP 200 成功响应。
6. **跨租户强隔离**：
   - 注册并登录用户 B。
   - 用户 B 请求用户 A 的 Run（`GET /api/runs/:id`）返回 **HTTP 404**。
   - 用户 B 请求用户 A 的会话（`GET /api/conversations/:id`）返回 **HTTP 404**。
   - 用户 B 请求用户 A 的沙箱进程（`GET /api/processes?session_id=...`）返回 **HTTP 404**。
   - 跨租户资源严格隐藏存在性，未发生任何信息泄漏。

## 全量离线测试结果

- `uv run pytest -q`：98 passed in 0.54s（结构棘轮与版本钉校验通过）。
- `npm test --prefix exec && npx tsc --noEmit -p exec/tsconfig.json`：323 passed, 1 skipped, 0 fail；类型检查通过。
- `npm test --prefix contract && npx tsc --noEmit -p contract/tsconfig.json`：29 passed, 0 fail；类型检查通过。
- `npm test --prefix agent && npm --prefix agent run typecheck`：1210 passed, 0 fail；主程序与 runtime 双道类型检查全部通过。
- `npm test --prefix api-server && npm --prefix api-server run typecheck && npm run smoke --prefix api-server`：146 passed, 0 fail；类型检查通过；smoke 测试通过。
- `npm test --prefix frontend && npx tsc --noEmit -p frontend/tsconfig.json`：334 passed, 0 fail；类型检查通过。
