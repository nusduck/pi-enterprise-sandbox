# UPDRDB + UPRedis + DBPM 数据库改造方案

| 字段 | 值 |
|---|---|
| 日期 | 2026-09-07 起草，2026-09-08 真机探针后定稿 |
| 分支 | `refactor/updrdb-dbpm`（基于 `refactor/dsh-rebuild`，HEAD `4672d33a`） |
| 状态 | **调研与设计完成，未改任何生产代码**。决策见 [ADR 0011](../../adr/0011-updrdb-upredis-dbpm-migration.md) |
| 目标实例 | UPDRDB `<updrdb-host>:<port>`（`5.7.23-upsql-2.4.1`）／UPRedis `<upredis-host>:<port>`（`5.0.14` + 前置代理） |
| 依据 | UPDRDB 2.4.0 厂商手册与 DBPM 样例（**本地副本，`docs/ref/` 已 gitignore，版权归原厂商不随仓库分发**；从银联开放平台获取）、[`probe/`](./probe/) 探针的真机输出 |
| 相关 | [内网部署拓扑](./deployment-topology.md)（模块拆分与跨机边界；§7.5 的出网接线以它为准） |

改造三件事：

1. 持久化拓扑 MySQL 8 → **UPDRDB 2.4.1（透传模式）**
2. 协调拓扑 Redis 7.2 → **UPRedis 5.0.14**
3. 数据库与 Redis 口令改由 **DBPM** 在启动时下发，不落配置文件

---

## 1. 结论先行

**可以做。阻塞面比最初评估的小：6 个 P0 里 1 个取消、1 个降级，剩 4 个必做，都不改业务逻辑。**

| # | 改造项 | 状态 | 依据 |
|---|---|---|---|
| P0-1 | `FOR UPDATE SKIP LOCKED` → claim-then-read | ❌ **必做** | 真机 1064 不可用；替代方案的互斥语义**真机验证成立** |
| P0-2 | 触发器（append-only 不变量） | ✅ **取消** | 真机上建／生效／删全过，**不需要 REVOKE 降级路径** |
| P0-3 | 45 处 `.execute()` → `.query()` | ⬇️ **降为技术债** | 真机接受 `COM_STMT_PREPARE`，可照常工作 |
| P0-4 | 两个 Proxy 的故障切换 | ❌ **必做** | DBAAS 给 2 个地址、不提供 VIP、不允许新增服务 |
| P0-5 | 移除 `agent-migrate`，改手工 DDL + 启动校验 | ❌ **必做** | 生产与测试均无 DDL 权限 |
| P0-6 | 时区不一致（服务端 `+08:00` vs 应用 UTC） | ❌ **必做** | 真机确认 **+8.00h 偏差**；修复方案已实测有效 |

Redis 侧只有两个真 BLOCKER，**都不改业务逻辑**：BullMQ 队列 prefix 改 hash tag（配置项）、
`maxmemory-policy` 改 `noeviction`（运维一条命令）。

**最大的认知修正**：UPSQL 的语法基线是 **MySQL 5.7**（`README-2.4.0.md` 的 License 指向
mysqld-5.7；`SQL支持列表` 开篇写明"参考 MySQL 5.7 语法支持列表"）。即便走透传模式、
行为"等同单机 upsql"，**MySQL 8.0 才有的语法一律不能用**。

---

## 2. 已确认的环境前提

| 项 | 事实 | 来源 |
|---|---|---|
| UPDRDB 形态 | DBAAS 托管，**透传模式**（非分库）；应用只对 proxy 操作，不碰 datanode | 用户确认 + 探针（`DRDB SHOW STATUS` 不可用） |
| UPDRDB 版本 | `5.7.23-upsql-2.4.1`，事务隔离 `READ-COMMITTED` | 探针 |
| Proxy | **2 个地址**，DBAAS 不提供 VIP；**不允许新增服务**做 LB | 用户确认 + `指引手册` §客户端负载均衡 |
| datanode | 一主一备，切换由 DBAAS 负责；**备库不接读** | 用户确认（读己之写安全） |
| DDL 权限 | **生产与测试均无**；`INSERT` 有。建表脚本发 DBA 同事执行，随到随办 | 用户确认 |
| 服务端时区 | `@@time_zone = +08:00`，`@@system_time_zone = CST` | 探针 |
| 服务端排序规则 | `@@collation_server = @@collation_database = utf8mb4_general_ci` | 探针 |
| UPRedis 版本 | **5.0.14**，开发与生产**一致**，不升级、不新申请 | 用户确认 |
| UPRedis 拓扑 | 有前置代理；探针实测**代理在按 key 路由**（与"只做主备"的说法待运维复核） | 探针 |
| Redis 实例数 | **可给 2 套**（Agent 协调 + sandbox replay 防重放），现有隔离设计得以保留 | 用户确认 |
| DBPM | UPDRDB 与 Redis 口令**都走** DBPM，共 3 组凭据；容器**可开出网权限** | 用户确认 |

---

## 3. 现状盘点

### 3.1 谁在连 MySQL

| 消费者 | 驱动 | 入口 | 说明 |
|---|---|---|---|
| `agent/` | `knex` + `mysql2@3.15.3` | `agent/src/infrastructure/mysql/client.ts` | Run／ToolExecution／Conversation／审批账本；**迁移权威**（22 个迁移） |
| `agent/`（第二条路） | **裸 `mysql2` `Pool`** | `agent/src/runtime/providers/mysql-session-store.ts:65` 自建池 | DSH 会话持久化，**不走 knex** |
| `exec/` | 裸 `mysql2` `Pool` | `exec/src/db/client.ts` | 只写自己的 `exec_*` 表 |
| `api-server/` | 无 | — | BFF 不碰 DB，符合 AGENTS.md §1 |

