# Agent / Worker / Sandbox 实现审查

审查日期：2026-09-16。对象：`agent` HTTP/运行时装配、`agent-worker` 的消费与子任务等待链、`exec` sandbox 的内部 Shell、隔离与配额接线。

基线：分支 `refactor/updrdb-dbpm`，HEAD `01230b876c6d8e5aee217c4c228e16af670503f0`，以当前工作区为准。开始审查时已有 15 个修改文件，涉及模型注册表、模型配置、runtime manifest/patch、Compose、测试及文档；这些文件没有被本次审查修改。本次仅新增本目录的报告和 [隔离探针](probe.mjs)。

后续执行见 [修复执行方案](implementation-plan.md)。

> **2026-09-16 实施完成。** R1–R6 全部落地，分两批提交：
> `99ef6b02`（R1/R2/R4/R5/R6）与 `de745e3c`（R3，新增
> [ADR 0012](../../adr/0012-depth-layered-run-queues.md)）。真机验证见
> [执行面限额与 shell 契约证据](../../evidence/exec-resource-limits-and-shell-contract-2026-09-16.md)
> 与 [分层队列证据](../../evidence/run-queue-depth-layering-2026-09-16.md)。
> **下面的报告正文是 2026-09-16 审查当时的快照，不再更新**——它描述的是修复前
> 的代码；判断当前状态请读证据与 `docs/STATUS.md`。`probe.mjs` 里的断言同理，
> 它们断言的是当时的缺陷，已按执行方案「阶段 0」翻成各包里的回归用例
> （`contract/test/shell-payload.test.ts`、`exec/test/internal-shell-wiring.test.ts`、
> `agent/tests/runtime/shell-deadline-buffer.test.ts`、
> `agent/tests/redis/subagent-slot-starvation.integration.test.js` 等）。

结论：发现 3 项 P1 风险、3 项 P2 问题。P1 尚未在真实运行栈重现；其中 RPC 超时阈值已用真实客户端加替身 transport 确认。不能把本报告理解为全面安全审计通过，或已经观察到线上事故。

## 发现（按修复优先级）

### R1 · P1：资源限制与子进程磁盘配额没有接入生产执行链

- 位置：`exec/src/http/internal-shell.ts:90`、`exec/src/shell/executor.ts:191`、`exec/src/shell/process-runner.ts:71`、`exec/src/isolation/build.ts:309`。
- Compose 声明 `SANDBOX_MAX_PROCESS_COUNT=20`、内存/CPU/文件大小/打开文件数等限制，但 `exec/src` 没有这些环境变量的消费者。执行器没有传 `maxProcessCount`，最终 profile 使用 0，即不限制。namespace 与 capability 隔离不能代替资源额度。
- `ChildWorkspaceQuotaWatch`、`evaluateChildQuota`、`readChildQuotaConfig` 和 `assertProductionQuotaBackend` 只在定义/导出链中出现，没有启动或执行路径调用。Shell 可直接写绑定目录，绕过上传/产物的配额账本；开启 `SANDBOX_WORKSPACE_CHILD_QUOTA_ENFORCEMENT` 不会启动监控。
- 另一个接线断点：`exec/src/http/app.ts:324` 把控制面额度硬编码为 1024 MB，没有消费 `SANDBOX_WORKSPACE_QUOTA_MB`，而 Compose 默认声明 500 MB。
- 影响：没有外部硬额度时，一个命令可耗尽共享磁盘、内存或进程资源，影响其他租户；即使部署另设了限制，当前配置也不能证明提供了宣称的逐工作区约束。
- 证据级别：全链静态核对；未运行 fork bomb、磁盘填满等破坏性探针，未核验宿主实际硬配额。
- 最小修复方向：把现有配额配置、准入及 watcher 接入共享执行入口；把受支持资源限制传到 runner，生产启动调用现有硬配额校验；未支持的配置必须显式拒绝或诊断，不能静默接受。

### R2 · P1：前台 Shell 允许执行 120 秒，RPC 却在 15 秒结束等待

