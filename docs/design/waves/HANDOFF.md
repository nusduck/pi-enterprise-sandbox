# 交接说明

**写于 2026-09-01。第五次交接（ADR 0009 收口）。** 分支 `refactor/dsh-rebuild`，
基线提交 `83a026b7`；本文件描述其后的当前工作树，不用它替代 `docs/STATUS.md`。

先读：

1. [`../../STATUS.md`](../../STATUS.md) — 唯一的 §32 缺口看板
2. [`../../adr/0009-dsh-host-tools-and-application-steward.md`](../../adr/0009-dsh-host-tools-and-application-steward.md) — 已实施决策
3. [`../dsh-host-tools.md`](../dsh-host-tools.md) — H0–H9 任务与验收史
4. [`../agent-ts-rebuild.md`](../agent-ts-rebuild.md) — Agent TS 整理与 strict 现状

## 当前形态

- `frontend/` 只做 UI；`api-server/` 是薄 BFF；Run/ToolExecution/审批事实只在 `agent/` MySQL；工作区字节与进程只在 `exec/`。
- Agent 循环已换成 DSH `0.1.1-rc.2`，组合层位于 `agent/src/runtime/`；Python 执行面已删除。
- `sandbox` 与 `sandbox-mcp` 同一个 exec 镜像、不同入口与凭据；facade 只能走 `/internal/mcp/v1/*`。
- MCP 使用出厂 `@deepseek-ai/dsh-mcp-client`；旧 `pi-mcp-adapter` 与 `AGENT_MCP_RUNTIME_ROOT` 已退役。

## 本轮收口

1. **Skill 启用链闭环**：Capabilities UI → BFF → Agent；外部身份先解析为内部 owner，启用校验草稿、复制只读发布副本并写 `user_skill_enablements`，停用保留草稿。账本写失败会撤销发布副本。
2. **exec 真正消费发布包**：从 `SANDBOX_USER_SKILLS_ROOT/<org>/<user>` 只列当前 owner 下带真实 `SKILL.md` 的目录，逐包 `ro_bind`；非法身份、符号链接与其他 owner 不进入上下文。
3. **审批停泊收尾**：一个并行工具触发审批后，其它仍为 `RUNNING` 的 ToolExecution 收敛为 `UNKNOWN / RUN_PARKED_PARALLEL_TOOL_UNKNOWN`。
4. **CI 补齐**：`.github/workflows/test.yml` 新增 contract 与 exec 的 test + typecheck job。
5. **仓库卫生**：修复无 Python package 后 `uv sync` 的 setuptools 自动发现失败；清掉已删除 MCP adapter 的 stale hotspot 预算，并把超预算的 executor factory / HTTP Skill 路由 / 并行收尾职责拆出。
6. **浏览器认证归位**：认证凭据与 JWT 签发迁到 Agent；BFF 不再请求已删除的 exec `/auth/*`。
7. **长进程权威归位**：DSH 后台 `bash` 预留 process id，exec 启动并写 `exec_jobs`；BFF 通过 Agent 授权 session→workspace 后直接查询/控制 exec。
8. **多轮 journal 修复**：重建 runtime 时保留已恢复 header，空 checkpoint 的 manifest 接到真实 leaf，避免同一会话后续 Run 出现 header 冲突或多根 journal。
9. **原生 DSH session persistence**：根 ctx 挂 `MysqlSessionPersistence`（官方 `SessionPersistence` + `PersistenceCoordinator` + MySQL `PersistenceBackend`）；已物化会话走 `agents.resume`，未物化走 `agents.create`。JSONL 出厂后端保持关闭。

## 验证命令

```bash
uv run --frozen pytest -q
npm test --prefix contract
npm test --prefix exec
npm test --prefix agent
npm test --prefix api-server
npm test --prefix frontend
npm --prefix contract run typecheck
npm --prefix exec run typecheck
npm --prefix agent run typecheck
frontend/node_modules/.bin/tsc --noEmit -p frontend/tsconfig.json
```

运行路径变更后必须重建四个服务，再跑登录 → 会话 → 带工具 Run → Skill 启用/停用 →
process logs/signal → 跨租户 404：

```bash
docker compose build agent api-server sandbox sandbox-mcp
docker compose up -d
```

## 仍未关闭

- A2 已由 2026-09-01 compose 模型驱动工具 Run 关闭。A4 已由同日 Worker `SIGKILL` 后的模型口令复述关闭。G2 仍是 `unknown`（本轮没有中途杀死正在跑的 Run）。
- C7 仍是 `partial`：浏览器侧 start/list/log/signal/cancel 已真机通过，但模型侧同步 `job_list` / `job_output` 仍未接上异步 exec 查询，且日志与活句柄不能跨 exec 重启恢复。G7 的 hard-SIGKILL gate 未跑。
- C1/C4/C6/C8、E1–E3、F2、G2/G7、H2–H6 等其余行仍按 `STATUS.md` 的 live/ops 证据缺口处理；绿色单测不自动翻行。
- `agent/tsconfig.json` 的主树 `strict` 仍关闭；`agent/src/runtime/**` 继续由 `tsconfig.runtime.json` 严格检查。主树 strict 仍是独立的大型存量债务，不应夹进功能 PR。
- `pi-run-*` 文件名前缀是纯命名债务，不影响运行。

## 已知环境陷阱

- 宿主机 `~/.pi/agent/mcp.json` 会让 6 个 ambient-MCP 禁止用例失败；按 `AGENTS.md` 临时移开后确认。
- macOS 裸跑 bwrap 预期失败；Docker Desktop 容器内可用。进容器验 bwrap 必须用 `--user 10001:10001`。
- `tsx` 在受限沙箱里创建 IPC socket 可能报 `EPERM`；应在获批的非沙箱执行环境跑测试，不要改测试规避。
- `sandbox` / `sandbox-mcp` 必须一起重建；只重建一个会验证到旧镜像。