DSN 白名单是硬编码的：`agent` 只收 `mysql://` / `mysql2://`，`exec` 额外收
`mysql+pymysql://`。UPDRDB 走 MySQL 协议，**scheme 不用改**。

### 3.2 能直接用的部分（真机已验证）

| 特性 | 现状 | 真机结论 |
|---|---|---|
| 字符集／排序 | 全部 `utf8mb4_unicode_ci`（49 处）+ `ascii_bin`（8 处），**每处显式 COLLATE** | ✅ 无 `utf8mb4_0900_*` |
| 存储引擎 | 迁移里不写 `ENGINE=` | ✅ 透传默认 InnoDB |
| JSON 列 | `t.json()` 20+ 列 | ✅ 往返正常（字符串形态） |
| 生成列 | `CHAR(64) … GENERATED ALWAYS AS (LOWER(SHA2(…))) STORED` | ✅ 可建 |
| CTE／窗口函数／`JSON_TABLE` | **零使用** | ✅ 真机如期被拒，确认 5.7 基线 |
| `CHECK` 约束 | **零使用** | ✅ |
| 外键 | 43 处 | ✅ **真实生效**（拒绝孤儿行） |
| 嵌套事务／SAVEPOINT | 代码显式规避（`if (this.db.isTransaction === true)`） | ✅ 不产生 SAVEPOINT |
| `SELECT … FOR UPDATE`（不带 SKIP LOCKED） | 20+ 处 | ✅ |
| 唯一索引、`ON DUPLICATE KEY UPDATE`、事务原子性 | — | ✅ 全过 |
| knex 迁移器自身依赖 | 记账表、自增、抢锁 UPDATE | ✅ 全过 |

### 3.3 为什么必须选透传模式

`指引手册` L45："500GB 以下且未来无增长，建议透传模式"。分库模式会额外引入：

- **外键失效**：43 处 FK 在 lamost 分片表上无法保留 → 完整性要挪到应用层
- **唯一性语义退化**：现有 `idempotency_key`、`agent_definitions_org_name_unique`
  会从"全局唯一"退化为"分片内唯一" —— **这是正确性问题，不是性能问题**
- **建表语法侵入**：每张表要 `ENGINE=lamost` + `COMMENT='[group:datanode:singleton]'`，
  22 个 knex migration 全部要重写为 `raw()` DDL
- 自增列不保证递增有序（雪花算法）；不支持临时表／视图／存储过程／触发器

若未来必须分库，那是一次独立的架构变更（需新 ADR），不在本次范围。

---

## 4. P0 改造项

### P0-1 `FOR UPDATE SKIP LOCKED` — MySQL 8.0 独有

命中 2 处：

| 位置 | 用途 |
|---|---|
| `agent/src/infrastructure/outbox/outbox-repository.ts:256` | Outbox 多发布者并发抢批 |
| `agent/src/infrastructure/mysql/repositories/cron-job-repository.ts:268` | Cron 到期任务抢占 |

5.7 没有 `SKIP LOCKED`。**去掉它不会报错，而是悄悄退化成串行 + 偶发 1205 锁等待超时** ——
这正是 AGENTS.md §3 警告的"猜测性修复改错地方"的典型场景。

**方案：claim-then-read。** 用单条 `UPDATE … SET claim_token=? WHERE … ORDER BY … LIMIT ?`
抢占，再按 `claim_token` 回读。一次往返、天然幂等，`domain_outbox` 已有 `claim_token` 列。

**真机验证**（`updrdb_recheck.py` ③④）：

```
③ claim-then-read 互斥（两连接同抢一行）
  A 抢到 1 行, B 抢到 0 行, 归属 worker-A → 恰好一个赢，方案成立
④ 批量抢占 UPDATE … ORDER BY … LIMIT  影响 1 行（期望 1）
```

`cron_job_runs` 的 `idempotency_key` 唯一键提供二次兜底，改造后仍是 fail-closed。

**回归测试要求**：新增并发抢批测试必须在修复前失败、修复后通过（AGENTS.md §3.3）。

### P0-4 两个 Proxy 的故障切换

手册对这点分得很清楚（`指引手册` §客户端负载均衡）：

> 银联云实例对外提供 VIP，客户端不需要配置负载均衡。
> **DBAAS 实例，客户端则需自行配置多个 Proxy 服务进行负载均衡。**

手册给的做法是 JDBC 的 `jdbc:mysql:loadbalance://h1,h2`，**Node 侧没有等价物**
（mysql2 的 DSN 只接受单 host，knex 也只接受单份 connection 配置）。
且不允许新增服务，所以 K8s Service / haproxy sidecar 这条路排除。

**策略：粘住主用、挂了才切，不做轮询。**
轮询会让两个 proxy 上的会话状态分叉，而且 DBAAS 的 proxy 不是性能瓶颈。

- 共享模块放 `contract/`（`agent` 与 `exec` 都要用），持有地址列表 + 每个地址的拉黑到期时间
- 建连失败 → 拉黑 **180s**（对齐手册建议的 `loadBalanceBlacklistTimeout=180000`），切下一个
- **不自动回切**：拉黑期满前不碰它，避免抖动
- 全部被拉黑 → 清空拉黑表再完整试一轮，仍失败才 fail-closed 抛错

三个接入点：

| 接入点 | 做法 |
|---|---|
| `agent/` knex | **`connection` 传函数**。knex `client.js:87` 判 `config.connection instanceof Function` → 存为 `connectionConfigProvider`，由返回值的 `expirationChecker()` 决定何时重新解析（`client.js:285-305`）。返回 `{host, port, …, expirationChecker: () => 当前地址已被拉黑}` |
| `mysql-session-store.ts` 裸池 | **每个 proxy 各建一个池**，选择器决定用哪个。**不要"重建池"** —— 会和 in-flight 查询竞态 |
| `exec/src/db/client.ts` 裸池 | 同上 |

