# 逻辑路径与 Workspace 隔离

## Goal

建立唯一 Agent 可见路径契约和 Conversation-owned workspace，使所有执行/文件/Artifact/MCP 工具在并发 Session 下观察一致路径且不泄露物理目录。

## Requirements

- 双逻辑根固定为 `/home/sandbox/workspace`（Conversation 私有 R/W）和 `/home/sandbox/skill`（共享，生产 R/O）。
- 相对路径与 workspace 逻辑绝对路径规范化为相对路径；其他绝对路径、`..` 与逃逸 symlink/hardlink 拒绝。
- `conversation_id` 1:1 `workspace_id`；Sandbox Session 可轮换重绑，同一时刻单写者。
- 每个 Sandbox Session 使用独立执行环境/mount namespace，真实挂载逻辑根；禁止全局 symlink。
- `pwd`、`os.getcwd()`、`process.cwd()` 返回逻辑路径；物理路径不得进入 API、SSE、prompt、普通日志或审计摘要。
- 在线 workspace 使用共享 POSIX 卷；Agent/BFF 不直接挂载。
- 独立 Shell 不保存 `cd/export`；长任务用 execution_id，环境随 Sandbox Session 销毁而 workspace 保留。

## Acceptance Criteria

- [ ] Bash/Python/Node/文件/Artifact/MCP/检索工具观察同一逻辑 cwd。
- [ ] 并发 Conversation/Session 不串目录，单 workspace 写租约有效。
- [ ] 绝对路径、`..`、symlink/hardlink、TOCTOU 和错误信息泄露测试通过。
- [ ] 全仓 API/SSE/log fixture 不出现 `/var/sandbox/workspaces` 等物理路径。
- [ ] Sandbox Session 重建后原 workspace 文件完整可见。

