# 2026-10-03 集成真实链路：通知场景、HiAgent 委派、部门预留与三个缺陷修复

**范围：** 单组织（`org_bootstrap`）开发栈，Docker Desktop（macOS）上的 Compose，不是目标环境。

## 一、验证对象

集成分支 `integration/2026-10-03`（未推送）= `main @ ff929279` + 以下 6 个分支，加一份由影子库全量重放生成的
schema manifest（`20261003000001`–`3`）：

| 分支 | PR | 内容 |
|---|---|---|
| `fix/agent-ledger-and-errors` | #82 | 无活 Worker 时取消 Run，工具账本行随终态收尾 |
| `fix/exec-single-instance` | #83 | exec 启动入口执行单实例断言 |
| `fix/bff-process-kill-sigkill` | #84 | `kill` 未指定信号时发 SIGKILL |
| `feat/hiagent-delegation` | #85 | 远端委派接入火山 HiAgent（多轮续聊） |
| `feat/notification-scenarios` | #86 | 待我审核 / 定时任务完成 / 定时任务等待处理邮件 |
| `feat/department-reservation` | #87 | 记录 SSO 部门 claim 并在成员页展示 |

- 运行时：Node 22（`node:22-slim`），MySQL 5.7，Redis 5.0.14，`runtime-versions.json` 未改。
- 镜像：在集成 worktree 里 `docker compose -p pi-enterprise-sandbox build agent agent-worker api-server sandbox
  sandbox-mcp frontend`；运行容器的镜像 ID 与新构建一致（agent / agent-worker / api / sandbox 逐一核对）。
  `sandbox-mcp` 命中缓存——facade 只打包 `mcp-main.ts` 的 import 图，本批改动不在其中。
- 迁移：服务启动不迁移（ADR 0011 D6）。在影子库导出发布包，**只把新增的 0040–0042 三段**按顺序执行到开发库
  （首错即停），再用 `cli-schema verify` 核对：`drifts: []`。
- 启动：`--profile sso-dev`、`--env-file .env --env-file .runtime/sso-dev.env`，另用一个不提交的覆盖文件补
  `SSO_DEPARTMENT_CLAIM`（该分支漏写进 compose，已补提交）与开发假 AppKey；shell 变量开邮件通知（mailpit，
  `NOTIFY_MIN_RUN_DURATION_MS=10000`）并登记 `hi-helper`（`protocol: hiagent`，指向开发假服务
  `scripts/dev/fake-hiagent.mjs`）。K8s `dsh-dev` 已删除命名空间，不再与 Compose 抢 Run。
- 账号：`admin`（本地）；`user`、`user2`、`reviewer`、`nomail` 经 mock-oidc 登录，claims 带 email / department
  （`nomail` 不带邮箱）。
- 驱动：Docker 内 Playwright（`mcr.microsoft.com/playwright:v1.55.0-noble`），容器内把 `localhost:3000` / `:8090`
  转发到 frontend / mock-oidc，API 均在已登录页面同源 `fetch`。模型为真实 LLMIO 网关（通用智能体默认模型）。
- 替身边界：HiAgent 用开发假服务（协议按官方 SDK 源码实现）；邮件用 mailpit 捕获，未经真实 SMTP 网关。

## 二、结果

阶段 1（16/17，失败项见下方「kill」说明）

| 检查 | 结果 |
|---|---|
| 四个账号 SSO 登录；`reviewer` 带 `reviewer` 角色 | 通过 |
| `GET /api/auth/profile` 返回四个通知开关与 `editable_fields`，能力 `available:true, min_run_duration_ms:10000` | 通过 |
| 非布尔开关 → 422 `AUTH_INPUT_INVALID`；「运行完成」开着时清空邮箱 → 422 `NOTIFY_EMAIL_REQUIRED` | 通过 |
| 无邮箱用户：三个默认开的开关不阻止保存资料 | 通过 |
| 一轮带工具的 Run（两次 bash）SUCCEEDED，工具账本全部终态 | 通过 |
| 后台长进程登记、日志可读；`kill` 后忽略 TERM 的进程结束 | 通过 |
| `kill` 响应体显示 SIGKILL | **脚本断言错误**：响应是 exec 作业快照（`detail: killed: SIGTERM`），见「新发现 1」 |
| 同组织另一用户读 Run / 会话 / 进程 / 工具账本一律 404；本人可读（对照） | 通过 |

阶段 2（23/24，失败项为脚本按不存在的 `run_id` 字段匹配审核任务；任务实际已产生，见下）

| 检查 | 结果 |
|---|---|
| 成员列表 `department`：user 工程部、user2 产品部、reviewer 质量部，无 claim 的为 null；非 admin 403 | 通过 |
| HiAgent 第一轮：`delegate_to_remote_agent` 经审批后成功，远端 `echo[1]` | 通过 |
| HiAgent 第二轮（同会话追问）：续用同一远端会话，远端 `echo[2]` | 通过 |
| 库：每个平台会话一行 `tbl_agsvc_remote_conversations`；假服务日志 `fake-conv-2 round=1/2` | 通过 |
| 审核型智能体 Run SUCCEEDED，产生 PENDING 审核任务（发起人「普通用户」） | 通过（人工核对 `/api/reviews`） |
| 非法 `notify_policy` → 400 | 通过 |
| 三个定时任务立即触发：always → SUCCEEDED；failure → SUCCEEDED；等待审批 → `WAITING_APPROVAL` | 通过 |
| mailpit：reviewer 收到「【待审核】」，发起人没有；user 收到「【定时任务】…运行成功」「【定时任务】…等待你审批」；failure 策略成功时无邮件；普通 Run 收到「[任务已完成]」 | 通过 |
| 投递账本：`run_terminal` / `review_pending` / `cron_terminal` / `run_waiting` 各以 `dedupe_key` 一行 `sent` | 通过 |
| `docker restart` worker 后邮件总数不变（8 → 8） | 通过 |

阶段 3（4/4）：工具账本收尾

前台 `sleep 180` 的 bash 进入 RUNNING → `docker kill` worker → 重启后恢复扫描保持 Run 与工具 RUNNING（副作用未知，
转人工）→ 用户取消 → Run `CANCELLED`，bash 行 `UNKNOWN / RUN_CANCELLED_OUTCOME_UNKNOWN`，`completed_at` 非空。

exec 单实例：重建的 sandbox 缺省配置 healthy；同镜像 `EXEC_CONCURRENCY=2` 启动输出
`exec single-instance check failed, refusing to start` 并退出。

阶段 4（6/6）：浏览器走查

账户设置「邮件通知」四个开关，「待我审核」只对 reviewer 显示；定时任务表单「高级选项」里「完成后通知」默认「仅失败时」；
成员页有「部门」列。截图发现开关组是浏览器默认 fieldset 边框，已在通知分支修正（未重新截图）。

## 三、新发现（未在本批修复）

1. **exec `signal` 端点无视信号种类**：`JobRegistry.signalInternal` 先调用活句柄 `cancel()` 结束整个作业，再补发指定信号。
   发 `SIGINT` / `SIGUSR1` 这类本意不终止的信号也会结束进程。2026-08-26「忽略 TERM 的循环 kill 两次还在跑」在 TS exec 上已不成立。
2. **SSO 首次登录不记最近登录时间**：`user2`、`nomail` 本次首次经 SSO 登录，成员页「最近登录」显示「—」；再次登录的账号正常。
3. **设置面板身份行**：reviewer 显示「reviewer · 普通用户」，没有体现审核员角色（用户菜单里已是「审核员」）。
