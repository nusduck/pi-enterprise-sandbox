# 沙箱资源限额接线 + Shell 跨服务契约（2026-09-16）

对应 [`reviews/2026-09-16-agent-worker-sandbox`](../reviews/2026-09-16-agent-worker-sandbox/README.md)
的 R1 / R2 / R4 / R5 / R6。R3（子 Run 消费槽饥饿）不在本次范围。

## 验证对象与版本

| 项 | 值 |
|---|---|
| 分支 / 提交 | `refactor/updrdb-dbpm` / `99ef6b02`（本文件与 PROCESS_LOG 随后追加） |
| 未提交改动 | 无（验证在提交后的工作树上进行） |
| runtime | 宿主 Node v22.23.2（`/opt/homebrew/opt/node@22/bin`，满足 `runtime-versions.json` 的 `>=22.19.0 <23`）；容器内 Node v22.23.2 |
| 重建的镜像 | `pi-enterprise-agent`（agent + agent-worker 共享）、`enterprise-sandbox`、`enterprise-sandbox-mcp`、`pi-enterprise-api` |
| 运行容器已换新 | 是。`docker inspect` 逐个核对运行容器的 image id 与 `docker image inspect` 的构建产物一致：agent/agent-worker `5bb35405…`、sandbox `1f5299e5…`、sandbox-mcp `3cd84b2d…`、api-server `8f582eb9…` |
| 替身边界 | 开发栈用 `dbpm-fake` 取密、MySQL 5.7 / Redis 5.0.14 容器。**执行面与隔离不是替身**：下面的 shell 探针走真实 HMAC 内部面、真实 Hono 路由、真实 bwrap。模型侧真实链路调用真实 LLMIO 网关 |

## 一、执行面探针（真实 HMAC + 真实 bwrap）

探针在 **agent 容器内**跑，用的是仓库里的生产 provider（`RemoteShell` +
`ExecRpcClient`），打真实 `sandbox` 容器的 `/internal/v1/shell/*`。
transport、执行面、隔离层都没有替身。**14 / 14 通过**：

| 断言 | 结果 |
|---|---|
| `R1_rlimits_in_namespace` | 沙箱内 `ulimit` 实测 `u=20 n=256 t=300 f=51200`——与 Compose 声明的 `SANDBOX_MAX_PROCESS_COUNT` / `MAX_OPEN_FILES` / `MAX_CPU_TIME_SECONDS` / `MAX_FILE_SIZE_MB` 一一对上 |
| `R1_address_space_not_enforced` | `v=unlimited`。未设 `SANDBOX_MAX_ADDRESS_SPACE_MB` 时刻意不下发 `ulimit -v` |
| `R1_nproc_limits_descendants` | 有界地尝试起 60 个 `sleep`（会自己退出，随 bwrap 回收，**不是 fork bomb**），内核真的拒绝：`bash: fork: Resource temporarily unavailable` |
| `R1_nproc_allows_within_limit` | 拒绝对照之外的正对照：额度以内起 5 个并发作业照常成功（`FIVE_JOBS_OK`） |
| `R1_in_quota_command_succeeds` | 额度内普通命令 `exitCode 0`、`denied false` |
| `R2_20s_within_120s_budget` | `sleep 20` 在 120 秒预算内成功，实测 20 075 ms、`timedOut false`。**修复前**这条会在 15 004 ms 被 RPC abort |
| `R2_short_budget_stops_writes` | 预算 4 秒、命令 `sleep 20; echo LATE > 文件`：`timedOut true`，22 秒后回查文件 `ABSENT`——超时真的终止了进程树，没有留下仍在写的孤儿 |
| `R2_cancel_leaves_no_write` | 3 秒时客户端 abort：客户端侧 reject，22 秒后回查文件 `ABSENT` |
| `R4_workdir_effective` | `workdir=/home/sandbox/workspace/sub/dir` → `pwd` 返回该目录；相对路径写入落在 `sub/dir/here.txt` |
| `R4_stdin_effective` | `cat` 读到 `STDIN_PAYLOAD` |
| `R4_env_effective` | 子进程里 `PROBE_VAR=PROBE_VALUE` |
| `R4_stdout_max_bytes_unicode` | `printf "中中中中中中"` + `stdoutMaxBytes: 10` → 实收 `中中中`（9 字节）、`truncated true`、**无替换字符**（截断落在字符边界） |
| `R4_invalid_fields_rejected` | `/etc`、`…/../../etc`、`timeoutMs=999999999`、`env {"1BAD"}` 四项全部 `ENVELOPE_INVALID`；合法对照 `workdir=/tmp` 成功（`pwd` = `/tmp`） |
| `R4_start_rejects_timeout` | 后台 `start` 带 `timeoutMs` → `ENVELOPE_INVALID` |

