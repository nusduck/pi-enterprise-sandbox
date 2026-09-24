# 验证记录：release gate 修复、容器内运行器与 FsError 错误码映射

日期：2026-09-14。承接 D1–D4（[统一 design](../design/updrdb-dbpm-deployment.md)），在另一台开发机（macOS）上
重建开发栈复验 D4，并修复复验中发现的问题。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`ecda592e` + 本次未提交改动（随本证据同一 commit） |
| 宿主机 | macOS，宿主 Node v26.5.0（**不作为验收版本**）；Python 3.11.15（uv） |
| 测试运行时 | 全部在容器内：`node:22-slim`，Node v22.23.2 / npm 10.9.8 |
| 开发栈 | MySQL 5.7.44（`mysql57_dev_data`）、Redis 5.0.14 + `noeviction`（`redis5_dev_data` / `sandbox_replay_redis5_dev_data`）、`dbpm-fake` |
| 镜像（重建，容器已确认换新） | `pi-enterprise-agent` `2654c204b251`（agent / agent-worker）、`enterprise-sandbox` `e8b174b24d1c`（sandbox / sandbox-mcp） |
| 历史数据 | 按用户决定删除旧卷 `mysql_dev_data`（8.0）、`redis_dev_data`、`sandbox_replay_redis_dev_data` 与临时测试库；本地 `.env` 卷名改为新卷 |

## 发现与根因

| # | 现象 | 根因 | 引入点 |
|---|---|---|---|
| 1 | `agent-worker-restart` gate 两个恢复用例失败，Worker 子进程 exit 1、stderr 为空 | fixture 在被测库建 `release_gate_worker_side_effects`，Worker 启动 schema 核对报 `SCHEMA_DRIFT extra_table` 拒启（fatal 写在 stdout，gate 不打印） | D3 启动核对；D3 证据记录 gate 未实跑 |
| 2 | `redis-restart` gate AOF 用例失败：`ERR unknown command WAITAOF` | `WAITAOF` 为 Redis 7.2 命令，基线已降到 5.0.14 | D4 只改了镜像断言，gate 未实跑 |
| 3 | `bullmq-worker-restart` / `agent-worker-restart`（及 dsh gate）子进程 `ERR_MODULE_NOT_FOUND …/src/…js` | 子进程用裸 `node` 起 fixture，没有 tsx 加载器；源码已迁到 `.ts` | TS 迁移后遗留 |
| 4 | sandbox 日志大量 `exec fs-error /internal/v1/fs/resolve|list INTERNAL_ERROR`（D2b 证据「观察到但未定位」） | exec / agent 与 contract 各装一份 `@deepseek-ai/dsh-fs`；contract `toWireError` 的 `instanceof FsError` 对调用方 FsError 为假，所有 `FS_*` 错误码降级为 `INTERNAL_ERROR` 返回模型 | 早于本分支 |
| 5 | exec 在装有 bwrap 的环境里 `preflightCheck(): a real bwrap accepts the preflight profile` 失败：`execvp /usr/bin/true: No such file or directory` | 测试传入无挂载的 `minimalProfile()`，与函数约定的 `preflight.ts` 探针 profile 不符；CI 与 macOS 无 bwrap，此用例一直 skip | 早于本分支 |

复现方式：1–3 由修复前在宿主机 + 专用 Redis 容器实跑 gate 得到；1 另用预加载模块转写 fixture stdout 取得 fatal 原文。
4 在运行中的 sandbox 容器里用 exec 的 `FsError` 调 contract 的 `toWireError`，得到 `{"code":"INTERNAL_ERROR"}`；
新增回归用例在修复前于 Node 22 容器中失败（expected `FS_NOT_FOUND`，actual `INTERNAL_ERROR`）。5 在非 root、`CapEff=0`、
bwrap 0.8.0 + 仓库 seccomp profile 的容器中复现。

## 改动