两条必须一起做的配套：

- **收紧 `connectTimeout` 到 3000ms**（手册建议值）。不收紧的话，挂掉的 proxy 会让每次
  建连卡在 mysql2 默认超时上，切换慢到没有意义。真机建连实测 172ms，3000ms 余量充足。
- **只在建连时切换，不重试已发出的语句。** 连接中途断掉的**写**语句**不能安全重试** ——
  它可能已在服务端提交。这类错误必须冒泡给调用方，由现有幂等机制兜底
  （outbox 的 `claim_token`、cron 的 `idempotency_key`）。
  **PR 里要写明这条边界**，避免后人"顺手"加个通用重试把它变成重复执行。

备库不接读已确认，所以 `SELECT … FOR UPDATE`、读己之写、BullMQ 状态读写都不受影响。

### P0-5 生产与测试均无 DDL 权限

现在的编排把自动迁移设成了硬依赖：`agent` / `agent-worker` / `sandbox` 三个服务都
`depends_on: agent-migrate: condition: service_completed_successfully`
（`docker-compose.yml:352,448,573`；prod overlay 227/359/411）。
没有 DDL 权限 → `cli-migrate latest` 必然失败 → **全栈无法启动**。

**定案：移除 `agent-migrate` 服务，先手工建库建表再起服务。**

权威链条：

```
knex migrations（代码，唯一权威，评审 + 版本化）
    ├── 本地 Docker mysql:5.7 —— 我们自己的容器，有 DDL
    │     migrations 直接跑，CI 与本地集成测试在这里
    └── migrate:sql 导出 → 建表脚本(.sql)
          └── 手工执行到 开发／测试／生产 的 UPDRDB
                └── agent 启动时 migrate:verify 校验
```

要动的地方：

- 删除 `docker-compose.yml:78` 的 `agent-migrate` 服务定义与 prod overlay 对应块
- 删除三处 `depends_on`
- `cli-migrate.ts` **保留**（开发／测试仍要用），只是不再由编排自动调用

三件要做的事：

1. **新增 `migrate:sql` 导出命令。** knex 没有原生的"迁移转 SQL"，
   但可以挂 `knex.on('query', …)` 在影子库上跑一遍 `migrate latest`，按顺序捕获真实 DDL。
   比 `mysqldump --no-data` 好在能保留每个迁移的边界，便于分批审批。
2. **新增 `migrate:verify` 只读校验，放进 `agent` 启动路径**（不是新增服务）。
   对照 `schema-tables.ts` 的表清单 + `knex_migrations` 记录，缺表／缺列／版本落后
   一律 fail-closed。成本是一次 `information_schema` 查询。
   在"建表全靠手工"的流程下，这层校验比原先更重要 —— 手工漏一张表会在启动时被拦住，
   而不是运行到某个功能才报"表不存在"。
3. **导出脚本自带 `INSERT INTO knex_migrations`。**
   `knex_migrations` 是 knex 的记账表（`id / name / batch / migration_time` 四列），
   记录哪些迁移已执行。写它是 **DML 不是 DDL**，生产有 `INSERT` 权限即可。

**副作用**：`migrate-trigger-preflight.ts` 存在的理由是"非 SUPER 账号在开了 binlog 时
建不了触发器"。生产改由 DBA 执行 DDL 后，DBA 有权限，**这个坑自动消失**。

**减轻人工环节的三条**（DDL 执行是随到随办，不必攒批）：

1. **零手写**：`migrate:sql` 自动生成，不存在"人肉翻译 migration 到 SQL"这一步，
   也就没有翻译错误
2. **设计上少改 schema**：优先加列而非加表；能用现有 JSON 列承载的
   （`config_json` / `payload_json` 已有先例）就不新开表。**这条会影响功能设计取向**
3. **按"schema 变更"而非"建表"设计流程**：加列、加索引同样需要 DDL

### P0-6 时区不一致

3 个迁移的 7 个列用**服务端** `CURRENT_TIMESTAMP(3)` / `knex.fn.now(3)` 填值：

| 迁移 | 列数 |
|---|---|
| `20260901000002_dsh_session_persistence.js` | 3 |
| `20260904000001_exec_artifacts_datasets.js` | 2 |
| `20260904000002_workspace_quota_reservations.js` | 2（含 `ON UPDATE CURRENT_TIMESTAMP(3)`） |

服务端按 `+08:00` 写本地时间；应用其余列走 `toMysqlDateTime()`
（`row-mappers.ts:316` → `d.toISOString()`，**硬编码 UTC，不受 DSN 参数影响**）。
**同一张表里两套时间基准，相差 8 小时。**

真机确认（`updrdb_recheck.py` ①）：

```
server_filled = 2026-09-08 14:52:21.414 (服务端 +08:00)
app_written   = 2026-09-08 06:52:21.437 (应用 UTC)
偏差 = +8.00h
```

后果不是"显示时间不对"这么轻 —— 按创建时间排序、TTL／过期判断、
`updated_at` 乐观并发比较、跨表时间关联全部会错，**而且不报错，只是结果不对**。

#### 定案：会话级 `SET time_zone = '+00:00'`

应用侧时基不可动（硬编码 UTC），所以要让**服务端默认值那一侧**也按 UTC 生成。
在复刻的 `+08:00` MySQL 5.7 上实测两种连接方式：