## 二、配额闸门（独立沙箱容器 + 低阈值 + 独立临时工作区）

**不向开发栈的数据卷填盘**：另起一个 `sandbox-quota-probe` 容器，同一镜像，
`SANDBOX_WORKSPACE_QUOTA_MB=2`、`SANDBOX_TEMP_QUOTA_MB=2`、采样间隔 0.5 秒，
数据根挂在 `.runtime/quota-probe/`（验证后已删除）。写入总量上限 4 MB。

| 步骤 | 结果 |
|---|---|
| 额度内命令 | `exitCode 0`、`denied false`（`QUOTA_OK_BEFORE`） |
| 超限写入（40 × 100 KB，每个间隔 0.3 秒） | **执行中被采样器终止**：`exitCode 126`、`denied true`、`Workspace quota exceeded by child process: workspace 2252800+reserved 0 > quota 2097152`。宿主上实际只落了 22 个文件 / 2.1 MB——写入在越线后停下，没有写完 4 MB |
| 越线之后的新命令 | 准入 fail-closed：`exitCode 126`、`denied true`、同一条配额原因；**没有 spawn**（`SHOULD_NOT_RUN` 未出现在 stdout） |
| 另一个 owner 的工作区 | `exitCode 0`、`denied false`（`OTHER_OWNER_OK`）——不受邻居超额影响 |

## 三、启动闸门（fail-closed，含正对照）

同一镜像，只改环境变量，`docker run` 观察启动结果：

| 场景 | 结果 |
|---|---|
| `DEPLOYMENT_ENV=production` + 正数配额 + `HARD_BACKEND_ASSERTED=false` | 拒启：`production requires SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED=true …（monitoring alone is not a hard quota）` |
| `production` + 正数配额 + `CHILD_QUOTA_ENFORCEMENT=false` | 拒启：`production requires SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT=true …` |
| `SANDBOX_MAX_OPEN_FILES=8`（低于允许下限 16） | 拒启：`SANDBOX_MAX_OPEN_FILES must be between 16 and 65536 (or 0 to disable), got 8` |
| `SANDBOX_MAX_PROCESS_COUNT=abc` | 拒启：`SANDBOX_MAX_PROCESS_COUNT must be an integer, got "abc"` |
| **正对照**：`production` + 监控开 + 硬配额已声明 | 正常启动（`exec listening on 8081`）——排除「一律拒启」的假通过 |

内存那条的启动诊断（每次启动都打，未设 `SANDBOX_MAX_ADDRESS_SPACE_MB` 时）：

```
exec NOTICE: SANDBOX_MAX_MEMORY_MB=512 is a container-level backstop only; exec does
not translate it into a per-task rlimit (address space != resident set). Set
SANDBOX_MAX_ADDRESS_SPACE_MB to enforce ulimit -v per process.
```

## 四、完整真实链路（经 BFF）

`http://127.0.0.1:4000`，真实模型，**全部通过**：

