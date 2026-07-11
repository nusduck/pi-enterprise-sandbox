# Design

## Event Model

PostgreSQL 保存 append-only `agent_events(run_id, sequence, event_id, type, payload, schema_version)`，并维护 Conversation/Session/Run/tool/approval 的可查询投影。写入事件与投影在同一事务，所有 UI 状态指向源 event_id/sequence。

SDK Session entries 以原始兼容 JSON + schema version 保存；启动时生成临时 JSONL 并 `SessionManager.open()`。SDK 产生新 entry 后在可观察事件边界导入数据库；工具台账先于外部执行提交，弥补进程崩溃窗口。

## Recovery

租约过期后恢复器读取最后提交事件，校验 Sandbox execution ledger，重建 JSONL 和 Extension state。Assistant partial → interrupted；waiting approval 继续；executing 无确定凭证 → unknown。

## Migration/Rollback

从现有 Conversation messages、sandbox_session_id、workspace_path 和 approval 表迁移到 versioned schema，保留原表/备份。旧应用回滚只读兼容新列，不删除事件。