| 连接工厂 | 机制 | 实测 |
|---|---|---|
| `agent/` knex（`client.ts:144` 已有 `pool:` 配置块） | `pool.afterCreate` 发 `SET time_zone='+00:00'` | 偏差 **8.00h → 0.00h** ✅ |
| 裸 mysql2 池（`exec/src/db/client.ts`、`mysql-session-store.ts`） | `pool.pool.on('connection', c => c.query("SET time_zone='+00:00'"))` | 偏差 **8.00h → 0.00h** ✅；并发压 5 条验证**池扩容出的新连接同样带上**（最大偏差 0h） |

三处连接工厂各加一行，并加一条集成测试断言"服务端默认值与应用写入值时间基准一致"。

#### 不采用的三个方案

| 方案 | 不采用的理由 |
|---|---|
| `SET GLOBAL time_zone` 或改 upsql 配置 | **改的是共享托管实例的全局配置**，影响同实例其他应用；DBAAS 托管也不该由我们要求改。UPDRDB 手册明确列 `SET GLOBAL` 为不支持（探针发现实际可用，但不该依赖） |
| 去掉 DSN 的 `timezone=Z`，让驱动用本地时区 | **治不了本**。应用写入走 `toISOString()` 永远是 UTC，跟 DSN 无关；改 DSN 只会让读取路径也变得不确定。且 `client.ts` 里 `timezone=Z` + `dateStrings=true` 是注释写明"故意固定、不可覆盖"的边界设定 |
| 所有时间列改由应用显式写入 | 方向正确但成本高：改 3 个迁移 + 对应仓储，且**任何新迁移漏写默认值就复发**。可作为长期收敛方向，不作为本次修复 |

> ⚠️ **本地 Docker MySQL 默认 UTC，这个陷阱在开发环境永远复现不出来。**
> 建议把本地 compose 的 mysql 也设成 `--default-time-zone=+08:00`，
> 配合上面那条集成测试断言形成防线。这是"降基线到 5.7"策略也覆盖不到的盲区 ——
> 说明真机探针不可替代。

### P0-2 触发器 — 已取消

`SQL支持列表` 标 `CREATE TRIGGER` 不支持，`指引手册` L208/L235 也标不支持，
但那两处**明确限定在分库模式**（L216："接下来，将…**在分库模式下**SQL语法支持情况…重点介绍"）。
反向证据：`指引手册` L2237 §专属功能记载 UPDRDB **为 `CREATE TRIGGER` 增加了 `OR DISPLACE` 扩展**，
`更新日志` 把该特性列在"辅助处理器及数据节点"而非"协调器"下 —— 说明是内核能力。

**真机四步实测全过**：

```
① CREATE TRIGGER           ✅ 可创建
② 触发器是否真的拦住 UPDATE  ✅ UPDATE 被拒且值未变 —— 真正生效
③ DROP TRIGGER             ✅ 可删除（迁移 down() 依赖）
④ SHOW TRIGGERS            ✅ 正常
⑤ CREATE OR DISPLACE       不支持（仅少一个幂等化手段，不影响）
```

4 个 append-only 触发器（`trg_messages_forbid_update/_delete`、snapshot 两个）
**原样保留，不需要 REVOKE 兜底那条降级路径**，AGENTS.md §2 的安全不变量不降级。

> 注：探针账号是 `GRANT ALL PRIVILEGES`，生产应用账号无 DDL。结论仍成立
> （生产 DDL 由 DBA 执行），但别据此以为应用账号能建触发器。

### P0-3 服务端预处理语句 — 已降为技术债

`SQL支持列表` 标"不支持 Prepared SQL Statement Syntax"，`指引手册` L1004
建议"避免开启服务端 prepare"。mysql2 的 `execute()` = `COM_STMT_PREPARE` + `COM_STMT_EXECUTE`。

**真机实测：服务端接受 `COM_STMT_PREPARE`**，SQL 层 `PREPARE/EXECUTE` 也可用。
所以 45 处调用可以照常工作。

范围（供将来处理时参考，正则用 `\.execute[<(]`，**注意带泛型的写法**）：

| 包 | 文件 | 处数 |
|---|---|---|
| `exec/` | `shell/job-store-mysql.ts` | 7 |
| `exec/` | `workspace/quota-store.ts` | 4 |
| `exec/` | `db/repositories/`（datasets 6、artifacts 4、session-events 4、workspaces 3、executions 3） | 20 |
| `agent/` | `runtime/providers/mysql-session-store.ts` | 14 |
| | **合计** | **45 处 / 8 个文件** |

改法是 `.execute(…)` → `.query(…)`：mysql2 的 `query()` 同样支持 `?` 占位并在客户端转义，
**参数化和防注入不受影响**。`query<T>()` 的泛型约束与 `execute<T>()` 略有差异，靠 typecheck 兜住。

记入 `review-deferred-items.md`（非阻塞债务，AGENTS.md §8）。

---

## 5. P1 与其他注意事项

| # | 项 | 处理 |
|---|---|---|
| P1-1 | 排序规则混用：`@@collation_server = utf8mb4_general_ci`，漏写 `COLLATE` 的新表与既有表跨表 JOIN **报 1267**（真机复现） | 现有 22 个迁移每处都写了。**在 `tests/` 加一条断言**扫迁移文件，要求字符串列显式 `utf8mb4_unicode_ci`，属仓库卫生检查。**不改服务端** —— 同样是改共享实例，且对存量表无效（collation 建表时固化） |
| P1-2 | `SHOW WARNINGS` / `SHOW STATUS` / `SHOW PROCESSLIST` 手册标"结果不保证正确性" | 目前未使用；建立禁用清单写进 `development.md` |
| P1-3 | `SET` 会话变量需 proxy 白名单 | 透传模式支持全部 SET；`TIME_ZONE` 在 `指引手册` L499 白名单内（P0-6 依赖） |
| P1-4 | `KILL QUERY` 会被当 `KILL CONNECTION` 执行 | 代码未使用，仅记录 |
| P1-5 | 版本钉与卫生测试硬断言镜像 | `tests/test_container_startup.py:22-23`、`test_cross_service_smoke_config.py:39,41,43`、`test_redis_topology_config.py:33,91` 随镜像变更同 commit 更新；`runtime-versions.json` 新增段 |

