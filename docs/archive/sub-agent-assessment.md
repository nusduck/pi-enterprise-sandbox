# Sub-Agent 评估结论

本轮不启用 Sub-Agent。当前交付先稳定单 Agent 的 Extension Host、两条执行通道、持久化暂停、上下文治理与 Package 治理，这与重构方案中“第一阶段不开发 Sub-Agent”的边界一致。

后续启用前必须同时满足：

- 子 Session 有独立且可追踪的 `run_id`、预算、取消和超时；
- Workspace 权限只能由父 Agent 收窄，不能扩大；
- MCP Server、Tool 和身份凭据按子 Agent Profile 重新求交集；
- 审批、`waiting_input`、Task Plan 与 Compaction 可跨父子 Session 恢复；
- 并发写仍按 `workspace_id` 串行，结果聚合保留来源与证据；
- 前端、审计日志和诊断页能展示父子关系及资源消耗；
- 完成威胁建模、负载测试和失败恢复演练后，才能加入 Extension Allowlist。

在这些门槛满足前，Agent Profile 不包含 Sub-Agent Extension 或委派工具。