- 位置：`agent/src/runtime/providers/exec-rpc.ts:247`、`agent/src/runtime/providers/remote-shell.ts:271`、`exec/src/http/internal-shell.ts:99`。
- `RemoteShell.run` 将 120000 ms 放进 payload；`ExecRpcClient.post` 独立使用 15000 ms transport 超时。生产 `buildExecRpcConfig` 没有设置更长的 timeout。sandbox 的前台路由等待执行完成后才返回。
- 命令耗时超过 15 秒时，Agent 先收到工具错误，sandbox 仍可能继续执行。路由没有将请求断开接入执行 signal，前台命令也没有经过后台 job registry，不能依赖后台 job kill 补偿。模型若重试带副作用的命令，可能重复写入。
- 证据级别：探针调用真实 `ExecRpcClient`、注入只在 abort 时拒绝的 fetch；payload 为 120000 ms，实际 15004 ms 被 abort。未用真实 HTTP/bwrap 复现持续执行及重复副作用。
- 最小修复方向：按执行预算设置有界的请求 deadline 并留回传余量，配套可到达执行面的取消；不要全局关掉超时。

### R3 · P1：等待子 Run 的父 Run 可以耗尽同队列全部消费槽

- 位置：`agent/src/bootstrap/worker-main.ts:217`、`agent/src/application/execute-run-service.ts:710`、`agent/src/runtime/providers/durable-subagent.ts:173`、`agent/src/application/subagent-spawn-service.ts:395`。
- 默认并发为 4，父子使用相同 Run 队列。父任务持续 await runtime，子任务 provider 持续轮询结果，没有 park 释放 BullMQ 槽。当前 manifest 配 `backgroundMode: 'one-shot'`，已安装 DSH tool 的默认行为是前台等待。
- 触发条件：四个父 Run 先占满单 Worker 的四个槽，再各自发起前台子 Run。子任务只能排队，父任务却等待它们完成。只能等父任务取消/超时或新增空闲消费者打破；并发提高到任意有限值仍有相同饱和条件。嵌套子任务也可消耗剩余槽位。
- 证据级别：生产调用链静态推导，未运行真实 BullMQ 饱和实验。
- 修复方向：等待子任务时持久化并让出消费槽；或采用有明确容量保障的分队列调度。单纯把并发从 4 提高不解决该问题。

### R4 · P2：Shell 参数在跨服务边界被静默丢弃

- 位置：`exec/src/http/internal-shell.ts:96`、`:122`，以及 `exec/src/shell/executor.ts:191`。
- Agent 发送 `workdir/stdin/env/stdoutMaxBytes`，sandbox 前台路由只取 command/timeout，后台只取 command/id/runId。即使修复路由，executor 本身仍未把 workdir 转成 runner 的 relativeCwd，输出上限也继续取实例固定值。
- 影响：指定子目录的构建/相对文件操作在工作区根执行，可能写错或删除错误文件；需要 stdin/env 的工具行为与请求不一致。
- 证据级别：Hono 路由隔离探针已复现，替换 executor.run 记录收到的 spec；指定子目录、stdin、env 和输出上限后，HTTP 仍为 200，spec 却为默认值。没有启动 bwrap，不作为真实文件副作用证据。
- 最小修复方向：统一边界字段校验与传递，使用现有路径策略做 cwd 转换；同时检查 run/start 两个入口及执行器消费者。

### R5 · P2：子任务轮询持续积累 abort 监听器，并制造高频数据库事务