---

## 6. UPRedis 评估

### 6.1 命令面

**应用直接调用**（`agent/src/infrastructure/redis/*`、`exec/src/mcp/*`）：
`SET`(+`PX`/`EX`/`NX`)、`GET`、`DEL`、`EXPIRE`、`PEXPIRE`、`HSET`、
`XADD`、`XRANGE`、`XLEN`、`EVAL` —— **全部 ≤ Redis 5.0**。

**BullMQ 5.80.7 的 Lua 脚本**调用的命令全集逐条核对后同样全在 5.0 内。
`LPOS`（6.0.6 引入）是唯一例外，但见 §6.2。

### 6.2 Redis 5.0.14 够不够用 —— 够

`bullmq@5.80.7` 全仓只有 6 处版本门槛：

| 位置 | 门槛 | 5.0.14 上的行为 |
|---|---|---|
| `redis-connection.js:202` | `minimumVersion = 5.0.0` | ✅ 通过 |
| `redis-connection.js:206` | `recommendedMinimumVersion = 6.2.0` | ⚠️ 仅 `console.warn`，每条连接打一次（一次启动 3 条） |
| `redis-connection.js:212` | `canDoubleTimeout` ≥ 6.0.0 | ❌ false → 阻塞超时向上取整到整秒（唯一实际差异） |
| `redis-connection.js:213` | `canBlockFor1Ms` ≥ 7.0.8 | ❌ false —— **6.0.12 上同样是 false**，不是 5.0 独有 |
| `scripts.js:690` | `getState` ≥ 6.0.6 用 LPOS 版 | ✅ **自动降级**到 `getState-8.lua`（LRANGE 实现） |
| `scripts.js:70` | `isJobInList` ≥ 6.0.6 用 LPOS | ✅ **自动降级**到 `isJobInList-1.lua` |

**没有一条会失败**，两处 LPOS 相关的都有 Lua 降级实现。

真实场景实测（本机 `redis:5.0.14` vs `redis:6.2` 对照）：

| 场景 | 5.0.14 | 6.2 | 判断 |
|---|---|---|---|
| 延迟任务 `delay=300ms` | 1077ms（迟 777ms） | 370ms（迟 70ms） | ⚠️ 亚秒级延迟被抬到 ~1s |
| 延迟任务 `delay=3000ms` | 3064ms（迟 64ms） | 3058ms（迟 58ms） | ✅ 无差异 |
| 失败重试 ×3（fixed 500ms 退避） | 2109ms | 1111ms | ⚠️ 每跳多 ~0.5–1s |
| 并发 20 任务（concurrency=5） | 50ms | 27ms | ✅ 可忽略 |
| **stalled 恢复**（worker 卡死后接管） | **2022ms** | **2023ms** | ✅ **完全一致** |
| BullMQ 端到端投递 | 19ms | — | ✅ |
| `getState()` 终态／等待态 | 均正确 | 同 | ✅ |
| `run-queue.ts:218` 重入队去重 | 完整可用 | 同 | ✅ |

**唯一代价：亚秒级定时器向上取整到整秒，最坏每跳多约 1 秒。**
用到延迟任务的只有 cron 触发的 Run（粒度分钟级）和重试退避（本来就是秒级），多 1 秒无意义。
吞吐、并发、作业状态机、stalled 恢复全部无差异。

**升级换不来任何东西** —— 两个真 BLOCKER 与版本无关，升到 6.x 也躲不掉。

记在案（都不是阻塞项）：

1. BullMQ 的 `recommended ≥ 6.2.0` warning 一次启动打 3 条，日志基线里认掉
2. **Redis 5.0 已停止维护**（5.0.14 发布于 2021-10，之后无安全补丁）。
   这是安全口径问题，不是技术阻塞 —— 服务在内网、有密码、不对外暴露。
   **若安全侧将来要求 ACL，需要 6.0+**，届时再评估
3. 5.0 没有 ACL，当前用 `requirepass`（`redis://:password@host`）即可

### 6.3 两个真 BLOCKER

**① 代理按 key 路由，BullMQ 的多 KEY 脚本被拒**

探针实测报错 `keys must route to same node`，且 `EVAL` 不带 key 会被拒
（"wrong number of arguments"）。BullMQ 单条脚本最多 **14 个 KEY**
（`moveToFinished-14`、`moveToDelayed-12`、`moveToActive-11`…），
key 形如 `bull:<queue>:wait`，**不带 hash tag**。

**修复已验证**：把 `prefix` 改成带 hash tag 的 `{bull}`：

```
prefix=bull    → bull:<queue>:id , bull:<queue>:active        （分散）
prefix={bull}  → {bull}:<queue>:id , {bull}:<queue>:j1:lock   （同 slot ✅，端到端 16ms）
```

`run-queue.ts:154,283` 已经支持传 `prefix`，**改配置即可，不动逻辑**。
**但这会改变既有队列的 key 空间，必须在切换时一次做完，事后补不了。**

我们自己的 3 个锁模块全是 `numkeys=1`，不受影响。

> 这与"UPRedis Proxy 只做主备、不做 cluster"的说法不符 —— 主备不需要 key 路由。
> **请运维复核后端拓扑**；不过 hash tag 方案对两种拓扑都安全，不影响推进。

