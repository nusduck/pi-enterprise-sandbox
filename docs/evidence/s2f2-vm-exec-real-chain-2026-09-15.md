# 验证记录：Agent / Worker / BFF / sandbox-mcp 指向 VM exec 的真实链路（openEuler 24.03 容器）

日期：2026-09-15。对应 [统一 design](../design/updrdb-dbpm-deployment.md) §9 与 §11 S2 的真实链路要求；补
[S2f VM release](s2f-vm-release-2026-09-15.md)「未做」中「sandbox-mcp 与 Agent / BFF 指向 VM exec 的真实链路」。
工具链 smoke 见 [S2f-2 续](s2f2-openeuler-toolchain-smoke-2026-09-15.md)。用户 2026-09-15 同意临时替换开发栈执行面。

> **结论：** 登录 → 建会话 → 带工具 Run → 后台进程 logs / signal → 跨租户 404 经 VM exec 通过（14 项断言 13 项通过；
> 未通过的一项是驱动自身的判定写法，见下）。仍是共享宿主内核的特权容器，不是目标 VM 验收。

## 代码与环境

| 项 | 值 |
|---|---|
| 分支 / 基线 | `refactor/updrdb-dbpm`，`7279050d`；工作区另有无关的 `docs/reviews/2026-09-01-full-regression/` 在途改动 |
| 执行面 | openEuler 演练容器 `pi-vm-sim` 内 systemd `pi-exec`，release `exec-66b2ab0f0397-arm64-dirty-20260915121849`（与 smoke 同一 release，`exec/` 自 `66b2ab0f` 起无改动） |
| 消费者 | `docker compose build agent agent-worker api-server sandbox-mcp`（HEAD）后 `up -d --no-deps --force-recreate`；`sandbox-mcp` 为 slim facade 镜像 `enterprise-sandbox-mcp:latest` |
| 接线 | `docker compose stop sandbox`；`pi-vm-sim` 以网络别名 `sandbox` 接入 `backend-internal`，消费者的 `http://sandbox:8081` 不改配置即指向 VM exec |
| 数据库 | VM exec 改用开发库 `sandbox`（与 Agent 同一账本库），口令经开发栈 `dbpm-fake` 取；切换前 `exec_jobs` 无 `running` / `stopping` 行 |
| 服务间凭据 | 演练现生成的 HMAC keyring / kid、`SANDBOX_API_TOKEN`、`SANDBOX_MCP_INTERNAL_TOKEN`，以 shell 环境覆盖 `.env` 重建消费者、同值写入 VM `exec.env`；未复用开发栈凭据 |
| 模型 | 开发栈配置的真实模型（`MODEL_ID=deepseek-v4-flash`），非 fake provider |
| 驱动 | 宿主 Node 脚本经 `http://127.0.0.1:4000`（BFF）以浏览器 Cookie 调用，不直连内部面 |

## 切换后就绪

| 检查 | 结果 |
|---|---|
| VM exec `/ready`（切库重启后） | `database / storage.* / isolation` 全 ok |
| agent / agent-worker / api-server / sandbox-mcp | 均 healthy；BFF `/health/ready`：`agent ok`、`sandbox ok` |
| sandbox-mcp → `http://sandbox:8081/ready` | 首次（消费者重建后约 40s）`not_ready`、`database: unavailable`；随后复查 ready，VM 内同时刻自查 `database: ok`、到 mysql / dbpm-fake TCP 正常。见「发现」 |
| sandbox-mcp 自身 `/ready`（`127.0.0.1:8082`） | `redis ok`、`sandbox ok` |

## 真实链路（经 BFF）

| 步骤 | 结果 |
|---|---|
| A、B 注册 / 登录 | 200 / 200，均得到 `pi_enterprise_session` Cookie |
| A `POST /api/sessions/ensure` | 200，`conversation 01M2JJ7VFXE16E2M0W2DQX2G6P`、`session 01M2JJ7VFZH48561RV15DZTR26`、`workspace 01M2JJ7VFZH48561RV15DZTR27` |
| A 创建 Run（`Idempotency-Key`） | 202，`run 01M2JJ7VHVRHJAMYNH13R7HDDV`；轮询终态 `SUCCEEDED` |
| 工具台账 `/api/runs/{id}/tools` | 200，`bash:succeeded` × 3（后台启动 TICK 循环、两次前台命令） |
| 进程列表 | 200，1 个 `running` 进程，命令含 `TICK` |
| logs | 200，`TICK-1 … TICK-12` |
| `signal SIGTERM` | 200；进程终态 `cancelled`；`exec_jobs` 行 `killed` / `killed: SIGTERM`；VM 容器内无残留 TICK 进程 |
| B 访问 A 的 process 详情 / logs / signal | 404 / 404 / 404 |
| B 访问 A 的 run / conversation / tools / `sessions/ensure(conversation_id)` | 404 / 404 / 404 / 404 |
| A 访问自己的 run / conversation（对照） | 200 / 200 |