- 位置：`agent/src/runtime/providers/durable-subagent.ts:177`、`agent/src/application/durable-subagent-port.ts:109`、`agent/src/application/subagent-spawn-service.ts:444`。
- 每 50 ms 新增一个 `{ once: true }` abort listener；正常 timer 到期没有移除，完成/dispose 也没有清理。once 只在 abort 发生时移除，正常轮询不会清理它。
- 每次查询最终进入 `getStatuses` 的数据库事务。理想情况下一个待完成子任务每秒约 20 次查询，等待一分钟约累积 1200 个监听器；数据库延迟会降低实际频率，但不会改变积累方向。
- 证据级别：真实 provider 加内存 queue/store 探针，5 次等待后完成并 dispose，仍有 5 个 abort listener。数据库负载数字为按代码频率推算，非实测吞吐。
- 最小修复方向：清理每次等待的 listener，或复用支持 signal 的定时器 API；轮询增加上限内退避，优先复用已有事件通知，不另造通知系统。

### R6 · P2：后台进程输出在 Agent 侧无限累积

- 位置：`agent/src/runtime/providers/remote-shell.ts:197`，结合该文件 `monitor()` 和 `readOutput()`。
- monitor 每轮主动 pull，把新输出追加到 `outputBuf`；只有调用 readOutput 才清空。本地没有大小上限，exec 单次输出有界也不能限制 Agent 跨批次累计量。
- 触发条件：后台命令持续产生输出，而模型长时间不读取结果。内存随输出量增长；多个后台任务可以放大 Worker 内存压力。
- 证据级别：静态确认无界追加；未运行内存耗尽实验。是否在具体工具生命周期中长时间无人读取需真实链路验证。
- 最小修复方向：保留有上限的输出尾部，截断时置已有 lossy 标记；可复用执行面的有界缓冲模式，不新增持久化层。

## 实施与验收顺序

本节是阻塞发现的后续实施计划，不把 P1 移入非阻塞债务，也不将单元探针视为关闭 STATUS 的证据。

1. R1：先让生产限制可观察地生效。用低额度的合法命令对照和超限命令验证，确认只结束当前任务、其他 owner 仍可执行；验证配额配置缺失时拒启。
2. R2：真实运行一个超过 15 秒、低于执行预算的命令；另测取消与执行超时，确认没有仍写文件的孤儿命令和重复副作用。
3. R3：真实 MySQL/Redis 下先占满父 Run 槽，再创建子 Run；要求无需扩容、取消父任务或耗尽预算即可取得子任务结果。
4. R4–R6：cwd/stdin/env/output 的跨服务验收；完成/取消后监听器恢复基线；连续输出且不读取时缓冲有界。

显著优化优先处理 R5 的数据库轮询和 R6 的缓冲。无需先重写整个 Worker、增加通用调度框架或拆更多服务；R1/R4 首先复用已有但未接线的实现。

## 验证记录与边界

- 宿主默认 Node 为 v23.11.0，不符合仓库版本要求；本次检查显式使用 `/opt/homebrew/opt/node@22/bin/node` v22.23.2，满足 runtime-versions.json 的 Node 22 范围。
- 定向现有测试：18/18 通过，无跳过。命令（仓库根）：

  ```sh
  PATH=/opt/homebrew/opt/node@22/bin:$PATH node --import ./agent/node_modules/tsx/dist/loader.mjs --test agent/tests/runtime/durable-subagent.test.ts agent/tests/runtime/durable-subagent-port.test.ts exec/test/shell-executor.test.ts
  ```

- 隔离探针：3 项确认，命令：

  ```sh
  PATH=/opt/homebrew/opt/node@22/bin:$PATH node --import ./agent/node_modules/tsx/dist/loader.mjs docs/reviews/2026-09-16-agent-worker-sandbox/probe.mjs
  ```

  探针使用真实客户端/provider/路由，但替换 transport、queue/store 和 shell 执行，不验证鉴权装配、事务、模型或真实隔离。断言描述当前缺陷；修复后应改为预期行为的回归断言。

- 本轮为 review，未修改生产代码，未重建或启动容器，未执行完整六套测试、全包类型检查、前端 build 或真实登录→工具 Run→logs/signal→跨租户链路。不宣称这些验收通过。
- 未查询远端 CI 或分支保护规则。未穷尽 Agent HTTP 全部接口、审批事务和恢复状态组合；没有在本报告中将未充分核实的安全疑点列为确定漏洞。
