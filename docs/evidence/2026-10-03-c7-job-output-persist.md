# C7 后台作业输出落盘（2026-10-03）

## 对象

- 分支 `feat/c7-job-output-persist`，基于 `4f9e4d28`（#113 合并后的 main）加本次改动；exec 改动由 dsh worker 分两轮实现，主线程复核后补了落盘串行化与 Agent 侧 `outputUnavailable` 提示。
- 重建 `dsh-enterprise-agent:latest`（`6473ddbf7f28`，Agent HTTP 与 Worker 共用）与 `enterprise-sandbox:latest`（`2972ee5fff1c`）；`enterprise-sandbox-mcp` 的 import 图未变，构建命中缓存。Compose 开发栈带开发覆盖层重建 agent / agent-worker / sandbox / sandbox-mcp。

## 离线

- exec 新增 `test/shell-job-output-persist.test.ts` 10 项：保留窗口回收后续读、模拟重启（新 registry 同 store 同目录）、超上限丢最老与 generation、文件缺失/损坏 → `outputUnavailable`、非法 jobId 不出控制根、工作区删除只清本工作区（对照组）、运行中无人读也由定时器落盘、结算后定时器停止、输出不变不重写、read 与定时器并发后文件一致。前三类与定时器三项在实现前失败（worker 记录）；最后一项是一致性护栏，未能在去掉串行化后稳定复现交错，不作为红灯证据。
- Agent `remote-job-tools.test.ts` 新增：exec 返回 `outputUnavailable` 时模型看到明确提示。
- Node 22 容器：exec 513（510 通过、3 跳过）、Agent 2101/2101、contract 157/157，三者类型检查通过。

## 真机（Compose）

脚本两段：A 段 SSO 用户让模型以后台方式起 `for i in $(seq 1 600); do echo c7tick-$i; sleep 1; done`，之后不读；宿主 `docker restart dsh-enterprise-sandbox`；B 段查进程状态、BFF 日志、让模型在同一会话里 `job_output`，再用另一用户读日志。

- 未读期间控制根 `job-output/<id>.log`（0600）已有 `c7tick-1…17`，说明定时落盘生效。
- 重启后 exec 启动日志 `recovered 1 orphaned job(s)`，进程状态为终态（`cancelled` / `orphaned: worker restarted`）。
- BFF 日志：8 次全部读到重启前输出；跨用户读日志 8 次全部 404。
- 模型 `job_output`：8 次中 6 次读到 `c7tick-*`；2 次（均为重启后数秒内发起）返回空增量与终态快照。直接以生产 `ExecRpcClient` 不带游标读同一作业返回完整输出，可见失败请求带了越过文件末尾的游标；之后 5 次带抓包重跑均通过，未能定位游标来源。
- 抓包另见：Agent 侧后台监视器在重启后以 `0-101` 续读而文件只有 91 字节——运行中最后不到一个落盘间隔的输出丢失，符合设计上限。

## 结论

C7 仍为 `partial`。输出持久化通过；模型侧重启后立刻读取的空增量待定位；活句柄不跨 exec 重启属设计边界。
