# R5 留存、Legal Hold 与 Trace 授权

## Goal

让 24h/90d/180d 留存真实执行，并使 Legal Hold、orphan repair 和 trace owner/org 授权在所有路径一致生效。

## Requirements

- Draft 24h、conversation/workspace/attachment 90d、event/execution/audit 180d 后分批硬删除。
- 支持 dry-run、可控时钟、重试、metrics、审计和 PostgreSQL 单执行者租约。
- Legal Hold 位于共享删除边界，所有清理入口不可绕过。
- Trace 按关联资源 owner/org 过滤；跨用户/跨组织返回一致 404，管理员仅同组织。

## Acceptance Criteria

- [x] 可控时钟证明每类到期删除、未到期保留和 Legal Hold 保留。
- [x] Dry-run 不修改数据，生产批次可重试且无 orphan。
- [x] 跨用户/组织 trace 为 404，同组织授权只返回允许数据。
- [x] 清理日志不复制敏感正文。
