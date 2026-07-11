# Design

## Topology

`Frontend → Node BFF → Node Agent Service → Python Sandbox`。Agent 服务无 workspace mount，只通过 Sandbox API；SDK cwd 使用逻辑路径，实际 I/O 工具全部被 Extension/自定义工具转发。

## Run API

- `POST /internal/agent-runs` → stable run ID
- `GET /internal/agent-runs/{id}/events?after=N` → resumable SSE
- `POST /internal/agent-runs/{id}/cancel` → idempotent cancel
- `GET /internal/agent-runs/{id}` → persisted status

## Cutover/Rollback

先直接删除未启用 Python Runtime并验证。Node 切流时暂停新 Run、排空/取消、备份、部署 Agent+BFF、冒烟后恢复。回滚停止新流量并恢复旧 BFF 镜像；数据库保持向后兼容。

