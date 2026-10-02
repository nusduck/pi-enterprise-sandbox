# 2026-10-02 清库重建后的真机链路（E1–E3 / C7 / H1 / H2 取证）

**对象：** `main` @ `21c66561`（工作树干净）从空库重建的 compose 开发栈。
**runtime：** Node 22.23.3（测试容器）；MySQL 5.7、Redis 5.0.14；模型 `deepseek-flash`（经 `LLMIO_BASE_URL` 网关）。
**范围声明：** 单租户内的两个账号（`admin` / `userb`，同属 `org_bootstrap`）；这是**开发栈**证据，不是目标环境。

## 重建过程

1. `docker compose down -v` 清空 MySQL / Redis / `agent_user_skills` 三个命名卷，清空 `.runtime/sandbox/*`。
   （比 [development-reset](../runbooks/development-reset.md) 的范围更大：同卷里的其他库与已启用 Skill 一并清掉，是用户明确要求。）
2. `docker compose build agent agent-worker api-server sandbox sandbox-mcp frontend`，`up -d` 全部重建。
3. 空库下 agent 与 exec 都按设计 fail-closed（`schema verification failed, refusing to start`）；
   用 `scripts/dev/schema-apply.sh` 建表，清单核对 `{"ok": true, "drifts": []}`（迁移 0001–0039）。
4. 10 个服务 healthy；注册 `admin`（`SANDBOX_AUTH_ADMIN_USERNAMES`）与 `userb`。

## 一轮带工具的 Run

提示：写 `hello.py` → 后台 `sleep 300` → 运行 → `submit_artifact`。Run `01M3WMGDCAE10BQ5TJ8ERPF8AX` 终态 `SUCCEEDED`，
工具账本：`write` / `bash` ×3 / `submit_artifact` 均 `succeeded`。

## 观察到的事实

| 项 | 操作 | 结果 |
|---|---|---|
| E1 | 该会话 `write` 了 `hello.py` 之后列产物 | 仅 1 个产物（`submit_artifact` 那个），`write` 没有自动产出产物 |
| E2 | `GET /api/artifacts?session_id=` | `hello.py`，sha256 `74a9483f…153ca`，23 字节 |
| E2/E3 | `GET /api/files/artifact-download` | 200；下载字节 sha256 与账本一致，内容 `print('live-chain-ok')` |
| E3 | 同一 URL：`userb` / 未登录 | 404 / 401 |
| C7 | `GET /api/processes?session_id=` | `sleep 300` 为 `running`；`/logs` 200 |
| C7 | `userb` 对该进程 `/logs`、`/kill` | 均 404；之后进程仍 `running`（没被越权终止） |
| C7 | `admin` `/kill`（正对照） | 200，进程转 `cancelled` |
| H1 | `userb` 访问 admin 的 run / events / tools / processes / artifacts / conversation | 全部 404；admin 自己 200 |
| H2 | `GET /api/files/download` 的 `path` 为 `hello.py` / `../../etc/passwd` / `/etc/passwd` | 200 / 400 / 400 |
| H4 | sandbox 容器内 `id` | uid 10001，`CapEff = 0` |

## 测试

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 223 通过 |
| contract | 159 通过 |
| agent | 1947 通过 |
| api-server | 304 通过 |
| frontend | 619 通过；`vite build` 通过 |
| tsc | exec / contract / api-server / agent（主程序 + runtime）通过 |
| exec | 478 个中 467 通过、4 失败、7 跳过（见下） |

**exec 的 4 个失败**：在 `node:22` 通用容器里跑，缺 bwrap 且进程带 capabilities（`capabilityDropPrefix` 两条、
`isolation is the only spawn path`、`bwrap still launches…`）。在 `enterprise-sandbox` 镜像里、用 compose 同款
`cap_add` / seccomp / `systempaths=unconfined` 以 uid 10001 复跑 `shell-executor.test.ts` +
`isolation-bubblewrap.test.ts`：29/29 通过。**exec 其余文件没有在该环境整套复跑**。

**依赖卷：** `dshdev-api-nm` 缺 SSO 新增的 `openid-client` / `jose`，`npm ci` 刷新后 api-server 类型检查与测试通过。

## 边界与未覆盖

- 两个账号同属一个组织，「跨租户 404」证的是跨用户 / 会话作用域；跨组织未单独构造。
- 模型网关：`deepseek-*` 在测试期间一度对 `chat/completions` 挂起（`/models` 正常），恢复后才跑通；
  创建 Run 时传 `model_id`：Run 详情的 `model_id` 取自版本配置、未固定即为 `null`，据此不能判断请求是否生效；后续已查明参数**生效**（见 [补证](2026-10-02-acceptance-gates-a2-a3-c4-h2-h3-f2.md) §五）。
- 没有跑：C4 并发隔离 / 配额 live gate、C8 5GiB、H3 live、A2/A3/A5 的审批停泊与 MCP 合法调用、F2 流式 gate、H5/H6 生产抽样。
- 手写的 bwrap 路径逃逸探针失败（镜像无 `/lib64`，是探针命令的错），没有重跑，H2 的 bwrap 层仍只有离线用例。
