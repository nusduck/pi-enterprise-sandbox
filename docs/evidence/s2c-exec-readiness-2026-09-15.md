# 验证记录：S2c 执行面 `/ready` 就绪判定与启动期隔离预检

日期：2026-09-15。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §9.2 与 §11 S2；缺陷在 [S2a/S2b 证据](s2ab-probes-2026-09-15.md) 中复现。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`828b3e49` + 本次未提交改动（随本证据同一 commit） |
| 单测运行时 | **宿主 Node v23.11.0**（非容器）；`uv run pytest` Python 3.11 |
| 运行栈 | 开发 Compose + `updrdb-sim` + `upredis-sim`：MySQL 5.7.44、Redis 5.0.14、dbpm-fake、双 UPDRDB Proxy、UPRedis 路由模拟代理；容器内 Node v22.23.2 |
| 镜像（重建，容器已换新） | `enterprise-sandbox` `0f4246971a34`（sandbox / sandbox-mcp）；`pi-enterprise-agent` `fe4c622f2382` 未改动 |

## 缺陷与根因

| 项 | 内容 |
|---|---|
| 现象 | 开发栈 `curl 127.0.0.1:8081/ready` 恒为 200 `{"status":"ok"}`；`deployment.md` / `api.md` 描述的 workspace / 数据库 / bwrap 预检与 `internal_plane_status`、`workspace_available` 字段都不存在 |
| 根因 | `exec/src/http/app.ts` 中 `/health`、`/ready`、`/health/live`、`/health/ready` 共用一个返回 `{ status: 'ok' }` 的处理器；`preflightCheck()` 只有测试调用，生产启动链没有隔离预检。文档是 Python 执行面时代的描述（`git log -S internal_plane_status` → `f49a5226`） |
| 修复前失败 | 暂存还原 `app.ts` / `main.ts` 后跑修改后的 `test/main.test.ts`：19 例中 2 例失败（未接预检的 `/ready` 应为 503、就绪探针不要求服务令牌但应为 503），还原后通过 |

## 改动要点

- exec：新增 `http/readiness.ts`（数据库 `SELECT 1`、四个数据根可读写目录，各 2s 超时；隔离读启动期结果；关停中不再探测；只回 ok / unavailable）。
- exec：`createExecApp` 的 `/ready`、`/health/ready` 走 `readiness`，未接线时 503；`/health`、`/health/live` 不变。`createExecAppFromEnv` 接线数据库、四个根、隔离状态与关停标记；`ExecRuntime` 新增 `preflight()`（建出四个根 → 真跑 bwrap 探针）与 `markShuttingDown()`。
- exec `main.ts`：启动链改为 schema 核对 → **预检（失败拒启）** → 孤儿回收 → listen；SIGTERM 先置未就绪。
- 文档：`api.md`（执行面健康检查重写，删除不存在的 `/metrics` 与 Prometheus 指标表）、`deployment.md`（探针表与示例输出）、design §9.2、CHANGELOG。

## 验证结果

| 项 | 环境 / 命令 | 结果 |
|---|---|---|
| 就绪单测 | 宿主 `npx tsx --test test/readiness.test.ts test/main.test.ts` | 27/27（全部通过才就绪；未配数据库不算失败；数据库抛错 / 挂起；根缺失 / 是文件 / 只读；隔离 unchecked / unavailable；关停不探测；预检前 503 → 假 bwrap 预检后 200 → 关停 503；bwrap 缺失或探针退出 1 时 `preflight` 抛 `IsolationUnavailable`，响应不含错误文本） |
| exec | 宿主 `npm test` + `tsc --noEmit` | 385 / 384 pass / 0 fail / 1 skip（宿主无 bwrap 的真实隔离用例）；tsc 通过 |
| 仓库卫生 | 宿主 `uv run pytest -q` | 123 passed |
| 未重跑 | agent、api-server、contract、frontend | 本次无改动；Agent / BFF 的依赖检查打执行面 `/health`（`sandbox-client.ts` 静态核对），不受 `/ready` 语义变化影响。最近全量见 [S2a/S2b 证据](s2ab-probes-2026-09-15.md) |

## 运行栈（新镜像）

| 场景 | exec `/ready` | exec `/health` | facade `/ready` |
|---|---|---|---|
| 基线 | 200，`database / storage.* / isolation` 全 ok | 200 | 200 |
| 停 `updrdb-proxy-a/b` | 503，`database: unavailable` | 200 | 503，`sandbox: unavailable` |
| 恢复 Proxy | 约 5s 后 200 | — | 200 |
| `chmod 000 /var/sandbox/control` | 503，`storage.control: unavailable` | — | — |
| 恢复原权限 700 | 200 | — | — |
| 一次性容器 `SANDBOX_BWRAP_PATH=/nonexistent/bwrap` | 进程退出码 1：`exec storage/isolation preflight failed, refusing to start: Bubblewrap executable unavailable` | — | — |

sandbox 容器 `RestartCount=0`，healthcheck healthy；release gate `exec-orphan-recovery-gate` 所依赖的 `curl -f /ready` 返回体仍含 `ok`（静态核对，门禁本次未跑）。

## 真实链路（新镜像，客户端在 `node:22-slim` 容器内经 `api-server:4000`）

| 步骤 | 结果 |
|---|---|
| 注册 / 登录、建会话 | 200 |
| 带工具 Run | `SUCCEEDED`，`bash:succeeded` |
| 后台进程 | logs 200，`TICK-1…TICK-5`；`SIGTERM` 200，最终 `cancelled` |
| 跨租户 | B 访问 A 的 run / conversation / tools / process 全 404；A 全 200 |

## 未做 / 边界

- 单测在宿主 Node v23.11.0 上运行，未在容器内复跑；带真实 bwrap 的预检只在重建后的容器栈中验证（基线 `isolation: ok` 与缺失 bwrap 拒启）。
- SIGTERM 先置未就绪只由代码顺序与单测（`markShuttingDown`）保证，未在运行栈中抓到关停窗口。
- 存储检查在挂起的 NFS / 共享存储上靠 2s 超时返回，但底层 `stat` / `access` 仍可能占住 libuv 线程池；共享 Skill 挂载标记与发布 ID 的启动核对未做，等 §3.1 存储落地。
- `exec-orphan-recovery-gate`、VM 裸装与 LB 实际探针配置未验证。
