# Worker 崩溃后 Run 一直停在 RUNNING

适用：`agent-worker` 被强杀、OOM、节点重启后，某个 Run 长时间停在 `RUNNING`，界面一直显示进行中。

## 为什么不会自动恢复

Worker 重启时的恢复扫描（`agent/src/application/run-recovery-service.ts`）只在**确定安全**时重放：
如果这个 Run 的工具账本里有执行到一半的工具（`RUNNING`），工具可能已经产生了副作用（写了文件、发了请求、
委派了子 Run），再跑一遍会重复执行，所以扫描**不重放、转人工**，Run 保持 `RUNNING`。
这是 fail-closed 的有意设计，不是故障。

## 判断

1. 管理端「运行」页按状态筛选运行中，或 `GET /api/admin/runs?status=RUNNING`，找到持续很久的 Run。
2. 看它的工具台账：`GET /api/admin/runs/{id}/tools`。有 `RUNNING` 的工具行、且 Worker 日志在那之后有过
   `recovery scan complete`，就是这种情况。
3. 根据工具类型判断副作用：只读工具可以忽略；写文件、外部请求、`delegate_to_agent` 等要先确认实际结果
   （例如工作区里的文件、远端系统的记录、子 Run 的状态）。

## 处置

由**发起人**取消该 Run（会话页的停止按钮，或 `POST /api/runs/{id}/cancel`，需 `Idempotency-Key`）。管理端没有
代他人取消的接口。

取消后：

- Run 进入 `CANCELLED`；
- 仍是 `RUNNING` 的工具行收尾为 `UNKNOWN`，错误码 `RUN_CANCELLED_OUTCOME_UNKNOWN`（结果不明，审计时据此识别）；
  尚未开始的（`PROPOSED` / `WAITING_APPROVAL`）收尾为 `CANCELLED`；
- 各追加一条 `tool.execution.failed` 事件。

需要继续这项工作时，在同一会话里重新发起：模型能看到之前的对话，但**不会**自动补做被打断的那一步，
发起人应在新消息里说明上一步是否已经生效。

## 不要做的事

- 不要直接改库把 Run 或工具行改成 `SUCCEEDED` / `FAILED`：会绕过事件、通知与审核任务的同事务写入。
- 不要为了「自动恢复」放宽恢复扫描的判定：它防的正是重复副作用。
