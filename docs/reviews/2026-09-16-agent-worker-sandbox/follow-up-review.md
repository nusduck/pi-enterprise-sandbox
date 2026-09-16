# 修复后复核：仍有阻塞缺口

2026-09-16，基线 `ab200782`，开始时工作区干净。本轮只读生产代码，核对修复提交及两份验收记录；没有重复执行记录中的 Docker/数据库验收，历史测试数字不作为本轮亲自复现。

## F1 / P1：R1 修复遗漏 MCP 执行入口

`exec/src/http/internal-mcp.ts:161` 的 `shellOf()` 创建 IsolatedShellExecutor 时仍只给 workspace/bwrap/mode。`exec/src/http/app.ts:236` 的生产窄桥装配没有资源/配额参数；`:254` 直接 executor.run，既无 quota admission/watch，也没有传请求 signal。

因此 `/internal/mcp/v1/shell/execute` 不受本次新增的 nproc/NOFILE/CPU/FSIZE/AS 限制及子进程配额监控；连接断开也没有本次新增的前台取消接线。外部 MCP 命令仍可走这个执行入口。这不是新增路径，原执行计划已要求覆盖 MCP 可达入口。

本轮隔离复现：真实 Hono 窄桥路由和 bearer 校验，替换 WorkspaceManager 的建目录操作及 executor.run（不 spawn），合法请求返回 200；执行器实值为 `maxProcessCount=0`、`rlimits=null`、`spec.signal` 不存在。它证明装配缺失，不证明真实资源耗尽或进程残留。

最小后续：将受限执行与配额编排下沉到两种路由都调用的共享执行服务，或至少让窄桥复用相同配置与编排；保留独立 token/路由鉴权。补 MCP 合法成功、超限拒绝/终止、断连停止副作用的真实对照。

## F2 / P1：R3 启动闸门把 Redis 读取失败当作“队列已排空”

`agent/src/bootstrap/worker-main.ts:71` 的 countKey 捕获所有 Redis 异常并返回 0。缩小服务深度时，即使无法读取不再消费的层，也允许继续启动。后续 Redis 恢复、依赖探针变绿，不会重做已跳过的排空检查，遗留层仍然无人消费。

证据级别：静态确认。key 不存在可视为 0；连接/权限/读取异常不能等同不存在。现有“塞 wait key → 拒启”的正反对照没有覆盖此异常分支。需要拒启或有界重试后拒启，并补故障注入测试。

## F3 / P1：Redis 队列为空不足以允许缩小深度

同一闸门只查询 Redis，不查 MySQL 中不再服务深度的非终态 Run。子 Run 等待审批/用户输入时可以没有待消费作业：原作业已完成并删除，但 MySQL 仍为 WAITING_APPROVAL / WAITING_INPUT。此时缩小深度会通过闸门，随后审批/应答恢复入队却被 routeRunToQueue 拒绝。

定位：`worker-main.ts:82` 的检查范围；`run-queue-topology.ts` 的 routeRunToQueue 越界拒绝；`run-recovery-service.ts:366` 等恢复入队路径。证据级别为静态调用链推导，未在真实账本复现。

最小后续：切换前停收并控制仍在运行的生产者，检查权威 MySQL 中超出目标深度的全部非终态 Run，覆盖 parked/入队失败状态。读库失败同样拒绝切换；有存量则保持原拓扑直到收敛。补 WAITING_APPROVAL/WAITING_INPUT 子 Run → 缩深拒启 → 处理完成 → 成功切换的真实用例。

## 结论口径应修正

- 地址空间上限显式 opt-in、投递侧/消费侧配置拆分合理；没有通用 park/replay 不是本轮新增缺陷。
- `SANDBOX_MAX_MEMORY_MB` 只做声明和日志，不设置容器内存；生产 Compose 真正使用 `SANDBOX_MEM_LIMIT`（默认 1g）。不能把日志中的 512 MB 当成已生效额度；开发 Compose 也不能据此声称有内存硬兜底。应写清实际消费者并验证 cgroup/systemd 限额。
- 新镜像下缩小 maxDepth 的闸门测试，不等于旧镜像回滚测试；旧镜像没有新增闸门。旧镜像回滚需要切换前外部检查，且不能用“启动不报错”代替权威账本与队列排空。
- 并发预算 6 恢复的是根槽数 4，不是已经证明恢复相同吞吐；深层仍各一个槽。
- 分层拓扑下 Worker 重启、恢复和消费者异常的 release gate 仍需补齐，不应列为整体验收完成。

## 本轮验证

Node v22.23.2，执行：

```sh
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --import ./agent/node_modules/tsx/dist/loader.mjs --test agent/tests/redis/run-queue-topology.unit.test.ts agent/tests/runtime/shell-deadline-buffer.test.ts exec/test/internal-shell-wiring.test.ts
```

23/23 通过，另完成 F1 的隔离探针。未修改生产代码、未重建容器、未重跑完整六套或真实 BFF 链路。F1–F3 是后续修复/验收阻塞项，未移入非阻塞债务；不改写既有 evidence 历史结论。
