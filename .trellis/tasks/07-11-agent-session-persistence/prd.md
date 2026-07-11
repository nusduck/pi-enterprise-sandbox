# Agent Session 持久化与恢复

## Goal

以 PostgreSQL 为唯一事实源，完整恢复 Conversation、SDK Session、Agent Run、工具、审批、附件和 workspace 绑定，避免重启后丢上下文或重复副作用。

## Requirements

- 持久化 enterprise/agent/sandbox session IDs、owner/org、workspace、SDK entry/event、模型与 system prompt 版本、Skill/Extension/tool 版本。
- PostgreSQL 为唯一事实源；Redis 只做租约、取消与通知，本地 SQLite 仅开发适配。
- SDK JSONL 从数据库事件重建，本地文件仅运行缓存。
- 用户消息先提交；Assistant 增量批量持久化；崩溃后保留部分回答并标记 interrupted。
- 工具执行状态机至少含 prepared/waiting_approval/executing/succeeded/failed/cancelled/unknown。
- 未过期审批可恢复；过期不可批准；unknown 不自动重试。
- 同一 Conversation 一个活动 Run，租约 + 乐观版本防止多副本重复执行。
- 默认 TTL：草稿 24h、Conversation 90 天无活动、审计 180 天；支持法务保留和孤儿回收。

## Acceptance Criteria

- [ ] Agent/数据库/Redis/Sandbox 任一单点重启后可恢复并继续下一回合。
- [ ] 已完成工具不重复执行，unknown 不自动重试，审批不默认为通过。
- [ ] SDK branch/custom entry/compaction/model/system prompt 版本往返不丢失。
- [ ] partial assistant 在 UI 中显示 interrupted，可显式继续/重生成。
- [ ] schema migration、版本兼容、TTL、legal hold 和 orphan repair 有测试。
- [ ] 多副本争抢同一 Run 只有一个获租约。

