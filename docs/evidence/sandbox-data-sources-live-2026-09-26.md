# 沙箱内连接业务库（数据源）：真实链路验证（2026-09-26）

对应设计：[design/sandbox-data-sources.md](../design/sandbox-data-sources.md)。

## 验证对象

- 分支 `feat/sandbox-data-sources`，基于 `3f57e7a3`；验证时为未提交改动，与本次提交的代码一致（之后只改了文档）。
- 运行时：`runtime-versions.json`（Node 22）。单测在 Linux 容器（`node:22-bookworm-slim` + bubblewrap + python3，
  带 `exec/seccomp-bubblewrap.json`、`apparmor=unconfined`、`systempaths=unconfined`）内、完整仓库布局下执行；
  exec 以 uid 10001 运行，真实 bwrap 用例不跳过。
- 栈：本机 Docker Compose。**已重建并重建容器**：`agent`、`agent-worker`、`api-server`、`sandbox`、`sandbox-mcp`、
  `frontend`（容器创建时间 07:52Z，镜像为本次构建）。
- 临时配置（只经 shell 环境传入，未改 `.env`）：
  - `SANDBOX_DATA_SOURCES_JSON`：一个数据源 `employees` → `mysql:3306` / `biz_demo`，DBPM 条目 `biz_demo` / `biz_reader`；
  - `FAKE_DBPM_EXTRA_ENTRIES`：dbpm-fake 追加该只读账号的开发口令；
  - `AGENT_RUN_QUEUE_PREFIX={compose-ds}`：K8s `dsh-dev` 的 agent-worker 与 Compose 共用 Redis，用独立前缀避免它
    抢走 Run（未缩容 K8s）。
- 业务库：在 Compose 的 mysql 里建 `biz_demo.employees`（5 行）与只读用户 `biz_reader`（仅 `SELECT biz_demo.*`）。
- 模型：本地配置的真实模型网关（DeepSeek Flash）。

## 单测与检查

| 命令 | 结果 |
|---|---|
| `npm test --prefix contract` + `tsc --noEmit` | 123 pass；通过 |
| `npm test --prefix exec`（uid 10001，含 `datasource-bwrap.test.ts` 真实 bwrap）+ `tsc --noEmit` | 445 pass / 0 fail / 1 skip；通过 |
| `npm test --prefix api-server` + `typecheck` | 176 pass；通过 |
| `npm test --prefix agent`（含 `boot.test.ts`、`mcp-live.test.ts`）+ `typecheck` | 1547 pass；通过 |
| `npm test --prefix frontend` + `npm run build --prefix frontend` | 423 pass；构建成功 |
| `uv run pytest -q` | 226 passed |
| `docker compose config -q` | 通过（生产 overlay 需要真实密钥插值，未校验） |

exec 以 root 运行时有 4 个既有用例失败（进程带 capability、以 root 跑 bwrap 相关），与本次无关；生产按非 root 运行。

隔离层复现（设计 §8 第 1 步）：同一容器里 `bwrap --unshare-net` 的子进程经只读挂载（目录 0555）的 unix socket
收到宿主进程的回包；`connect(1.1.1.1:443)` 与 `connect(172.17.0.1:3306)` 均为 `Network is unreachable`，
`/proc/net/dev` 只有 `lo`。

## 真实链路（浏览器 → BFF → agent → agent-worker → 真实模型 → exec → 业务库）

| 场景 | 结果 |
|---|---|
| 设置页新建智能体：「数据源」tab 列出 `员工库（演示） employees … MYSQL`，不显示地址与账号；勾选后草稿 JSON 为 `"dataSources":[{"id":"employees"}]` | PASS（浏览器操作） |
| 在 JSON 里加目录外的 `{"id":"sales"}` → 数据源 tab 显示「sales 已保留 · 当前部署未登记」；创建时服务端返回 `dataSources[1].id — Data source "sales" is not registered on this platform`，挡住创建 | PASS |
| 取消 `sales` 后创建 `ds-analyst` v1 | PASS |
| `ds-analyst` 会话「查每个部门人数和平均薪资」：模型经 `/run/dsh-db/employees/mysql.sock` 用 pymysql 查询，结果 finance 2 / 19,500、rd 2 / 28,500、hr 1 / 15,000，与直接查库一致 | PASS |
| 同一会话让模型不带凭据探测 `mysql:3306`：`DNS FAIL: [Errno -3] Temporary failure in name resolution`（子进程无网络） | PASS |
| 后台作业：`sleep 3` 后经 socket 查询 → `completed`、exit 0、`job_output` 读到结果；另起 `sleep 300` → `job_kill` 后状态 `killed` | PASS |
| exec 日志每个连接一条 `{"event":"data_source_connection","dataSourceId":"employees",requestId,orgId,userId,workspaceId,agentSessionId,durationMs,bytesToDatabase,bytesFromDatabase,"closeReason":"client_closed"}`，共 7 条，不含 SQL 与数据 | PASS |
| 全部执行结束后 `$SANDBOX_CONTROL_ROOT/dbs/` 下残留目录数为 0 | PASS |
| `ds-analyst`：`ls /run/dsh-db; env \| grep -c ^DSH_DB_` → `employees`、`6` | PASS |
| 默认智能体（未绑定数据源）同一命令 → `No such file or directory`、`0` | PASS（反向对照） |
| sandbox 启动：DBPM 取到数据源口令（无 unavailable 告警）；对本地 `.env` 里的 `SANDBOX_EXEC_ENV_DB_PWD` / `DB_DSN` 打印开发环境告警，未拒启 | PASS |

侧栏顺带确认：当前选中并悬停的会话行同时显示智能体标签与删除按钮（`3f57e7a3` 的修复）。

## 未覆盖

- **输出脱敏的真实链路**：让模型把含口令的环境变量打印出来的操作被本机自动权限规则拦下（凭据落地），没有做。
  脱敏由 `exec/test/datasource.test.ts` 覆盖：前台结果全文替换；后台输出里口令被切在两次读取之间时，第一次
  读取不含口令片段，作业结束后整体替换为 `***`。模型在真实链路中自行拒绝了回显口令，只报告了长度。
- **跨租户 404**：本次未改鉴权与 org 作用域，未重跑（另一租户身份需要口令）。
- DBPM 取密失败时的 `DATA_SOURCE_UNAVAILABLE`：只在单测与路由测试覆盖，未在真实栈上演练。
- 业务库强制 TLS、口令轮换：2026-09-26 已定为不强制、不轮换，无需实现。
- 测试智能体 `ds-analyst`、演示库 `biz_demo` 与用户 `biz_reader` 留在本地开发库中。
