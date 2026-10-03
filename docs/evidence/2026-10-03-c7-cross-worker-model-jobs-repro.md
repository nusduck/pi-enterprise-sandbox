# 2026-10-03 C7：模型侧跨 Worker 读取旧 job 的双 Pod 复现

**验证对象：** `main @ 67f0f9c4` 的生产服务镜像；OrbStack `dsh-sim` 隔离栈，Agent HTTP ×2、Agent Worker ×2、专用 MySQL/Redis/exec，真实 DSH 运行时与可控假模型。测试驱动为本分支新增的 `cross-worker-job` 场景。不是目标环境，也没有使用真实模型。

## 步骤与结果

1. `scripts/dev/k8s/up.sh sim` 启动双副本隔离栈，两个 Worker Pod 均 Ready。
2. 假模型在 Run `01M4098K7HTJ0YTTZYS9ANZ9MF` 发后台 `bash`：`echo C7_c7bg-mus1r63w; sleep 90`。模型请求来自 `agent-worker-577cbf8f9b-m79tn`（Worker A）；Run 为 `SUCCEEDED`，exec 持久账本有 job `bash-93b8cc21207a45398cebdf7e951620b7`，当时状态 `running`。
3. 同一 Conversation 的后续 Run 落到 `agent-worker-577cbf8f9b-tx5h9`（Worker B）。模型工具账本：`job_list` 的 value 为 `[]`；`job_output` 的 text 为 `""`，snapshot label 被填成 job ID、状态为 `running`。两个工具都报告成功，未提示查无此 job。
4. 用 **Worker B Pod 内的生产 `ExecRpcClient`**、同一 org/user/workspace/run scope 调 exec `/internal/v1/jobs/status` 与 `/read`：权威状态为 `completed`、`exitCode=0`，`/read` 返回 `C7_c7bg-mus1r63w\n`。这排除了“作业不存在”或“exec 没保存输出”作为模型侧空结果的解释。

第一次场景运行时，假模型用整个 Conversation 的 tool-result 总数判断“本轮是否为首轮”，导致后续 Run 直接返回文本、没有调用 job 工具；驱动当时错误地把缺失的模型日志当作另一 Pod。修正为按本次标记的请求次数判断，并要求确实观测到另一 Pod 后重跑，才得到上述结果。以第二次运行的真实工具账本为结论。

## 结论与边界

**已复现 C7 的模型侧跨 Worker 缺陷。** 原因与代码静态核对一致：`RemoteJobs` 的 `entries` 是 Worker 本地 Map；`list` 只读 Map，`get`/`read` 对缺失条目发出 exec RPC 后丢弃结果，立即返回占位值。本次未修改生产实现；STATUS C7 仍为 `partial`。`cross-worker-job` 在现有代码上是红色复现 gate，须显式点名运行，不加入已有场景的默认全套。Worker 重启后的同一缺口可由双 Pod 的“另一副本没有本地条目”复现覆盖，但本次没有强杀 Worker Pod，也没有测试 exec 自身重启后的活句柄/日志恢复。专用命名空间、库、Redis、exec 容器与数据根已用 `down.sh sim` 清理并核对不存在。
