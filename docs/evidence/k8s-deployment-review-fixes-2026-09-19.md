# K8s 部署评审 K1–K5 修复验证（2026-09-19）

对应 [K8s 部署评审](../reviews/2026-09-19-k8s-deployment/README.md) K1–K5。不关闭任何 STATUS 行；
评审中「生产部署仍需提交的验证材料」不在本次范围，仍待目标环境证据。

## 验证对象与版本

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm` / `480bf65d` + 本次未提交改动（agent、api-server、K8s 清单与脚本、prod Compose、文档） |
| runtime | 测试运行器与客户端均为 `node:22-slim`（Node 22.23.2）；Python 3.11.15（`.venv`）；kubectl client 1.33.9 / OrbStack server 1.35.6+orb1 |
| 重建的镜像 | `docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend`：`pi-enterprise-agent` = `347caa877c55`、`pi-enterprise-api` = `75a4b34fbfb4`；exec 与前端源码未改，镜像命中缓存（`enterprise-sandbox-mcp` = `515606a4ee0e`、`pi-enterprise-frontend` = `3b1e2ce001ae`） |
| 运行对象 | OrbStack `pi-dev`（`scripts/dev/k8s/up.sh dev`），5 个 Pod 的 imageID 均已核对为上述镜像 |
| 替身边界 | 开发栈 `dbpm-fake`、MySQL 5.7、Redis 5.0.14、Compose 里的 exec 代替 VM；真实 LLM 网关与真实 MCP（exa）。未取得生产清单与目标环境 |

## 一、回归测试（修复前失败 → 修复后通过）

| 项 | 修复前 | 修复后 |
|---|---|---|
| K1 BFF：`api-server/tests/readiness-downstream.test.js` | 5/5 失败（请求路径 `[/health,/health]`，下游未就绪时报 200） | 5/5 |
| K1 Agent：`agent/tests/bootstrap/agent-sandbox-readiness.unit.test.js` | 4/5 失败 | 5/5 |
| K2 真插件树：`agent/tests/runtime/mcp-live.test.ts`「K2 就绪投影」（镜像内旧源码 vs 当前源码） | `ready` 期望 false 实际 true | 2/2（含 H7.8 正对照） |
| K2 刷新：`agent/tests/bootstrap/mcp-discovery-state.unit.test.js` | 新增（旧实现无注入点，未做修复前对照） | 5/5 |
| K3–K5 清单：`tests/test_k8s_dev_manifests.py`（`git stash` 清单与脚本后对照） | 5/5 失败 | 5/5 |
| K4 排空：`agent/tests/bootstrap/worker-drain.unit.test.js` | 新增 | 5/5 |

## 二、六套测试与类型检查

临时运行器镜像按 CI 顺序 `npm ci` 后 COPY 工作树，`--network none`：

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` 等价（`.venv/bin/python -m pytest -q`） | 219 passed |
| contract：typecheck + `tsc --noEmit -p contract/tsconfig.json` + test | 118/118 |
| exec：typecheck + `tsc --noEmit` + test | 420 pass、1 skipped。需按 AGENTS §4 以 uid 10001、`--cap-drop ALL`、`seccomp=exec/seccomp-bubblewrap.json`、`apparmor=unconfined`、`systempaths=unconfined` 运行；以 root 或缺少这些选项时 bwrap 相关 5 条失败，属环境而非代码（exec 源码未改） |
| agent：typecheck（宽松 + runtime strict）+ test | 1405/1405（含 `boot.test.ts`、`mcp-live.test.ts`） |
| api-server：typecheck + test | 165/165 |
| frontend：test + build | 367/367，build 通过 |
| Compose | `docker compose config --quiet` 通过；prod overlay 用 CI 占位变量渲染后 `verify_compose_prod_config.py` 通过，agent-worker `stop_grace_period: 3m0s` |

## 三、真实链路（pi-dev）

| 检查 | 结果 |
|---|---|
| 就绪端点 | BFF `/health/ready` 200 `agent/sandbox: ready`；Agent `/ready` 200（exa connected, 2 tools）；facade `/ready` 200 |
| K1 故障注入：exec 容器内 `chmod 000 /var/sandbox/control`，随后恢复 700 | exec `/health` 200、`/ready` 503（`control: unavailable`）；Agent `/health` 200、`/ready` 503 `sandbox: not_ready`；BFF `/health/ready` 503 `agent/sandbox: not_ready`；恢复后两者回到 200 |
| K2：`kubectl set env deployment/agent` 追加 enabled 的 `k2dead`（`http://127.0.0.1:9/mcp`），随后撤销 | 新 Pod `/ready` 503，`k2dead` 以 `unavailable / tool_count 0` 列出、exa 仍 connected；日志 `MCP Server unavailable id=k2dead`；Pod 0 重启、始终未就绪，滚动停住，旧 Pod 继续服务。撤销后恢复原 Deployment 模板与 200 |
| K3：在模板不变时再执行一次 `up.sh dev` | frontend Deployment generation 3→4、带 `restartedAt` 注解、Pod 被替换。另：本次开始时 frontend Pod 运行 `sha256:3b3179…`，而本地 tag 早已是 `3b1e2ce…`——评审时未观察到的落后在开发栈里确实发生过，滚动后已对齐 |
| K4：临时 `AGENT_WORKER_DRAIN_TIMEOUT_MS=5000`，Run 前台执行 `sleep 90` 时 `rollout restart agent-worker`，随后撤销 | 旧 Pod 日志 `SIGTERM — shutting down` → `drain deadline 5000ms reached with runs still active — exiting without teardown`，约 7s 内退出（宽限 180s）。新 Worker 恢复扫描按既有规则**不重放**（工具账本 `bash RUNNING`，副作用边界未决），Run 保持 RUNNING；经 `POST /api/runs/{id}/cancel` 后恢复扫描落为 `CANCELLED`（`recovered: CANCELLING with no live lease`），工具行保持 RUNNING |
| AGENTS §4 链路（`live-chain.mjs`，两个新注册用户） | 注册/登出/登录 200 → 建会话 201 → Run 202 → `SUCCEEDED`，工具 `bash`×2、`job_kill` 均 succeeded → 进程列表 200（`sleep 300`）、logs 200、signal SIGTERM 200 → 用户 B 访问 A 的 Run / 会话 / 进程列表 / 进程 logs 均 404 |

## 四、未覆盖与边界

- K5 慢启动：只有清单与卫生测试，未在集群注入超过 30s 的启动延迟；K2 实例里连接被立即拒绝，没有走到 SDK 60s 初始化超时。
- K2 恢复：「MCP 恢复后无需重启即就绪」只由单测（真实投影 + 替换注册表内容）证明，未在集群里让一台 MCP 由不可达转为可达。
- K4 只在开发栈单副本、5s 期限下演练；未跑 sim 多副本、前台子 Run、关停期间依赖故障等评审建议的专项。默认 150s / 180s 的组合未做强杀实验。
- 生产清单、双集群、VM、UPDRDB/UPRedis/DBPM 与共享存储均未验证；未查询远端 CI 与分支保护。
