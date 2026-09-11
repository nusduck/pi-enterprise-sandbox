UPDRDB / UPRedis 兼容性探针报告

探测时间：2026-09-08 探测工具：updrdb_probe.py / upredis_probe.py 对应方案：docs/reviews/2026-09-07-updrdb-dbpm/migration-plan.md

一、总体结论

目标	地址	BLOCKER 数	结论
UPDRDB	<updrdb-host>:<port>	0	可直接推进，按方案执行 P0 改造即可
UPRedis	<upredis-host>:<port>	4	必须解决后方可切换，核心是 Lua 跨节点 + LPOS + 淘汰策略
二、UPDRDB 详细结果

版本：5.7.23-upsql-2.4.1（UPSQL Server），事务隔离 READ-COMMITTED

2.1 身份与拓扑

项目	结果
版本	5.7.23-upsql-2.4.1-log — 符合 5.7 基线
DRDB SHOW STATUS	不可用 → 推断为透传模式或直连 upsql，符合方案假设
sql_mode	STRICT_TRANS_TABLES, NO_ZERO_DATE, ERROR_FOR_DIVISION_BY_ZERO, ...
character_set_server	utf8mb4
collation_server	utf8mb4_general_ci
time_zone	+08:00
log_bin	ON
innodb_lock_wait_timeout	60
lower_case_table_names	1
GRANTS	GRANT ALL PRIVILEGES ON .
2.2 P0-1 行锁抢占（SKIP LOCKED）

探测项	结果
SELECT ... FOR UPDATE	✅ 可用（5.7 标准能力，代码 20+ 处依赖）
SELECT ... FOR UPDATE SKIP LOCKED	❌ 不可用（错误 1064，如期被拒）
UPDATE ... ORDER BY ... LIMIT	✅ 可用（§P0-1 方案 B 依赖此语法）
结论：SKIP LOCKED 不可用，必须按 §P0-1 改为 claim-then-read（outbox + cron 两处）。替代语法 UPDATE ... ORDER BY ... LIMIT 已验证可用。

2.3 P0-2 触发器

步骤	结果
① CREATE TRIGGER	✅ 可创建
② 触发器是否真的拦住 UPDATE	✅ UPDATE 被拒且值未变 —— 真正生效
③ DROP TRIGGER	✅ 可删除（迁移 down() 依赖）
④ SHOW TRIGGERS	✅ 正常
⑤ CREATE OR DISPLACE TRIGGER	不支持（仅少一个幂等化手段，不影响）
结论：触发器创建、生效、删除全流程正常。append-only 策略可用触发器保障。

2.4 P0-3 预处理语句

探测项	结果
SQL 层 PREPARE / EXECUTE	竟然支持（比 5.7 基线宽松）
二进制协议 COM_STMT_PREPARE	✅ 服务端接受
结论：预处理实际可用，但手册明确不推荐，建议 exec/ 的 7 处 pool.execute() 仍按 §P0-3 改为 pool.query()。knex 路径不受影响。

2.5 语法基线

语法	结果	说明
CTE（WITH）	✅ 如期被拒	8.0 特性，代码零使用
窗口函数 ROW_NUMBER()	✅ 如期被拒	8.0 特性，代码零使用
JSON_TABLE	✅ 如期被拒	8.0 特性，代码零使用
utf8mb4_0900_ai_ci	✅ 如期被拒	8.0 专属，统一用 unicode_ci
JSON_EXTRACT	✅ 可用	5.7 就有
SHA2()	✅ 可用	core schema 生成列依赖
utf8mb4_unicode_ci	✅ 可用	全部 49 处索引/列在用
SHOW WARNINGS	✅ 可用	手册标"结果不保证正确性"
2.6 事务与锁

探测项	结果
START TRANSACTION / COMMIT / ROLLBACK	✅ 可用
SAVEPOINT	竟然支持（比手册宽松）
LOCK TABLES	竟然支持（比手册宽松）
SET SESSION TRANSACTION ISOLATION LEVEL	✅ 可用
2.7 真实 Schema 形状

探测项	结果
父表：CHAR(26) 主键 + JSON + DATETIME(3) + ON UPDATE	✅ 已建
STORED 生成列 SHA2(...)	✅ 已加
外键	✅ 已建
外键是否真的生效	✅ 外键真实生效（拒绝了孤儿行）
JSON 列往返	✅ 读回 '{"a": 1}'（字符串形态）
唯一索引冲突	✅ 如期被拒（错误 1062）
INSERT ... ON DUPLICATE KEY UPDATE	✅ 可用
多语句事务原子性	✅ 回滚后 org_id=org-1
2.8 knex 迁移器

