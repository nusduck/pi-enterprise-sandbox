# 2026-08-23 实际用户场景测试

本目录记录基于当前开发部署的 Chrome 真实点击测试，场景是“风控分析员上传交易文件、调用 Sandbox 完成分析并交付 Artifact”。测试使用合成数据，不包含真实个人信息。

## 文档

- [测试案例与执行报告](test-case.md)
- [合成交易测试数据](../real-user-scenario-transactions.csv)

## 结论摘要

- 登录、会话、文件上传、Sandbox Python、Artifact 提交、同会话追问、刷新恢复、Trace/Dataset 查看均已通过至少一次真实 UI 链路。
- 首轮带工具 Run 在工具和 Artifact 均完成后仍显示失败，后端错误为 `trace span optimistic upsert did not converge`。这是本次测试的高优先级缺陷，不能以页面已经显示分析结果为由判定整条 Run 通过。
- 后续上传文件 Run 和追问 Run 成功；进程实体可以创建且对应 Run 成功，但控制台没有回显输出，取消进程的确认链路使页面控制失去响应，进程管理判定为部分通过。
- 能力、MCP、模型、A2A、审批中心、计划任务页面已用 Chrome 查看；没有创建长期计划任务、A2A 凭证、Skill 或外部 MCP 调用。
- 当前是 `development` 部署，网络模式为 `unrestricted`，因此本报告不等同于生产隔离和安全验收。
