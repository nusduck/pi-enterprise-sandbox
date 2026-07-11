# R2 相对 Workspace 契约

## Goal

一次性删除统一绝对 workspace 公共契约，改为相对工具路径和 opaque `workspace_id`，内部物理路径不进入 API、SSE、模型上下文、日志或文档。

## Requirements

- 删除 `/home/sandbox/workspace` 特殊解析、公共 `workspace_path`、`_physical_workspace` 外部字段且无兼容期。
- Agent、文件、Artifact、检索和 MCP 工具只接受相对 Session 根路径；绝对路径和 escape fail-closed。
- 内部物理 root 只存在 service/repository WorkspaceRef，并统一脱敏为 `<workspace>`。
- 保持多轮持久化、session 重绑、并发隔离与单写租约。
- 明确同容器同 UID 不提供恶意代码强多租户隔离的残余风险。

## Acceptance Criteria

- [x] 全链路仅用相对路径即可完成附件、读写、检索和 Artifact。
- [x] 公共协议只使用 `workspace_id`，物理路径泄露扫描为零。
- [x] 绝对路径、遍历、symlink/hardlink 和跨 Session 访问测试全部拒绝。
- [x] 仓库调用方、fixtures 和活跃文档不存在旧公共路径契约。
