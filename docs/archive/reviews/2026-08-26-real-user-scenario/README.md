# 2026-08-26 近期变更实际使用测试

本目录记录 2026-08-26 对当前工作区和本地开发部署的真实用户场景测试，覆盖近期 changelog/commit 涉及的模型选择、Sandbox 工具、Artifact、进程、刷新恢复和 A2A v0.3 流式调用。

## 文档

- [测试案例与执行报告](test-case.md)
- [合成交易测试数据](../real-user-scenario-transactions.csv)

## 结论摘要

- 服务重建、就绪检查、管理员登录、Capabilities/Extension diagnostics 和模型按会话选择均通过。
- 上传交易 CSV 后的真实分析、Sandbox 计算、风险结论和 Artifact 交付通过；发现 Artifact 内部路径校验与中文文件名的边界问题，但通过 ASCII 内部路径和原始显示名完成交付。
- 进程的启动、状态查询、日志读取和自然结束已通过；本轮 `kill` 发生在进程自然结束之后，主动终止仍未被独立证明。
- 运行中刷新后，同一会话和进行中的 Run 能恢复显示；由于 Computer Use 通道随后故障，刷新后的最终收敛未在 UI 中确认，判定为部分通过。
- 用户手动创建的 A2A 凭据可访问 Agent Card，并能建立 A2A v0.3 SSE；任务最终完成且回复写入历史，但原始流和重订阅流都缺少最终状态/最终消息事件，因此官方流式完整链路未通过。
- 本报告不是四套自动化测试或生产隔离验收的替代；本次未执行高风险审批、计划任务创建、跨租户 404 和外部 MCP 调用。

---

## 归档说明（2026-08-26 落地）

本报告的行动项已处理完毕，报告本身归档，**结论是当时的快照，不代表当前实现**。

| 发现 | 处理 |
|------|------|
| R1 A2A SSE 未交付最终事件 | **已修**。根因不在 SSE 传输层，而在事件词表：A2A 投影器认的是 `run.succeeded` / `run.status` / `run.terminal`，全仓无人发出；实际写进账本的是 `run.status.changed` / `run.completed`（与 `plan.md` 的事件词表一致）。终态事件因此在投影时被整条丢掉。同一根因还吞掉了报告里提到的「没有最终 Agent 正文」：`message.completed` 生产上是 `{ context, data }` 形状，`role`/`message` 在下一层，投影只读扁平形状——这一条是重建容器后拿真实 Run 的事件日志回放才暴露的（单测 fixture 恰好是扁平的）。修复后重放真实日志得到 `submitted → working → working("LIVE_VERIFY_OK") → completed(final=true)`。回归：`agent/tests/a2a/a2a-terminal-event-vocabulary.unit.test.js`（含真实 payload 形状与一条防再漂移的棘轮）；实测记录见 `docs/evidence/2026-08-26-review-fixes-live-chain.md`。**注意**：A2A HTTP 面本身未实测——`message/stream` 端到端需要 admin 签发的凭据，本轮没有；已证明的是缺陷所在的投影层 |
| R2 进程主动终止与取消后 UI 收敛未证实 | **API 侧已复现并证明可用**：对一个确实还在运行的进程跑通 status / read / signal / cancel——`cancel` 走 SIGKILL 收敛（exit 137、`finished_at` 落库、`read` 报 `completed`）。同时发现 `POST /api/processes/{id}/kill` 其实是 `signal` 的别名、默认发 SIGTERM，会被无视 TERM 的程序熬过去（改名属行为变更，已转 `review-deferred-items.md`）。**UI 侧未复测**，同样已转 |
| R3 Run 账本终态历史风险 | 该 `trace span optimistic upsert did not converge` 已在 #39 修复（见 CHANGELOG）。本轮未再复现，也未新增证据 |
| R4 环境不等同于生产验收 / CT-10 未执行项 | 保留为 live gate，已转 `review-deferred-items.md` |
| CT-05 Artifact 内部路径校验拒中文、显示名接受中文 | **未做**，作为待定边界转入 `review-deferred-items.md`——需要先决定是否支持非 ASCII 内部路径，再用回归测试钉住答案 |
