# SDK Extension 安全治理

## Goal

使用官方 SDK Extension 统一工具前置策略、审批、追踪与结果审计，同时由 Sandbox 独立重复执行不可绕过的强制校验。

## Requirements

- 所有工具进入同一 `tool_call/tool_result` 生命周期；hook 异常阻断工具。
- 工具策略分为：安全直行、可审批风险、不可审批硬拒绝。
- `APPROVAL_ENABLED=true` 默认开启；生产可显式关闭。关闭后风险命令直接执行，硬边界仍拒绝。
- 开关状态、approval bypass 与所有工具调用统一审计；无需额外运行告警。
- Extension 注入 user/org、conversation/workspace/session/run/tool IDs、trace、策略版本、幂等键、超时和资源限制。
- Sandbox 不信任 Extension 结论，重复校验服务/用户身份、Session、路径、工具 allowlist、资源和审批凭证。
- 同 workspace 仅读工具可并行；可能写入或有副作用的工具串行；未知工具按写处理。
- 审计不记录密钥或大段明文，保留参数摘要、结果摘要、耗时、Artifact 和错误。

## Acceptance Criteria

- [ ] read/write/edit/bash/submit_artifact/ls/find/grep/Skill 管理均通过统一 hook。
- [ ] Extension 异常、超时、策略不可用时 fail-closed。
- [ ] 绕过 Agent 直接调用 Sandbox 仍无法越权或突破硬边界。
- [ ] approval 开/关语义和三层策略有矩阵测试。
- [ ] 同 workspace 写操作不会并行；跨 workspace 可并行。
- [ ] trace_id 可串联 Agent、approval、Sandbox execution 与 Artifact。

