# Runbook：切换 BullMQ 队列 prefix / 服务 Redis 目标

适用：改 `AGENT_RUN_QUEUE_PREFIX`（如首次切到 `{bull}`、改成环境独立的 `{pi-test-bull}`），
或把服务 Redis 从本地容器换到 UPRedis（含 7.2 → 5.0.14 换新卷）。依据：
[统一 design](../design/updrdb-dbpm-deployment.md) §8、ADR 0011 D9。

两个 key 空间之间**没有自动迁移**。Run 的权威状态只在 MySQL；Redis 里的队列作业只是
「这个 Run 该被执行」的引用。切换的原则：先让旧 key 空间里不再有东西在跑，再由新消费者
按 MySQL 账本重投，**禁止新旧两个 key 空间同时驱动同一批 Run**。

## 0. 前置

- 记录当前值与目标值：`AGENT_RUN_QUEUE_PREFIX`（空值即 `{bull}`）、`AGENT_RUNS_QUEUE_NAME`、
  `AGENT_REDIS_URL` 指向、Redis 版本、`maxmemory-policy`。写进 release manifest。
- 目标 Redis 已通过放行测试（生产 prefix + 真实代理）：
  `TEST_UPREDIS_URL=… TEST_UPREDIS_PASSWORD=… TEST_UPREDIS_PREFIX=<目标值> TEST_UPREDIS_EXPECT_ROUTING=1 npx tsx --test tests/redis/upredis-queue.integration.test.js`
  （在 `agent/` 下；`TEST_UPREDIS_REQUIRE_NOEVICTION=1` 仅在代理放行 `CONFIG GET` 时打开，
  否则由 Redis 运维逐个后端节点核验 `noeviction`）。
- prefix 必须含非空 hash tag；不带 tag 的值应用会拒绝启动，不要为了启动去掉校验。

## 1. 停准入与后台发布

HTTP 进程接收新 Run、steer、审批恢复并入队；Worker 进程同时承载 BullMQ 消费、cron 调度、
Outbox 发布与启动恢复扫描。

1. 在入口（nginx / LB）挡住写流量，或直接停 `agent`（HTTP）。
2. 等进行中的 Run 自然结束到可接受的程度，再停 `agent-worker`：SIGTERM 让 Worker 停止取新
   作业；不要 `docker kill`。
3. 确认两类进程都已退出（`docker compose ps agent agent-worker` 无运行实例；多副本时逐个核对）。

## 2. 盘点（dry-run，不改任何数据）

MySQL 侧（权威）：

```sql
SELECT status, COUNT(*) FROM runs
 WHERE status NOT IN ('SUCCEEDED','FAILED','CANCELLED')
 GROUP BY status;
```

旧 key 空间侧（只读、单 key，避免 SCAN 穿过代理）：

```bash
P='<旧 prefix>'; Q=agent-runs
for s in wait active delayed prioritized paused failed; do
  printf '%s ' "$s"; redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
    $( [ "$s" = delayed ] || [ "$s" = prioritized ] || [ "$s" = failed ] && echo ZCARD || echo LLEN ) "$P:$Q:$s"
done
```

把两边的清单保存下来（Run ID、状态、旧作业 ID）。实例经确认为空也要记录「空」的检查结果。
等待交互 / 审批的 Run 在 MySQL 里是非终态，它们靠后续的恢复入队唤醒，不需要从旧队列搬作业。

## 3. 切换

1. 修改配置：`AGENT_RUN_QUEUE_PREFIX` 与（如需要）`AGENT_REDIS_URL` / DBPM 条目；
   HTTP 与 Worker 必须是**同一个值**。
2. 换本地 Redis 版本时使用新卷（开发 `redis5_dev_data`、生产 overlay `redis5_data`），
   旧卷保留、不挂载、不 `down -v`。
3. 先起 `agent-worker`：启动时的恢复扫描按 MySQL 非终态 Run 以原幂等键
   （`jobId = runId`）入新 key 空间。BullMQ 按 jobId 去重，重复扫描不会产生重复作业。
4. 确认 Worker 日志出现 `BullMQ consumer started` 与恢复扫描结果，再起 `agent` 并放开入口。

## 4. 核对

- 第 2 步清单里的每个非终态 Run：要么已推进 / 终结，要么在新 key 空间有对应作业
  （`redis-cli HGET '<新 prefix>:agent-runs:<runId>' name` 为 `execute`），要么是等待交互。
- 新发起一个带工具的 Run 走完整链路。
- 旧 key 空间不再增长（再跑一次第 2 步的只读计数，与切换前一致）。

## 5. 旧数据处置

- 旧 prefix 下的 key、旧 Redis 卷先保留一个观察期，不立即删除。
- 删除前需要负责人确认，并按「同 slot 或单 key」清理：用旧 prefix 构造 BullMQ Queue 调
  `obliterate({ force: true })`（旧 prefix 无 tag 时只能在**非代理**的原实例上执行），
  随后逐个单 key `EXISTS` 核对无遗留；清理失败要记录，不能吞掉。

## 回退

在新 Worker 消费任何作业之前，可以直接改回旧值并按第 3 步起旧配置。新 Worker 已消费后回退，
同样必须先完整执行第 1–2 步（此时「旧」「新」对调），不能让两个 key 空间同时有消费者。
