# R1 清库切换与 PostgreSQL 新基线

## Goal

在明确的研发环境停机窗口中不可逆清空项目数据库、workspace 和 attachment 状态，以空 PostgreSQL 建立生产 v1 migration 基线；SQLite 仅保留空库开发测试能力。

## Requirements

- Reset 必须校验 `DEPLOYMENT_ENV=development`、项目标识、精确确认串和限定清理根，拒绝 production、空路径和范围外资源。
- 不迁移、不备份旧 conversation/session/event/audit/user/workspace/attachment 数据。
- PostgreSQL 使用有版本、checksum、事务化的 `schema_migrations`；重复初始化幂等。
- SQLite 仅验证空库初始化，不承担旧 schema upgrade。
- 提供停机 reset/preflight/redeploy runbook 和可自动化验证入口。

## Acceptance Criteria

- [x] 错误环境、错误确认和范围外路径均 fail-closed，且未删除任何资源。
- [x] 研发 reset 清空清单内全部状态但不影响范围外资源。
- [x] 空 PostgreSQL 重复初始化无差异，migration checksum/事务失败可观察。
- [x] SQLite 空库开发测试通过，仓库不存在旧数据迁移承诺。