**② `maxmemory-policy = volatile-lru`**

BullMQ 硬性要求 `noeviction`，否则作业数据被静默驱逐 → **丢 Run**。
运维一条 `CONFIG SET maxmemory-policy noeviction` 即可。

### 6.4 已排除的两个误报

| 报告结论 | 复核 |
|---|---|
| LPOS 不可用 → BullMQ 队列异常 | ❌ **误报**。BullMQ 自己做了版本降级（§6.2）。真 5.0.14 上端到端 19ms 通过，`getState()` 对终态与等待态都正确 |
| `INFO replication` role 为空 → 可能连到备库 | ❌ **误报**。代理不透传 `INFO replication`，读不到 ≠ 连到备库；**读己之写 200/200 通过**即是反证 |

---

## 7. DBPM 接入设计

### 7.1 现状差距

`docs/ref/dbpm/usage.py` 是 **Python** 样例，而需要口令的进程是 Node。
协议：TCP，请求 `b'\x0E\x02' + f" {db_name} {db_user_name}\n"`，
响应 `OK: {password}\n`，双节点主备。

**要取 3 组口令**：

| # | 用途 | 消费者 |
|---|---|---|
| 1 | UPDRDB | `agent` / `agent-worker` / `sandbox` |
| 2 | 服务 Redis（Agent 协调） | `agent` / `agent-worker` / **`sandbox-mcp`**（`SANDBOX_MCP_REDIS_URL` 默认指向同一实例，用于 context/artifact 元数据） |
| 3 | sandbox-replay Redis（内部 HMAC jti 防重放） | **`sandbox` 独占** |

（DBPM 自身的主备两台是**地址**层面的高可用，不是第四组凭据。）

### 7.2 客户端实现

新增模块优先放 `contract/`（两个包都要用，且是 RPC 契约性质）。
必须补上样例里没有的三件事：

1. **超时**。样例的 `socket.connect` 没有超时，一个挂起的 DBPM 会拖住整个启动
   （AGENTS.md §2："所有出站调用有超时"）。建议 connect 3s / 整体 5s。
2. **fail-closed**。两台都失败 → **进程退出**，不能回退到环境变量里的明文口令。
   写成显式测试。
3. **按 `\n` 收全再解析**。样例 `s.recv(128)` 截断在 128 字节且不循环读。

口令永不落盘、永不进日志；错误信息只带 `host:port`，绝不回显响应体。

### 7.3 口令生命周期：只在启动取一次

**进程启动时取一次，运行期不轮换、不重取；口令变更通过重启生效。**

- 建连接池**之前**调用一次 DBPM，口令直接组装进连接配置，之后客户端不再被引用
- 口令只存在于建池那一刻的局部变量与连接池内部，不写 `process.env`、不写模块级单例
- **不实现**认证失败重取、定时预取、池热重建，也**不留"以后可能要轮换"的半成品钩子**

运维约束（要写进 `deployment.md` 与 runbook）：口令变更**必须滚动重启**
`agent`、`agent-worker`、`sandbox`、`sandbox-mcp`。症状是**渐进的
`ER_ACCESS_DENIED`**（老连接还活着，新建连接失败），排查时容易误判成网络问题；
连接池的空闲回收会让它提前发生，别指望"老连接还在"能拖延重启。

### 7.4 开发挡板：用假服务端，不要在应用里加 stub 分支

| 做法 | 评价 |
|---|---|
| ❌ 客户端里加 `if (!DBPM_URL) 用环境变量口令` | 这是**回退到默认可用**的路径，违反 AGENTS.md §2。生产误配 `DBPM_URL` 为空就会静默降级成明文口令，且无告警 |
| ✅ **跑一个说真协议的假 DBPM 服务端** | 生产代码只有**一条**取密路径；开发／测试／生产的差异只是**地址**，不是代码 |

已提供 [`probe/fake_dbpm_server.py`](./probe/fake_dbpm_server.py)（零依赖）：

```bash
python3.13 probe/fake_dbpm_server.py --port 7000 --entry sandboxdb:sbuser:dev_only_pwd &
python3.13 probe/fake_dbpm_server.py --port 7001 --entry sandboxdb:sbuser:dev_only_pwd &
# DBPM_URL=127.0.0.1:7000,127.0.0.1:7001
```

`--fail-rate 0.3` 按比例注入错误，用于验证"第一台失败切第二台"与
"两台皆挂 → 进程拒绝启动"两条路径 —— **必须有测试覆盖**。
条目名先用占位值，拿到真实 `db_name`/`db_user` 后只改配置，不动代码。

### 7.5 容器内取密与网络接线

**口令在容器内、由应用进程自己取。** 不做宿主机预取、不做 entrypoint 脚本 `export`、
不经 compose `environment:` 传 —— 那些做法会让明文口令出现在 `docker inspect`
和进程环境里，等于绕开了 DBPM 存在的理由。

代价是网络可达性成为硬前提。现有网络切分：

| 服务 | 现有网络 | 需要 DBPM | 结论 |
|---|---|---|---|
| `agent` / `agent-worker` / `sandbox` | backend_internal + service_egress | 要 | ✅ 可达 |
| `agent-migrate` | backend_internal only | — | 该服务将被移除（P0-5） |
| **`sandbox-mcp`** | **backend_internal only**（`internal: true`，完全不能出网） | **要** | ❌ **需要接线** |

**做法：新增 `dbpm_egress` 窄网络**，只挂给需要取口令的服务。
不直接给 `sandbox-mcp` 通用 `service_egress` —— 它是对外 MCP facade，
AGENTS.md §1 强调其凭据面最窄，开通用出网口与该设计取向相悖。
生产侧再由防火墙把出向限死到 DBPM 的两个地址。

