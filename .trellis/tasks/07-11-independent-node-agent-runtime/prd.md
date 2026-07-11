# 独立 Node Agent Runtime

## Goal

将官方 SDK 编排从 Node API Server 拆到独立 Node Agent 服务，使 BFF、Agent 与 Sandbox 可独立部署、扩缩容和回滚；直接删除从未启用的 Python Agent Runtime。

## Requirements

- `api-server/` 只负责认证、用户 API、上传/下载边缘和 SSE relay。
- `agent/` 使用精确锁定的官方 SDK，负责 Run、Session、Extension、模型、Skill 与工具注册。
- `sandbox/` 不包含 Agent 主循环，只提供受控执行/文件/Artifact/审批/审计执行点。
- BFF-Agent 使用服务身份认证的 HTTP Run API；SSE 事件持久化后发送，按 sequence 续传。
- Agent-Sandbox 使用稳定版本化协议，透传 user/org/trace/policy/idempotency。
- 删除 `AGENT_RUNTIME=python`、`sandbox/agent/`、`/agent/chat` 和专属配置/测试/文档，无迁移兼容期。
- Node 拆分使用短暂停写：排空/取消在途 Run 后一次性切换，不维护双 Runtime。

## Acceptance Criteria

- [ ] BFF 不 import SDK 或承载模型循环。
- [ ] Agent/Sandbox 可单独启动、健康检查、扩缩容和回滚。
- [ ] HTTP create/cancel/status 与 sequence SSE 重连/去重契约测试通过。
- [ ] 多副本只有一个 Agent worker 执行 Run。
- [ ] Python Agent 代码/配置/路由/文档全部移除，Python 仍作为 Sandbox 执行语言。
- [ ] 多轮、工具、审批、附件、Artifact、取消、崩溃恢复 E2E 通过。

