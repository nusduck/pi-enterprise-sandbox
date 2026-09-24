# 验证记录：S2e sandbox-mcp slim 镜像

日期：2026-09-15。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §2.1（sandbox-mcp「新增 slim 镜像目标」）与 §11 S2。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`8cf16e8c` + 本次未提交改动（随本证据同一 commit） |
| 单测运行时 | **宿主 Node v23.11.0**（非容器）；`uv run pytest` Python 3.11 |
| 运行栈 | 开发 Compose + `updrdb-sim` + `upredis-sim`（同 S2c / S2d 证据）；客户端 `node:22-slim` |
| 镜像（重建，容器已换新） | `enterprise-sandbox-mcp` `086a11229f3f`（302MB，sandbox-mcp）；`enterprise-sandbox` `c5a8b3dbfe61`（2.84GB，sandbox） |

## 实施前的事实

| 项 | 证据 |
|---|---|
| facade 与执行面同镜像 | `enterprise-sandbox:latest` 2.84GB；facade 容器内有 `/usr/bin/bwrap`、`/usr/bin/chromium`、`/opt/pi-python/venv/bin/python3`、`curl`，`node_modules` 含 `@deepseek-ai`、`mysql2` |
| facade 入口加载执行面代码 | 静态 import 图：`mcp-main.ts → startup-credentials.ts → db/client.ts → db/failover-pool.ts`，外部依赖含 `mysql2/promise` |
| 回归测试修复前失败 | 用 `git archive HEAD` 取出改动前的 `exec/src`、`exec/Dockerfile`、`contract/src`，放入新测试运行：`facade reaches executor module: db/client.ts`、`non-allowlisted package: @pi/contract/endpoint-failover.js` 等 2 组失败（Dockerfile 阶段组因缺 `facade` 阶段同样失败） |

## 改动要点

- `exec/src/mcp/startup-credentials.ts`：facade 的服务 Redis 取密，只依赖 contract `dbpm-config`；执行面取密留在 `startup-credentials.ts`。
- `exec/Dockerfile`：`facade-deps`（`npm ci --omit=dev --ignore-scripts`，再移除 `mysql2`、`@deepseek-ai/dsh-*`）与 `facade`（复制 contract 三个 DBPM 模块、`dist/mcp-main.js`、`dist/mcp/`、`dist/http/node-listener.js`，root 所有、uid 10001 运行、node healthcheck）。两阶段放在执行面终态之前，默认 target 不变。
- `exec/test/mcp-import-boundary.test.ts`：import 图只触达 `mcp/` 与 `http/node-listener.ts`；外部依赖允许清单；contract 可达模块只用 `node:*`；Dockerfile `facade` 阶段覆盖图中每个模块、不含工具链关键词、以 uid 10001 运行 facade 入口。
- Compose `sandbox-mcp`：`target: facade`、`image: ${SANDBOX_MCP_IMAGE:-enterprise-sandbox-mcp:latest}`、node healthcheck。
- 文档：AGENTS.md §1 / §4、`architecture.md`、`sandbox-mcp.md`、`development.md`、README、`.env.example`、design §2.1、CHANGELOG。

## 验证结果

| 项 | 环境 / 命令 | 结果 |
|---|---|---|
| facade 相关单测 | 宿主 `npx tsx --test test/mcp-import-boundary.test.ts test/startup-credentials.test.ts test/mcp-readiness.test.ts test/mcp-facade.test.ts` | 38/38 |
| exec | 宿主 `npm test` + `tsc --noEmit` | 391 / 390 pass / 0 fail / 1 skip（宿主无 bwrap 的真实隔离用例）；tsc 通过 |
| 仓库卫生 | 宿主 `uv run pytest -q` | 150 passed（含 `exec/Dockerfile` 每个 `FROM node:` 必须为钉版本、执行面工具链 apt 包断言） |
| Compose | `docker compose -f docker-compose.yml config`（带本地卷名覆盖） | 通过；`sandbox-mcp` 为 `target: facade`、`enterprise-sandbox-mcp:latest`、node healthcheck |
| 镜像构建 | `docker compose build sandbox sandbox-mcp` | 前一次因 OrbStack 代理拉取 `docker/dockerfile` 前端 `auth.docker.io … EOF` 失败（环境问题，同 S2a/S2b 证据），重试通过 |

## slim 镜像内容（一次性容器）

| 检查 | 结果 |
|---|---|
| 运行身份 | `uid=10001(sandbox) gid=10001(sandbox)` |
| 工具 | `bwrap`、`chromium`、`python3`、`curl`、`bun` 均不存在；`apt-get`、`setpriv` 来自 `node:22-slim` 基础镜像 |
| 依赖 | `node_modules/mysql2`、`node_modules/@deepseek-ai` 不存在；`node_modules` 64MB |
| 发布文件 | `dist/` 只有 `mcp-main.js`、`http/node-listener.js` 与 `mcp/*`（含 `.d.ts` / `.map`）；`/app/contract` 只有 `package.json` 与 `dist/{dbpm-config,dbpm,endpoint-failover}.js`；`node_modules/@pi/contract` 指向 `../../../contract` |
| 权限 | 运行用户 `touch dist/probe` 失败（只读） |

## 运行栈（新镜像）

| 检查 | 结果 |
|---|---|
| 容器 | `pi-enterprise-sandbox-mcp` 使用 `enterprise-sandbox-mcp:latest`，healthcheck healthy；日志正常监听 8082 |
| facade 探针 | `/health` 200；`/ready` 200（`redis: ok`、`sandbox: ok`） |
| 执行面探针 | `/ready` 200（database / storage / isolation 全 ok） |
| 真实 MCP 调用（`node:22-slim` 经 `sandbox-mcp:8082/mcp`） | `initialize` 200；`tools/list` 返回 6 个工具；`sandbox_file_write` 成功并返回 `context_id`；同一 `context_id` 的 `sandbox_python_execute` 读回 `S2E_FACADE_OK`；错误 token 与缺 `Authorization` 均 401 |

## 真实链路（经 `api-server:4000`）

| 步骤 | 结果 |
|---|---|
| 注册 / 登录 | 200 / 200 |
| 带工具 Run | `SUCCEEDED`，`bash:succeeded` |
| 后台进程 | logs 200，`TICK-1…TICK-5`；`SIGTERM` 200，最终 `cancelled` |
| 跨租户 | B 访问 A 的 run / conversation / tools / process 全 404；A 全 200 |

## 未做 / 边界

- 单测在宿主 Node v23.11.0 上运行，未在容器内复跑。
- `sandbox_artifact_submit` 与签名下载链接未在本次调用中覆盖（桥路由代码未改）。
- 基础镜像仍含 `apt-get`、`setpriv` 等系统工具；未评估 distroless / 更小基础镜像，也未做镜像漏洞扫描。
- 生产 overlay 未单独渲染 `sandbox-mcp` 的镜像字段（overlay 不覆盖 build / image，继承开发 Compose）；K8s 部署清单与镜像推送未做。