| 步骤 | 结果 |
|---|---|
| 注册 / 登录 A | `/api/auth/me` 200 |
| 建会话 | `conversation 01M2MPSM0J1CZ8T1XDJJQBW573`、`workspace 01M2MPSM0T2VH82BHA6TQAP0KX` |
| 一轮带工具的 Run | `SUCCEEDED`，工具台账 `["bash:succeeded"]` |
| 后台进程 | `bash-063857be27834595b8b0fc7dcb8c8f05`，logs 含 `TICK-1…TICK-6` |
| `SIGTERM` | 200 → `stopping` → 终态 `cancelled` |
| 跨租户 404 | run / conversation / tools / process 四项 B 均 404，**A 本人同一入口均 200**（拒绝对照） |

## 五、离线测试与类型检查

| 套件 | 结果 |
|---|---|
| `uv run pytest -q` | 206 passed |
| `npm test --prefix contract` | 118 pass / 0 fail |
| `npm test --prefix exec` | 411 pass / 0 fail / 2 skipped（413 tests） |
| `npm test --prefix agent` | 1339 pass / 0 fail / **0 cancelled** |
| `npm test --prefix api-server` | 158 pass / 0 fail / **2 cancelled** |
| `npm test --prefix frontend` | 367 pass / 0 fail |
| `npm run build --prefix frontend` | 通过 |
| 类型检查 | contract / exec / api-server / agent（主程序 + `src/runtime` strict）全部通过 |

新增回归在修复前会失败：`contract/test/shell-payload.test.ts`、
`exec/test/internal-shell-wiring.test.ts`、
`agent/tests/runtime/shell-deadline-buffer.test.ts`、
`agent/tests/runtime/durable-subagent.test.ts` 的 R5 三例。

agent 侧此前长期 `cancelled` 的 3 例（`tests/runtime/remote-providers.test.ts`）
本次查明原因并修好：`remote-shell` 的监控定时器刻意 `unref`（后台作业不该阻止
进程退出），于是「只剩监控在跑」时 `node --test` 的事件循环直接排空，用例被判成
`cancelledByParent`——既不算通过也不算失败。测试里补了不 unref 的心跳后转为真通过。
**这不是生产代码的改动**，`unref` 的行为本身是对的。

## 六、未覆盖与已知限制

- **api-server 仍有 2 例 `cancelled`**（`tests/file-proxy-workspace-id.test.js` 的
  `file proxy id domain` 套件；其中 3 条子用例本身都 ok，是套件级被取消）。
  与本次改动无关，本次**未修**，**不记为通过**。
- 配额越线的判定粒度是采样间隔：一条写得足够快的命令可能在两次采样之间写完，
  此时拦住它的是**下一条命令的准入**而不是本次执行的终止。这正是
  `child-quota.ts` 顶部写的「这不是硬磁盘配额，是纵深防御的监控」，
  生产仍必须由 `SANDBOX_WORKSPACE_QUOTA_HARD_BACKEND_ASSERTED` 指向的外部硬配额兜底。
- `SANDBOX_MAX_ADDRESS_SPACE_MB` 只验证了「未设时不下发」。设为具体值后
  `ulimit -v` 对真实工作负载（pandas / LibreOffice / Chromium）的影响**未验证**，
  默认保持关闭。
- 控制面账本默认额度从写死的 1024 MB 改为 `SANDBOX_WORKSPACE_QUOTA_MB`（500）。
  **既有部署升级前需自行盘点各工作区已用量**；本开发栈的工作区都远小于 500 MB，
  没有触发超额路径，「既有超额工作区的行为」**未在真机上验证**。
- 真实链路直连 BFF `:4000`，未经过边缘 nginx；本次没有前端 UI 改动，
  未做浏览器操作验证。
- 目标环境（真实 UPDRDB / UPRedis / DBPM / 双集群 / 麒麟 VM）验收仍未做。
- STATUS 的 C4 / C7 仍保持 `unknown` / `partial`：本次只关闭了「限额和参数根本
  没接线」这个前提，整项验收标准（并发隔离 live gate、进程句柄跨重启恢复等）
  未满足。