- gate：副作用表改放兄弟库 `<gate db>_side`（fixture 新增 `TEST_SIDE_EFFECT_SCHEMA`，要求 `pi_gate_*`）；`WAITAOF` 改为
  `BGREWRITEAOF` + 轮询 `INFO persistence` 至重写完成且 `aof_last_bgrewrite_status:ok`；三个 gate 子进程以
  `--import <tsx>` 启动。
- 新增 `scripts/dev/release-gates.sh` + `scripts/dev/release-gate-runner.Dockerfile`：按工作树构建 Node 22 运行器（依赖与源码在镜像内），
  接入开发栈网络，自带专用 Redis 5.0.14 与 `pi_gate_dev` / `pi_gate_dev_side`，结束即清理，任一项失败非零退出。
- contract `isFsError`：`instanceof` 之外按 dsh-fs 声明的错误码（`Record<FsErrorCode, true>`）做结构判断，任意 `code` 不透传。
- exec 测试：真实 bwrap 用例改用 `buildPreflightProfile()`。
- 文档：`development.md` 运行方式、CHANGELOG Fixed、design §3.3 S1 草案（另见 PROCESS_LOG）。

## 验证结果

| 项 | 命令 / 环境 | 结果 |
|---|---|---|
| 放行测试 + release gate | `scripts/dev/release-gates.sh`（Docker 运行器） | UPRedis 直连 6 pass / 1 skip（负对照仅代理目标）；经路由模拟代理 7 pass；redis-restart 4/4；bullmq-worker-restart 2/2；agent-worker-restart 3/3；脚本 exit 0 |
| contract | Node 22 容器，`npx tsc --noEmit` + `npm test`（含仓库 golden fixture） | tsc 通过；99/99 |
| exec | Node 22 容器，uid 10001、`--cap-drop ALL`、`exec/seccomp-bubblewrap.json`、bwrap 0.8.0 | tsc 通过；369/369，0 skip |
| agent | Node 22 容器，`npm run typecheck` + `npm test` | typecheck 通过；1300 / 1297 pass / 0 fail / **3 cancelled**（`remote-providers.test.ts:459/486/525`，与 D2b 证据在 `037fccf4` 上复现的同一组，**不记为通过**） |
| api-server | Node 22 容器，typecheck + test | 通过；159/159 |
| frontend | Node 22 容器，test + build | 367/367；build 通过 |
| 仓库卫生 | 宿主 `uv run pytest -q` | 123 passed |
| 真实链路 | 新镜像；客户端在 Node 22 容器内经 `api-server:4000` | 登录 → 建会话 → 带工具 Run `SUCCEEDED`（`bash:succeeded` ×2）→ 后台进程 logs `TICK-1…5` → SIGTERM → `cancelled` → B 访问 A 的 run / tools / conversation / process 全 404，A 全 200 |
| FsError 映射线上效果 | 同一 Run 后统计 sandbox 日志 | `INTERNAL_ERROR` 0 行；现为 `fs/resolve FS_SANDBOX_DENIED` 40 行、`fs/list FS_NOT_FOUND` 10 行 |

## 未做 / 边界

- `agent-worker-dsh-restart` gate 只修了子进程加载器，未跑（需要独立 sandbox、HMAC 与 fake provider 资源）。
- 修复前 1–3 的复现在宿主机 Node 22.23.2（下载到临时目录）上完成，修复后验证全部在容器内；未在容器内复跑修复前版本。
- 真实链路中每个 Run 约 40 次 `FS_SANDBOX_DENIED`：DSH 探测工作区外路径被正确拒绝，未逐条核对探测来源。
- exec 带 bwrap 的测试环境是临时 Dockerfile，未脚本化；CI exec job 仍不安装 bwrap，该用例在 CI 中继续 skip。
- 真实 UPRedis / UPDRDB / DBPM 目标环境验收仍未做，同 D2–D4 证据。
