# R8 零 Skill 与文档单一事实源

## Goal

删除所有现有 Skill package，以零 Skill 作为发行基线，并让活跃文档/spec 只描述最终四服务、PostgreSQL、相对 workspace 和 Env 契约。

## Requirements

- 删除 `skills/` 下全部 package，保留 loader/install/edit/reload 框架。
- Agent 在零 Skill 下可启动、对话并使用基础工具；未来 Skill 仅通过研发安装流程引入。
- README、API、architecture、deployment、development、ADR、`.env.example`、Trellis specs 同步。
- 历史资料标记 superseded/deferred，不作为当前规范。
- 每项发布门槛链接自动化或停机演练证据。

## Acceptance Criteria

- [x] `skills/` 无任何 Skill package，零 Skill smoke 通过。
- [x] 活跃文档不宣称内置 Skill、Python Agent、双 Runtime、旧 workspace 或旧数据库兼容。
- [x] 配置文档与 Env catalog 一致。
- [x] 父级 R1-R8 证据可追溯且 Trellis finish 通过。
