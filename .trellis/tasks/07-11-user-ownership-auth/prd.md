# 用户归属与认证

## Goal

为所有跨服务资源提供可信 `user_id` 与组织归属，使 Conversation、workspace、附件、Agent Run、工具、审批、Artifact 和审计可授权、可追踪、不可跨用户访问。

## Requirements

- BFF 完成终端用户认证并生成可信 request context；内部服务只接受经服务身份认证转发的用户上下文。
- 第一阶段角色仅 `user`、`admin`，数据模型预留 `organization_id`；不建设复杂 RBAC。
- 所有资源记录 owner 与 organization，读取、修改、删除和审批前强制校验。
- 服务 Token 只证明调用服务身份，不得替代终端用户身份。
- 兼容现有单用户数据：迁移时绑定到明确的 bootstrap user/org，不允许空 owner 继续产生。

## Acceptance Criteria

- [x] 未认证请求不能创建或读取业务资源。
- [x] 同组织不同用户不能访问对方 Conversation/workspace/附件，除非后续显式授权。
- [x] 跨组织访问始终拒绝且不泄露资源是否存在。
- [x] BFF、Agent、Sandbox 审计能通过 `trace_id` 关联同一 user/org。
- [x] 旧数据迁移有数量核对、回滚备份和孤儿检测。
- [x] pytest、Node API 测试和跨用户集成测试通过。

## Out of Scope

- SSO/SCIM、细粒度 RBAC、管理员审批 UI、资源共享与团队协作。

