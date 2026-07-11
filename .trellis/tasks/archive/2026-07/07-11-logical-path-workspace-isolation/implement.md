# Implementation Plan

1. 定义 path/workspace 共享契约与泄露禁止测试。
2. 增加 workspace_id schema、共享存储 resolver、单写租约。
3. 实现 Session 级隔离 worker/mount namespace 与逻辑根挂载。
4. 迁移 execution/file/artifact/MCP API 只接收 workspace_id + logical path。
5. 删除全局 symlink 激活路径与物理路径响应/日志。
6. 增加并发、Session 重建、长任务、symlink/TOCTOU 与路径泄露测试。
7. 更新容器能力、共享卷、开发/生产部署文档。

## Validation

```bash
uv run pytest tests/test_workspace_manager.py tests/test_session_manager.py tests/test_isolation_and_delivery.py -q
uv run pytest tests/ -q --tb=short
rg -n '/var/sandbox/workspaces|_physical_workspace' api-server frontend docs sandbox
docker compose config -q
```

## Rollback Point

切换执行 worker 前保留旧 resolver feature gate；workspace_id/目录映射与共享卷不可回滚删除。