探测项	结果
knex_migrations 表形状	✅ 可建
knex_migrations_lock + 自增	✅ LAST_INSERT_ID=233
迁移锁 UPDATE ... WHERE	✅ 抢锁影响 1 行（期望 1）
2.9 连接行为

探测项	结果
建连耗时	172 ms（建议 connectTimeout=3000）
SET NAMES utf8mb4	✅ 可用
SET SESSION 变量	✅ 可用
SET GLOBAL	竟然可用（比手册宽松）
三、UPRedis 详细结果

版本：Redis 5.0.14 前置代理：有（UPRedis Proxy）

3.1 身份信息

探测项	结果
redis_version	5.0.14
redis_mode	未返回（代理未透传）
role	空（代理未透传 INFO replication）
ACL WHOAMI	不可用（5.0 不支持）
3.2 配置参数

参数	当前值	期望值	状态
maxmemory-policy	volatile-lru	noeviction	❌ BLOCKER
timeout	0（不断）	-	✅
appendonly	yes	-	✅
maxmemory	3221225472（3GB）	-	INFO
3.3 Lua 脚本（核心问题）

UPRedis Proxy 要求：EVAL/EVALSHA 必须含至少 1 个 key 且所有 key 路由到同一节点
探测项	不带 key	带 1 key	说明
EVAL	❌ wrong number of arguments	✅ 返回 1	带 key 即可用
SCRIPT LOAD + EVALSHA	❌ wrong number of arguments	✅ 返回 2	带 key 即可用
CAS 释放锁脚本（1 key）	-	✅ 返回 1	我们的锁脚本不受影响
14-KEY 多键脚本	-	❌ keys must route to same node	BLOCKER
结论：

单 key 的 Lua 调用（我们自己的 CAS 锁）可用
BullMQ 的 14-KEY 脚本因跨节点路由失败，必须用 hash tag 确保同队列 key 路由到同一节点
3.4 数据平面

数据结构	结果	说明
String / TTL	✅ 通过	cancel-signal、锁
Hash	✅ 通过	BullMQ 作业体
Stream	✅ 通过	run-event-stream
ZSet	✅ 通过	BullMQ delayed/prioritized
List + LPOS	❌ 命令不存在	BLOCKER — Redis 5.0 无 LPOS
Set	✅ 通过	BullMQ stalled
BZPOPMIN 阻塞行为	✅ 2.11s 后返回 nil	BullMQ worker 取任务正常
3.5 读己之写

探测项	结果
200 轮写后立即读	✅ 200/200 全部读到刚写的值
结论：尽管代理未返回 replication role，实际读写一致性正常。

四、BLOCKER 清单与行动项

UPDRDB：无 BLOCKER

#	改造项	影响范围	优先级
1	SKIP LOCKED → claim-then-read (§P0-1)	outbox + cron 两处	高
2	pool.execute() → pool.query() (§P0-3)	exec/ 的 7 处调用	中
UPRedis：4 个 BLOCKER

#	BLOCKER	根因	影响	行动项	负责人
1	14-KEY Lua 脚本跨节点	代理按 key 路由，14 个不同 key 分到不同节点	BullMQ 作业状态机失效	BullMQ 队列 prefix 改为 hash tag 形式，如 {queue-name}，确保同队列所有 key 路由到同一节点	开发 + 运维
2	LPOS 命令不可用	Redis 5.0.14 不支持 LPOS（6.0+ 才有）	BullMQ wait/active 队列异常	方案 A：升级 Redis 到 6.0+；方案 B：确认代理层是否兼容；方案 C：用 LRANGE 替代	运维
3	maxmemory-policy = volatile-lru	配置为淘汰策略	BullMQ 作业数据可能被静默驱逐导致丢任务	运维改为 CONFIG SET maxmemory-policy noeviction	运维
4	INFO replication role 为空	代理未透传 INFO 子命令	可能为误报（读己之写 200/200 通过）	确认代理是否透传 INFO replication；如不��传，此项可降为 WARN	运维
五、风险与建议

5.1 UPRedis 是主要风险点

Lua 跨节点是架构级问题，需要在 BullMQ 层面改造 key 命名策略
LPOS 是版本硬障碍，优先确认升级路径
淘汰策略 是最容易修复的，建议立即联系运维调整
5.2 UPDRDB 风险较低

全部核心能力（触发器、外键、事务、预处理）可用
需执行的改造（SKIP LOCKED、预处理）均为代码层面改动，工作量可控
5.3 下一步

联系运维确认 Redis 淘汰策略调整（可立即执行）
联系运维确认 Redis 版本升级可行性
确认 UPRedis Proxy 对 hash tag 的支持方式
评估 BullMQ key 命名改造工作量
UPDRDB 侧按计划推进 §P0-1、§P0-3 代码改造
