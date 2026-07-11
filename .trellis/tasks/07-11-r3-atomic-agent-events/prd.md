# R3 Agent Event 原子序列

## Goal

消除并发 append 的 `(run_id, sequence)` 冲突，保证事件严格单调、幂等、可恢复且失败可观察。

## Requirements

- PostgreSQL 使用事务内原子 sequence 分配；`event_id` 唯一支持幂等。
- SQLite 单机使用写事务和短、有界 retry。
- `token_batch/tool_start/tool_end` 并发不得返回 500 或静默丢失。
- SSE `after=N` 无重复、无缺口；取消/完成仅一个终态。

## Acceptance Criteria

- [x] PostgreSQL 100 路同一 run 并发 append 无重复、缺口或 500。
- [x] 重复 event_id 不产生第二条事件，客户端得到稳定结果。
- [x] SQLite 单机竞争测试通过且 retry 有上限。
- [x] append 失败使 Run 进入可观察状态而非只写 warning。
