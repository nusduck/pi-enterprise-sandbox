# Implementation Plan

1. 引入正式 migration 工具和 PostgreSQL schema/version contract。
2. 实现 event store、投影、Run 租约、乐观版本与 Redis 可选协调。
3. 实现 SDK JSONL materialize/import 与扩展 custom entries。
4. 将消息、token、工具、审批、附件、Artifact、取消写入事件流。
5. 实现启动恢复、unknown reconciliation、interrupted UI 语义。
6. 实现 TTL/legal hold/orphan cleanup 状态机。
7. 迁移旧数据并进行计数/hash/抽样恢复验证。
8. 增加 crash-point 与多副本集成测试。

## Validation

```bash
uv run pytest tests/test_persistence.py tests/test_approval.py tests/test_multi_turn_history.py -q
node --test api-server/tests/*.test.js
uv run pytest tests/ -q --tb=short
```

## Rollback Point

迁移前做数据库备份；schema 采用 expand/contract，旧列至少保留一个发布周期，回滚不删除新事件。