### 7.6 配置面变化

`.env.example` 与 `deployment.md` **双侧同步**（AGENTS.md §10）新增：

```
DBPM_URL=ip1:port1,ip2:port2   # 逗号分隔两个地址，占位符
DBPM_DB_NAME=
DBPM_DB_USER_NAME=
DBPM_REDIS_DB_NAME=
DBPM_REDIS_DB_USER_NAME=
DBPM_REPLAY_REDIS_DB_NAME=
DBPM_REPLAY_REDIS_DB_USER_NAME=
```

DSN 变成**不含口令**的形式（`mysql://user@host:port/db`、`redis://host:6379/0`）。
`assertMysqlConnectionUrl` 需放行无口令 DSN（现只校验 scheme，应该已能过，但要补测试）。

---

## 8. 分阶段实施计划

**总策略：先把开发／CI 基线降到 MySQL 5.7 + Redis 5.0.14，按 UPDRDB／UPRedis 文档做改造，
不等真实实例。** 每阶段独立 PR，阶段测试通过再进下一阶段（AGENTS.md §3）。

### 阶段 1：把基线降到 5.7 + 5.0.14（改造的地基）

不是"顺手改个镜像"，而是**让测试套件从此为我们把关**：

- `docker-compose.yml`：`mysql:8.0` → `mysql:5.7`，`redis:7.2` → `redis:5.0.14`
  （**现有 4 个 mysqld flags 在 5.7 上原样可用，已实测**）
- **mysql 加 `--default-time-zone=+08:00`**，让 P0-6 的陷阱在开发环境可复现
- 同步版本断言（P1-5 列出的三处）与 `runtime-versions.json`
- **CI 必须同时设 `TEST_MYSQL_URL` 与 `TEST_REDIS_URL`** —— 见 §9.2 的陷阱
- macOS 上 `mysql:5.7` 需 `--platform linux/amd64` 模拟（已实测可跑，首次启动约 1 分钟）

**做完这一步，P0-1 会在测试里自己暴露出来**（已验证：outbox 集成测试报 1064
并指向确切 SQL）。这比任何文档核对都可靠。

### 阶段 2：P0-1 + P0-6

- P0-1：outbox + cron 改 claim-then-read，新增并发抢批回归测试
- P0-6：三处连接工厂加会话时区，新增"两套写入路径时间基准一致"的集成测试断言
- P1-1：新增迁移排序规则的卫生测试
- 验收标准：**阶段 1 降基线后失败的测试全部转绿**

### 阶段 3：P0-4 多 Proxy 故障切换

- `contract/` 新增 endpoint 选择器（粘住主用 + 拉黑 180s + 全黑清表重试）
- 三个接入点：knex 函数式 `connection`、agent 裸池、exec 裸池
- `connectTimeout` 收到 3000ms
- 单测覆盖：主挂→切备、备也挂→fail-closed、拉黑期内不回切、**建连中断不重试写语句**

### 阶段 4：P0-5 + DBPM

- 删 `agent-migrate` 服务与三处 `depends_on`
- 新增 `migrate:sql` 导出（影子库 + `knex.on('query')` 捕获）
- 新增 `migrate:verify`，接进 `agent` 启动路径
- `contract/` 新增 DBPM 客户端（超时 + fail-closed + 按 `\n` 收全），取 3 组口令
- 新增 `dbpm_egress` 窄网络
- 文档同步：`.env.example` / `deployment.md` / `development.md` / runbook

### 阶段 5：UPRedis 切换

- **先跑 `probe/upredis_probe.py`，退出码非 0 不要往下走**
- BullMQ `prefix` 改 `{bull}` hash tag（**一次做完，事后补不了**）
- 确认运维已把 `maxmemory-policy` 改为 `noeviction`
- 认掉 BullMQ 的版本 warning；复核 cron 时延断言（§6.2 的 ~1s）

### 阶段 6：切真实 UPDRDB

- 此时代码已在 5.7 + 5.0.14 上被测试证明过，这一步只是换连接目标
- 手工执行建表脚本 → 起服务 → `migrate:verify` 应通过
- **必须重建容器**（`agent agent-worker api-server sandbox sandbox-mcp`）
- 真实链路：登录 → 建会话 → 一轮带工具的 run → 进程 logs/signal → 跨租户 404

### 阶段 7：文档收口

`architecture.md`（§27/§112/§408）、`deployment.md`（§93/§229/§574）、
`development.md`（§306/§330）、`CONTRIBUTING.md`（§89/§162）、
`STATUS.md`、`CHANGELOG.md [Unreleased]`、`runbooks/development-reset.md`、
`runbooks/mysql-partial-migration-recovery.md`。

---

## 9. 验证证据

### 9.1 真机探针（2026-09-08）

原始输出：[`probe/result.md`](./probe/result.md)、[`probe/recheck_result.txt`](./probe/recheck_result.txt)。

UPDRDB `5.7.23-upsql-2.4.1`：`SKIP LOCKED` 不可用（1064）；触发器四步全过；
`COM_STMT_PREPARE` 被接受；8.0 语法全部如期被拒；真实 schema 形状、外键真实生效、
knex 迁移器依赖全过；**时区偏差 +8.00h**；**claim-then-read 互斥成立**；
排序规则混用复现 1267。

UPRedis `5.0.14` + 代理：Lua 带 key 可用、14-KEY 跨节点被拒、
`maxmemory-policy=volatile-lru`、读己之写 200/200 通过。

### 9.2 "先按 5.7 改造"策略的本机验证（2026-09-07）

