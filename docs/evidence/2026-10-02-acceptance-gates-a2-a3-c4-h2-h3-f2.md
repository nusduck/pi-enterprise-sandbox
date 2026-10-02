# 2026-10-02 验收 gate 补证：A2/A3、C4、H2/H3、F2，以及 exec 整套

**接上一份：** [`2026-10-02-clean-rebuild-live-chain.md`](2026-10-02-clean-rebuild-live-chain.md)（同一次清库重建）。
**对象：** `main` @ `21c66561`（工作树仅有 docs 改动）；`scripts/dev/k8s/up.sh dev` 恢复后的开发栈：
K8s `dsh-dev` 跑 agent / agent-worker / api-server / frontend / sandbox-mcp，Compose 提供 MySQL 5.7、Redis 5.0.14、
dbpm-fake 与 exec（`sandbox`）。模型 `deepseek-flash`，经 `LLMIO_BASE_URL` 网关。
**替身边界：** dbpm-fake 取密；其余（HMAC 内部面、真实 bwrap、真实 MCP `exa`、真实模型）无替身。
**范围：** 单组织（`org_bootstrap`）开发栈，不是目标环境。

## 一、A2 / A3：审批停泊 → 放行一次，MCP 合法调用

新建智能体 `gate-mcp-agent`：`mcpServers: [{serverId: exa, enabledTools: [web_search_exa]}]`，`skillPolicy.system: none`。

| 步骤 | 观察 |
|---|---|
| Run 请求搜索 | 状态 `WAITING_APPROVAL`；工具台账 `mcp__exa__web_search_exa waiting_approval`；审批 `pending`、`risk_level: high`、`reason: … requires approval`、带完整 arguments |
| 批准前 | 无该工具的执行结果（台账只有停泊行） |
| 另一账号查看 / 批准 | 均 404；审批仍 `pending`（越权没有改变状态） |
| admin 批准 | `status: approved, changed: true`；Run 经 `RUNNING` 到 `SUCCEEDED` |
| 重复批准 | `changed: false, queued: false`，没有第二次执行 |
| 账本（MySQL 直查） | 该 Run 仅 1 行 `mcp__exa__web_search_exa`，`SUCCEEDED`；全库 `tool_executions` 无 `RUNNING` 残留 |

对照：`gate-bash-approval`（`toolPolicy.tools.bash = require_approval`）同样走完停泊 → 批准 → `SUCCEEDED`，
账本 1 行、`SUCCEEDED`、`result_json` 非空。

**复核旧记录：** [agent-delegation-live-2026-09-24](agent-delegation-live-2026-09-24.md) 发现 2
（审批恢复后原调用行停在 `RUNNING`）在本栈上**没有复现**（上面两条 Run 都只有 1 行终态行）。
不能据此断言已修复——只能说在这个版本、这两种工具上不复现。

未做：浏览器里的审批中心操作；本次用 API 驱动，审批 UX 不在这份证据范围内。

## 二、C4 / H2 / H3：真实 bwrap 隔离探针

探针在 agent 容器内用生产的 `ExecRpcClient`（真实 HMAC）打真实 `sandbox` 的 `/internal/v1/*`，
每个断言配正对照。**12 / 12 通过**（主 exec）+ **4 / 4 通过**（低阈值配额 exec）。

| ID | 断言 | 结果 |
|---|---|---|
| ctl | 工作区内写入再读取 | 成功，uid 10001 |
| C4 | namespace 内 rlimit | `ulimit -u/-n/-t/-f` = `40 / 256 / 900 / 524288`，与 compose 渲染值一致 |
| C4 | 60 个自行退出的 `sleep` 的 nproc 上限 | 实际起来 37 个，其余 `[Errno 11] Resource temporarily unavailable` |
| C4（对照） | 额度内 5 个 | 5 / 5 成功 |
| C4 | 两个 owner 并发各跑 `sleep 3` | 都成功，耗时 3036 / 3027 ms（真并发，不是串行） |
| C4 | owner B 看 owner A 的文件 | B 的工作区为空，宿主根不存在，全盘搜不到 A 的文件 |
| C4（对照） | owner A 读自己的文件 | 成功 |
| C4 配额 | 低阈值 exec（`SANDBOX_WORKSPACE_QUOTA_MB=2`）：额度内命令 | 成功 |
| C4 配额 | 超限写入（每 0.3 秒 100 KB，计划 4 MB） | 执行中被终止：`exit 126, denied`，`workspace 2700003 > quota 2097152`；宿主上实际落盘 2.7 MB |
| C4 配额 | 越线后的新命令 | 同一原因被拒，未 spawn |
| C4 配额 | 另一个 owner | 不受影响 |
| C4 重启 | 重启该 exec 容器后 owner A 再发命令 | 仍被同一原因拒绝，落盘 2704 KB 与重启前一致 |
| H2 | 越过 bwrap：`/etc/shadow`、`/var/sandbox`、`/var/sandbox/workspaces`、`/proc/1/environ` 中的密钥、指向它们的符号链接 | 全部 `FileNotFoundError`；pid1 环境不含 `HMAC` / `KEYRING` |
| H2 | `/usr`、`/bin`、`/lib` 写入 | 全部只读错误；`/etc` 可写但只在命名空间内，第二次运行里不存在 |
| H2 | 能否看到 exec 进程 | 看不到（0 个 node/tsx/exec） |
| H2 | 网络 | 无（`Could not resolve host`） |
| H3 | skill 树，绑定 `docx`、`grill-me` | 只列出这两个包；包内创建 / 追加 / 删除均 `EROFS`（errno 30）；读取成功（对照） |

