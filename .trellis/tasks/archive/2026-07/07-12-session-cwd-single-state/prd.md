# 修复 session cwd 并统一前端状态源

## Goal

让 Pi SDK session 在 Sandbox session 创建或复用后使用该 session 对应的稳定工作区 cwd，
并消除前端对同一运行时事件同时维护 ChatState 与 EntityStore 的双状态源。

## Requirements

- Sandbox session 必须继续以 `workspace_id` 作为跨服务公开标识，不向 Agent、浏览器、日志或
  session header 暴露 `/var/sandbox/workspaces/...` 等物理存储路径。
- Agent 必须在 Sandbox session 解析完成后得到一个统一的 session cwd，并把同一个值用于：
  新建/恢复/内存 Pi SessionManager、Session header、SettingsManager、ResourceLoader 和
  `createAgentSession`。
- 新建和复用 Sandbox session 必须产生相同的 cwd 语义；恢复持久化 Pi session 时不得退回
  `/tmp` 或沿用旧 header 中不可信/过期的 cwd。
- cwd 必须代表 Sandbox 创建的当前 session 工作区逻辑路径；默认契约为
  `/home/sandbox/workspace`，而不是 Agent 容器的 `/tmp`。
- 前端每个 runtime SSE event 只能由 EntityStore/Run reducer 归约一次；不得再同步写入
  `ChatState.currentMsg`、`pendingTool`、`pendingApproval` 等平行运行时状态。
- `activeRunId` 只能由 EntityStore 持有；React 组件不得维护会漂移的镜像 state。
- ChatState 可继续持有草稿、布局、认证、上传队列、conversation 列表以及服务端加载的历史
  消息等非运行时/持久化快照，但与 EntityStore 的字段职责不得重叠。
- 保持现有用户行为：token 增量显示、工具/审批/artifact 展示、停止、conversation 切换后
  后台 run 继续、错误提示以及完成后消息可见。
- 不改变 Sandbox 相对路径工具协议，不允许 Agent 绕过 Sandbox REST 直接访问物理工作区。

## Acceptance Criteria

- [x] 创建 Sandbox session 后，Pi SDK session header 与 `createAgentSession` 收到的 cwd 均为
      该 session 的逻辑工作区 cwd，不再是 `/tmp`。
- [x] 恢复已有 Pi SDK session 和 `AGENT_FORCE_INMEMORY` 路径使用同一 cwd 契约。
- [x] session cwd 的单元测试覆盖新建、恢复、复用/解析和 fallback；公开响应中仍无物理路径。
- [x] `ChatContext` 不再包含 runtime SSE dual-write，`activeRunId` 不再有独立镜像 state。
- [x] token/tool/approval/artifact/error/done 事件只经 EntityStore reducer 更新，并通过 selector/projection
      驱动现有 UI。
- [x] conversation 切换不取消后台 run，切回时能从 EntityStore 显示该 run 的最新状态。
- [x] 前端单元测试覆盖事件单次归约、增量消息、终止/错误、审批与 conversation 切换。
- [x] `npm test --prefix agent`、`npm test --prefix frontend` 与
      `npm run build --prefix frontend` 通过；相关跨服务 smoke 在本地依赖允许时通过。

## Notes

- “Sandbox 中创建的路径”按现有安全架构解释为稳定逻辑 cwd，而非仅 Sandbox 容器可见的物理目录。
  若直接把物理路径或 workspace volume 暴露给 Agent，会破坏当前 REST 工具与路径隔离边界，因此不采用。