| 验证项 | 结果 |
|---|---|
| 现有 4 个 mysqld flags 在 5.7 上 | ✅ `mysql:5.7.44` 原样启动，compose flags 不用改 |
| **22 个 knex 迁移** | ✅ **一次全过：42 张表 + 4 个触发器**，记账正常 —— schema 层完全 5.7 兼容 |
| 迁移回滚再重放 | ✅ |
| **MySQL 集成测试** | ✅ **9/9 全过**：外键真实生效、并发追加序列唯一、并发同键 CreateRun、DATETIME 不漂移 |
| 触发器拦住直接 SQL | ✅ `MessageRepository is append-only; direct SQL UPDATE/DELETE are rejected` |
| agent 单测全套 | ✅ 1258/1262；失败的 4 条是端口占用与时序，与 SQL 无关 |
| **outbox 集成测试** | ❌ **报 `errno 1064 … near 'SKIP LOCKED'`**，精确指向 P0-1 |

**⚠️ 必须一起处理的陷阱**：`tests/outbox/outbox.integration.test.js` 需要
`TEST_MYSQL_URL` **和** `TEST_REDIS_URL` 两个都设才真正执行。
只设前者时它**静默跳过并报 1 pass 绿灯**。同理大量 `*.unit.test.js` 用假 knex，
例如 `claimBatch emits SKIP LOCKED SQL` 只断言 SQL **字符串**，在 5.7 上照样全绿。

**所以阶段 1 的验收不能只看"六套测试绿"**，必须确认两个 URL 都设了、集成测试真的执行了
（看用例数不是看颜色）。建议给集成测试加一条"环境齐备时不允许跳过"的断言。

### 9.3 修复方案的实测

| 方案 | 验证 |
|---|---|
| P0-6 会话时区（knex `afterCreate`） | 复刻 `+08:00` 实例：偏差 8.00h → **0.00h** |
| P0-6 会话时区（裸 mysql2 `pool.on('connection')`） | 同上；并发压 5 条确认**池扩容出的新连接也带上**（最大偏差 0h） |
| §6.3 hash tag prefix | `{bull}` 前缀所有 key 落同一 slot，端到端 **16ms** |
| §6.2 Redis 5.0.14 vs 6.2 | 见 §6.2 表格 |

---

## 10. 验证计划（AGENTS.md §4）

| 阶段 | 最低验证 |
|---|---|
| 1–4 | 六套测试 + 各包 typecheck + `npm run build --prefix frontend`；新增回归测试必须修复前失败 |
| 2 | 另加：并发抢批测试、时区一致性断言 |
| 5 | 起 UPRedis 5.0.14 跑 agent + agent-worker 全链路；显式记录 BullMQ warning 与 delayed job 时延 |
| 6 | **必须重建容器**跑真实链路；手工建表脚本 → `migrate:verify` 通过 |

验证记录必须包括：代码版本／未提交改动、runtime 版本、命令、结果与跳过原因、
验证对象是否重建。使用假 provider、内存仓储或替身时明确其边界。

**已知环境陷阱**：`scripts/smoke-cross-service.mjs` 在 macOS 上必失败
（bwrap 需要 user namespace），应在 Linux/CI 跑 —— 与本次改造无关，别误判。

---

## 11. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 集成测试静默跳过 | **高（现状即如此）** | 六套绿但没验到东西 | 阶段 1 同时处理（§9.2） |
| hash tag 改造遗漏 | 中 | 队列 key 空间改变，**事后补不了** | 阶段 5 一次做完，改前后各跑一次 `upredis_probe.py` |
| 代理拓扑与"只做主备"说法不符 | 中 | 可能还有其他路由限制未暴露 | 请运维复核；hash tag 对两种拓扑都安全 |
| 时区修复漏掉某个连接工厂 | 中 | 部分表仍差 8 小时，**不报错只是结果不对** | 三处连接工厂 + 集成测试断言 + 本地 compose 设 `+08:00` 复现 |
| 建连中断被"顺手"加通用重试 | 中 | 写语句重复执行 | PR 写明边界；靠 `claim_token` / `idempotency_key` 兜底 |
| 新增迁移漏写 `COLLATE` | 中 | 运行时 1267 | P1-1 的卫生测试 |
| Redis 5.0 无安全补丁 | 低 | 安全口径问题 | 内网 + 密码 + 不对外；安全侧若要求 ACL 需 6.0+ |

---

## 12. 剩余待明确

| # | 事项 | 归属 |
|---|---|---|
| 1 | **DBPM 的 3 组 `db_name` / `db_user_name`** | DBPM 运维。先用假服务端挡住（§7.4），拿到真实值只改配置 |
| 2 | 运维把 `maxmemory-policy` 改为 `noeviction` | Redis 运维，可立即执行 |
| 3 | UPRedis 代理后端拓扑复核（探针显示在按 key 路由） | Redis 运维，不阻塞 |
| 4 | UPRedis Proxy 空闲连接超时 | Redis 运维；`upredis_probe.py --idle-test` 可实测 |
| 5 | UPRedis 手册（尤其 Proxy 章节）收进 `docs/ref/upredis/` | 有则更好，不阻塞 |
| 6 | 口令变更时通知我们滚动重启的流程 | DBPM 运维 |

**以上都不阻塞阶段 1–3 开工。**

---

## 13. 不在本次范围

- 分库／分片改造（若需要，另开 ADR）
- 存量数据迁移（本仓库当前无生产数据；若有，参考
  `docs/ref/updrdb/2.4.0/UPDRDB-数据导入导出-2.4.0.md`）
- UPDRDB 备份恢复运维、毫秒级高可用（MSHA）特性接入
- DBPM 口令运行期热轮换（当前需求下不需要，不作为债务登记）
- 45 处 `.execute()` → `.query()`（P0-3，转入 `review-deferred-items.md`）