**两点说明：**

1. exec 在 bwrap 之前还有一层**词法黑名单**（`blocked-commands.ts`，`dangerous command denied`）。我最初的探针命令
   （`cat /etc/shadow`、`ln -s` 等）被它拦下，测到的是这一层而不是 bwrap。上表 H2 的结果是用 `python3` 在脚本里拼接路径、
   绕过词法层后直接打 bwrap 得到的。
2. skill 根目录 `/home/sandbox/skill` 本身是命名空间内的 tmpfs：`mkdir` 在根上**能成功**，但只在当次 Run 内存在——
   同 owner 的下一次运行、另一个 owner 都看不到（已查）。包内容全部只读。

## 三、F2：A2A 流式终态帧

签发凭据 → 读 Agent Card（v0.3，`streaming: true`）→ `message/stream`：
未带凭据 401；带凭据 5 帧：`task` → `status-update submitted` → `working` → `working` → `status-update completed final=True`。
验证后已吊销凭据（吊销后再用同一 token 返回 401）。

## 四、exec 整套测试

在 `enterprise-sandbox` 镜像里、uid 10001、compose 同款 `cap_add` / seccomp / `systempaths=unconfined` 下：
`npm test --prefix exec` **478 / 478 通过、0 跳过**。上一份证据里通用 `node:22` 容器中的 4 个失败和 7 个跳过，
在这个环境里都通过 / 都执行了，证实是环境差异。

## 五、`model_id` 与网关

- 创建 Run 的 `model_id` 是**生效**的：未注册模型 → 400 `Model "no-such-model" is not registered`（说明参数被校验并消费）。
  上一份证据里"`model_id` 不生效"的说法没有依据，**撤回**。
- qwen 的 Run 失败（`DeepSeek API error (HTTP 500)`）是网关侧：直连网关 `qwen3.8-27b` 当时返回
  `500 balancer pop err: no provide items or all items are disabled`（一小时前同一模型 200），`deepseek-flash` 带 / 不带 tools 都是 200。
- BFF 对校验错误返回的 `code` 仍是泛化的 `VALIDATION_ERROR`（具体原因只在 `error` 文本里）。

## 六、Worker 强杀时的委派（review-deferred 的 callId 项）

`deleg-lead` 委派 `deleg-analyst` 执行 `sleep 60`；子 Run `RUNNING` 时 `kubectl delete pod --force` 杀掉 agent-worker。

- 新 Worker 启动后 BullMQ 重新投递，被执行层拒绝：`needs reconciliation (status=RUNNING): refusing re-entry … (no re-prompt)`，
  任务进 BullMQ `failed`；恢复扫描看到账本里 `bash`、`delegate_to_agent` 都是 `RUNNING`（副作用未知），**不重放、转人工**
  （`run-recovery-service.ts` 注释：operator must reconcile）。
- 结果：子 Run 始终只有 **1 个**，没有重复委派；父子 Run 都停在 `RUNNING`，等待人工。
- 人工处置：对父 Run 发 `cancel` → `CANCELLING` → 下一轮恢复扫描（≤60 s）落到 `CANCELLED`，子 Run 级联 `CANCELLED`。
- 所以"重启后是否沿用同一 `callId`"在这个场景下**不会被触发**：有未决副作用时根本不重发调用。
  没有覆盖的是"重启发生在调用发出之前"那一类（此时账本无未决行、会被重放），本次未构造。
- 值得注意的运维事实：这种 Run 会一直显示 `RUNNING`，没有自动超时；`docs/runbooks/` 里没有对应的人工处置说明。

## 没做 / 按用户决定不做

- C8（5 GiB 数据集）、H5 / H6（生产抽样）：按用户决定不做。
- 跨组织：部署只有一个组织，不构造。
- 清理：探针在主 `sandbox` 工作区留下 9 个测试用空目录（名字不以 `01M3` 开头），清理命令被拦截，留给用户；
  测试智能体 `gate-mcp-agent` / `deleg-analyst` / `deleg-lead` / `gate-bash-approval` 与账号 `userb` 仍在开发库里。