### 作业确实跑在 VM exec 上

- 开发栈 `sandbox` 容器在整个链路期间为 `Exited (0)`，`sandbox` 名字只解析到 `pi-vm-sim`。
- 本次 Run 的工作区 `01M2JJ7VFZH48561RV15DZTR27` 出现在 `pi-vm-sim` 的 `/var/lib/pi-exec/workspaces/` 下。
- 模型在沙箱内列出的 `/etc` 为 `group hosts ld.so.cache localtime nsswitch.conf passwd resolv.conf ssl`，没有 `ca-certificates`——
  openEuler 没有 `/etc/ca-certificates`，Debian 执行面镜像有；`uname -m` 为 `aarch64`。

### 未通过的一项（驱动判定）

驱动要求工具输出含 `openEuler` 作为「跑在 VM 上」的证据。模型按提示执行 `head -2 /etc/os-release`，沙箱内报文件不存在，改读
`/usr/lib/os-release` 同样不存在：openEuler 的 `/etc/os-release` 是普通文件，而 Debian 是指向 `/usr/lib/os-release` 的符号链接，
exec 沙箱只绑定 `/usr` 与 `/etc` 白名单，故 openEuler 上沙箱内看不到发行版信息。判定条件选错，改用上一小节的三条证据；不视为链路失败。

## 发现（未修改）

- **openEuler 上沙箱内 CA 证书不可读（重要）**：openEuler 的 `/etc/ssl/certs` 是指向 `../pki/tls/certs` 的符号链接，而 exec 沙箱 `/etc` 白名单（`exec/src/isolation/build.ts` `STATIC_ETC_FILES`）只绑定 `/etc/ssl` 与 `/etc/ca-certificates`，不含 `/etc/pki`。经 VM exec 内部面在沙箱内实测：`/etc/ssl/certs/ca-bundle.crt`、`ca-certificates.crt`、`/etc/ssl/cert.pem` 均不可读，Python `ssl.get_default_verify_paths()` 为 `None None`。网络模式放开时，沙箱内 pip / curl / requests 等 HTTPS 校验在 openEuler（麒麟同为 RHEL 系布局，需复核）上会失败；Debian 镜像不受影响。修复需改 exec 运行路径并重建验证，另开变更。
- **exec `/ready` 在网络中断后短暂报数据库不可用**：演练对 `pi-vm-sim` 做了网络 disconnect / connect（加别名），之后 sandbox-mcp 首次探测得到
  `database: unavailable`，数秒后恢复。推断为连接池里断网前的连接成为半开连接、`SELECT 1` 在 2s 探针超时内未返回；未复现、未定位。
  与 UPDRDB Proxy 切换、LB 摘流行为相关，需在目标环境做一次断网 / Proxy 切换演练确认恢复时间。
- 沙箱内看不到 openEuler 发行版文件（见上），不影响工具；若有技能依赖 `/etc/os-release` 判断平台，在 VM 上会失败。

## 恢复开发栈

| 步骤 | 结果 |
|---|---|
| VM `pi-exec` | `systemctl stop`，`exec.env` 改回演练专用库 `pi_vm_sim`，避免两个 exec 共用 `sandbox` 库 |
| 网络 | `pi-vm-sim` 去掉 `sandbox` 别名重新接入；`sandbox` 解析回开发容器 |
| 开发 `sandbox` | `docker compose build sandbox`（HEAD）后 `up -d --no-deps --force-recreate`，healthy |
| 消费者 | 不带演练凭据覆盖重建 agent / agent-worker / api-server / sandbox-mcp，均 healthy；BFF `/health/ready` `agent ok`、`sandbox ok` |
| 同一驱动复跑（Debian 执行面） | 13/14：注册登录、Run `SUCCEEDED`、logs、SIGTERM → `cancelled`、跨租户 404 全过；「输出含 openEuler」按预期不成立 |

开发栈五个服务现均为本次 HEAD 构建镜像（此前运行的是 2026-09-06 / 09-15 00:35 的旧镜像）。

## 未做 / 边界

- 前端未经浏览器操作（本次不涉及前端改动，BFF 以 Cookie 直接调用）；审批、上传 / 下载、产物、SSE 事件流未在 VM exec 下单独断言。
- 未验证用户 Skill（S1）经 VM exec 挂载：VM 上 `SANDBOX_USER_SKILLS_ROOT` 为空目录，未接开发栈 `agent_user_skills` 卷。
- sandbox-mcp 外部 MCP 调用（`context_id` 映射、窄桥）未经 VM exec 发起，只核对了其就绪探针。
- 麒麟 / KySec / x86_64 / 目标 VM、LB 与多 Pod 均未覆盖。
