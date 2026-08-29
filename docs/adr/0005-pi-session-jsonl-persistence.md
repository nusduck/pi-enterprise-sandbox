# ADR 0005: Pi Session JSONL 的在线持久化与恢复分层

| 字段 | 值 |
|------|----|
| 状态 | **Superseded by [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md)**（2026-08-29） |
| 日期 | 2026-08-26 |
| 决策所有者 | Agent runtime / data maintainers |
| 适用范围 | `agent/` 的 Pi Session journal、snapshot、恢复与归档边界 |
| 关联决策 | [ADR 0001](0001-pi-coding-agent-sdk.md)、`plan.md` §2.5、§7、§8.7–§8.9、§12.5 |

> **作废说明（2026-08-29）**
>
> 本 ADR 的六条决策**全部有效并被 [ADR 0007](0007-agent-runtime-rebuild-on-dsh.md) 继承**，
> 只是绑定对象从 Pi 的 JSONL 换成了 DSH 的会话事件。作废的是**措辞层**：所有提到
> `Pi SessionEntry`、`PI_SESSION_JSONL_VERSION`、`SessionManager.open`、
> `toPrecision(15)` 的条款不再适用。
>
> 决策的继承对照见 ADR 0007「会话持久化」一节。本文件保留为**设计推理的历史记录**——
> 特别是「备选方案」表，它否掉的四条路（每会话一个 JSONL 文件、每 Run 全量快照、
> Conversation 单行存全史、对象存储做在线 journal）在新引擎下依然是错的，
> 理由一字不改。
>
> 另注：本 ADR 写作时项目已有落库数据，故有「迁移策略」一节。**该节整节作废**——
> 项目处于研发阶段，决策所有者已确认不做历史数据迁移。

## 背景

Pi SDK `0.80.3` 的 Session 兼容边界是 version 3 JSONL。SDK 没有满足本项目恢复要求的
独立数据库 hydrate/checkpoint API，因此 Agent 需要在恢复时物化完整 JSONL，再调用
`SessionManager.open(...)`。这不等于 JSONL 文件应成为企业在线账本。

当前实现已经遵守以下正确边界：

- MySQL 中的平台 Message、Pi journal 行和 Run Event 是长期恢复依据；
- `agent_session_snapshots` 是加速层，不是唯一事实源；
- Agent 只在进程私有临时目录物化 JSONL，Sandbox 仍独占 Workspace 与 Session 私有
  `/tmp` 的字节权威；
- checkpoint 受 execution fence 保护，并与 Session 版本推进、Run Event、Outbox 同事务提交。

但当前物理布局和恢复算法存在可扩展性风险：

1. Pi journal 与用户可见消息共用 `messages` 表，宽 JSON、内联图片或工具结果会影响普通
   Conversation 查询及索引选择。
2. JSON 值经过 MySQL JSON 编解码后不保证保留输入字节表示；当前 codec 需要对非整数执行
   `toPrecision(15)`，才能维持重建后的 checksum 稳定。这是兼容措施，不是无损存储。
3. 每次 checkpoint 都读取完整 journal，并写入包含完整 `header + entries` 的新 snapshot；
   对持续增长的会话，累计读取和 snapshot 存储量近似二次增长。
4. 正常恢复同时加载完整 snapshot 和完整 journal 做全量 checksum 对照，snapshot 没有真正
   缩短热路径。
5. JSONL 默认上限为 8 MiB，而 prompt image 的独立准入上限可能允许更大的 Base64 输入。
   这证明静态容量策略不一致；尚无线上分布证据可以直接确定新的安全阈值。

冻结基线 `plan.md` 已决定：MySQL 是事实源，Conversation 不能保存整段历史 JSON，平台
Message + Run Event 是长期恢复依据，Pi snapshot 只是适配器级加速。本 ADR 细化这些决策，
不改变它们。

## 决策驱动因素

- Worker 崩溃、进程重启和 fence 竞争后仍能确定性恢复完整 Pi Session。
- 所有持久化查询直接携带 `org_id + user_id + agent_session_id`，不能仅依赖父表 join 推导租户。
- 在线追加必须是有界写入，不能随会话总长度线性放大。
- JSONL 数字、父子关系、custom/compaction/branch entry 必须无损重放。
- 大文件和 Workspace 字节不能迁移到 Agent 或 BFF 权威边界。
- SDK 升级、schema 演进、冷归档和删除策略必须可以独立审计。

## 决策

### 1. JSONL 是适配器格式，不是在线事实源

正式环境不得以每 Session 一个可变 `.jsonl` 文件、共享文件系统 append 或对象存储对象
覆盖作为在线权威写入路径。

在线权威仍为 Agent MySQL 中的逻辑 Message、Run Event、ToolExecution、Approval 和其他既有
账本。JSONL 文件只允许用于：

1. Worker 进程私有临时物化，以调用 Pi SDK；
2. 管理员显式导出；
3. 将来由独立 retention 决策定义的冷归档。

临时 JSONL 必须使用安全创建的进程私有目录、原子 rename、`0600` 权限，并在 runtime
dispose 时删除。它不得放入 Sandbox Workspace、Session 私有 `/tmp` 或 BFF 可下载路径。

### 2. 将 Pi 原生行拆到 Message 的 1:1 物理扩展表

目标 schema 新增 `pi_session_journal_entries`。它是 `messages` 逻辑记录的 1:1 物理扩展，
不是第二套领域账本：写入 Message 与扩展行必须位于同一事务，扩展行必须通过
`message_id` 引用对应的 `messages` 行；不允许孤立写入。

建议的最小字段为：

```sql
CREATE TABLE pi_session_journal_entries (
  message_id CHAR(26) PRIMARY KEY,
  org_id CHAR(26) NOT NULL,
  user_id CHAR(26) NOT NULL,
  agent_session_id CHAR(26) NOT NULL,
  journal_sequence BIGINT NOT NULL,
  pi_entry_id VARCHAR(128) NOT NULL,
  entry_type VARCHAR(32) NOT NULL,
  parent_entry_id VARCHAR(128),
  codec_version SMALLINT NOT NULL,
  entry_bytes LONGBLOB NOT NULL,
  entry_sha256 BINARY(32) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_pi_journal_message
    FOREIGN KEY (message_id) REFERENCES messages(message_id),
  UNIQUE KEY uk_pi_journal_sequence
    (org_id, agent_session_id, journal_sequence),
  UNIQUE KEY uk_pi_journal_entry
    (org_id, agent_session_id, pi_entry_id),
  INDEX idx_pi_journal_tail
    (org_id, user_id, agent_session_id, journal_sequence)
);
```

具体迁移必须使用仓库的 Knex schema 命名和既有 `CHAR(26)`/外键约定；上面的 SQL 是决策
形状，不是可直接执行的 migration。

`entry_bytes` 保存 codec 生成的确定性 UTF-8 JSON 单行，不通过 MySQL JSON 类型往返。
`entry_sha256` 对这些精确字节计算。业务查询需要的稳定字段单独建列；不得通过解析 blob
完成租户、顺序或幂等判断。

这里使用 `LONGBLOB` 是因为当前多图准入的原始字节总量经 Base64 后可能超过
`MEDIUMBLOB` 的 16 MiB 上限；它不代表允许接近数据库列极限的 entry。应用层统一预算必须
在分配完整 buffer 和写库前拒绝超限内容，部署也必须配置请求体、MySQL packet 和 Worker
内存的相容上限。

`journal_sequence` 是 Agent Session 内连续的 Pi journal 序号，不复用可能穿插 UI Message 的
Conversation `messages.sequence_no`。Header 以保留的 `entry_type = 'session_header'` 和
`journal_sequence = 0` 表示；一个 Session 只能有一个 header。所有后续 entry 严格单调追加，
普通运行路径禁止 update/delete。

Journal 行不保存无法可靠回填的“历史 fence token”。fence 的权威仍是 checkpoint 事务中的
`agent_sessions.execution_fence_token` 校验；snapshot 继续记录实际提交时捕获的 token。不得为
旧 journal 行填入猜测值或把 `0` 解释为已经通过 fence 验证。

### 3. Snapshot 改为阈值触发的 checkpoint，而不是每 Run 完整复制

`agent_session_snapshots` 继续作为加速层，并保留 append-only 与 fence 保护。目标 snapshot
至少记录：

- `through_journal_sequence`：已覆盖的 journal 高水位；
- `snapshot_bytes` 或现有 `snapshot_json` 的版本化等价物；
- `snapshot_sha256`、`journal_chain_digest`、未压缩字节数；
- `snapshot_format`、Pi JSONL version、精确 `pi_sdk_version`；
- `org_id`、`user_id`、`captured_fence_token`。

正常恢复算法为：

```text
最新可用的 pointed snapshot
  + SELECT journal
      WHERE journal_sequence > through_journal_sequence
      ORDER BY journal_sequence
  + 校验 tail 的连续性与 chain digest
  → 临时完整 JSONL
  → SessionManager.open(...)
```

正常热路径不得为了证明 snapshot 可用而再次读取全部历史。只有 snapshot 缺失、版本不兼容、
tail 不连续或 digest 不一致时，才从完整 Message journal 重建，并按既有规则进入或清除
`RECOVERY_REQUIRED`。

Snapshot 由“距上次 snapshot 的 entry 数、字节数或时间”阈值触发，不再规定每个 Run 必须
生成。初始阈值必须由真实会话分布和恢复压测确定；在有数据前，本 ADR 不冻结一个看似精确
但未经验证的数字。

本 ADR 不授权删除既有 append-only snapshot。snapshot retention、legal hold 和受控清理需要
单独决策；在此之前，通过降低生成频率停止每 Run 全量复制的主要写放大。

### 4. 容量限制在写入前统一判定

`PI_MAX_JSONL_BYTES` 是防止 Worker 内存和磁盘滥用的运行时护栏，不是会话保留策略。
Message、图片、工具结果和 compaction 产生的 Pi entry 必须使用同一个 materialized-size
预算器，在调用模型或提交 checkpoint 前完成准入；不得先接受输入，再在恢复或 checkpoint
阶段因 8 MiB 上限失败。

Pi compaction 缩短模型上下文，但不会自动删除 append-only JSONL 历史，因此不能把 compaction
误当成持久化容量回收。达到上限时必须在模型调用前 fail closed，并返回可识别的容量原因；
不得截断旧 entry 或静默新建空 Session。自动 Session rollover 涉及 Workspace 继承、Agent
Version、待审批事项和幂等记录迁移，不在本 ADR 内擅自决定；实现前需单独设计并验证。

在 Pi entry 格式原生支持稳定引用时，大 payload 只记录不可变引用、摘要、MIME 和大小；
若 SDK 要求内联字节，则 journal 必须保存可无损重放的内容，并由统一预算限制。不得为了缩小
journal，把 Sandbox Workspace 字节复制成 Agent 自有但无生命周期约束的隐藏对象。

任何新增对象存储拓扑都必须另写 ADR，明确：

- Sandbox/Artifact 与对象存储各自拥有哪些字节权威；
- tenant-scoped object key、加密、保留、legal hold 和孤儿清理；
- 删除时先删 backing object、成功后再删 metadata 的顺序；
- 对象不可用时恢复是 fail-closed 还是降级。

### 5. 一致性、租户与错误语义不变

- journal append、Session 版本推进、snapshot pointer、`last_run_id`、Run Event 与 Outbox 继续
  在一个 MySQL 事务内完成，并在写 snapshot 前再次校验 execution fence。
- 所有 repository 读写必须显式接收 `org_id + user_id` scope；即使 `message_id`、
  `agent_session_id` 或 `pi_entry_id` 全局唯一，也不能省略 scope predicate。
- 公共 API 跨租户仍返回 404；内部 repository 的 scope miss 不暴露目标是否存在。
- checksum、codec、SDK version 或顺序不一致必须 fail closed，不能静默丢 entry、只拼文本历史
  或回退到新建空 Session。
- Run、ToolExecution、Approval、Process 和 Workspace 事实不得塞进 Pi JSONL 取代现有账本。

### 6. 冷归档与导出不属于在线提交事务

将来如果增加 Session 导出，首选流式 `JSONL.GZ + manifest`。Manifest 至少包含
`schema_version`、scope、Session ID、sequence 范围、entry 数、未压缩字节数、SHA-256、
SDK/codec version 和 object key。归档对象只在 manifest 完整发布后才算可恢复。

分析型长期归档可以评估 Parquet；要求 Pi 精确重放的归档必须保留确定性 JSONL 字节。两者都
不能替代在线 MySQL journal，实施前需另行决定 retention、恢复 SLA 和对象存储拓扑。

## 迁移策略

本 ADR 被接受后仍必须按以下顺序实施，不允许一次 migration 直接切换权威读路径：

1. **复现与基线**：增加能证明当前每 Run 全量 snapshot 写放大、全 journal 热路径读取、
   MySQL JSON 数字往返和容量冲突的失败测试/benchmark；记录真实行大小与恢复延迟分布。
2. **扩展 schema**：新增扩展表和租户/顺序约束，不改变现有读取。
3. **事务双写**：同一 Message 事务写旧 journal 列与新 `entry_bytes`；按精确字节 checksum
   对比，任一侧失败则整体回滚。
4. **历史回填**：按 `org_id + agent_session_id + messages.sequence_no` 游标批量读取，并按每个
   Session 的既有 append 顺序生成连续 `journal_sequence`；每批有界、可重入、可审计，
   不锁住完整消息表。
5. **影子恢复**：生产读仍走旧路径，同时从新表重建并比较 checksum、entry 数和 parent 链；
   不一致进入告警，不自动覆盖。
6. **切换读取**：只有影子指标达到约定窗口且 crash/restart matrix 通过后，才切换到
   snapshot + tail。
7. **停止旧写**：另一个可回滚步骤停止旧 Pi payload 写入 `messages` 的宽 JSON 列；保留逻辑
   Message 行。删除旧生产列或代码必须重建容器并跑完整真实链路。

每一步都必须保持新版本可读取旧数据；部署期间禁止要求所有 Worker 同时升级才能避免损坏。

## 备选方案

| 方案 | 结论 | 原因 |
|------|------|------|
| 每 Session 一个持久 `.jsonl` 文件 | 拒绝 | 多副本 append/锁/原子提交困难；租户、备份、查询和 fence 无法与 MySQL 事务统一 |
| 每个 Run 保存一份完整 JSON snapshot | 拒绝 | 简单但产生累计近似二次写放大，恢复仍需处理 journal 分歧 |
| Conversation 一行保存全部历史 JSON | 拒绝 | 直接违反 `plan.md` §2.5/§8.7；并发更新、索引、TTL 和局部恢复都更差 |
| 对象存储作为在线 append journal | 拒绝 | 缺少与 MySQL Run/Outbox 的原子事务，覆盖和可见性语义复杂 |
| 继续只用 `messages.content_json` | 过渡期保留 | 改动最小，但宽行干扰 UI 查询，且不能保留 JSONL 精确字节 |
| Message + 1:1 Pi 扩展行 | 采用 | 保留冻结的逻辑事实源，同时隔离 Pi 原生字节和专用索引 |

## 影响

### 正面

- 普通 journal append 成本与新增 entry 大小相关，而不与完整会话长度相关；阈值触发的完整
  snapshot 仍与会话长度相关。
- Snapshot 能真正缩短正常恢复读取路径。
- 精确字节摘要消除 MySQL JSON 数字表示对 checksum 的影响。
- 直接 tenant scope 与复合唯一键降低错误 join 或 ID 猜测导致的跨租户风险。
- Pi 原生 journal 不再拖累普通 Conversation/Message 投影查询。
- SDK 适配、在线账本和未来冷归档的职责边界清晰。

### 负面与风险

- 同一个逻辑 Message 跨两张表，事务、回填和删除策略更复杂。
- 迁移期间存在受控双写；若缺少 shadow checksum 和指标，可能形成隐藏分歧。
- Snapshot 降频会增加最坏情况下需要读取的 tail，阈值必须通过压测平衡。
- 精确 `entry_bytes` 不可直接用 SQL 查询内部字段，需要为稳定查询维度显式建列。
- 在单独 retention 决策落地前，append-only snapshot 仍会持续增长，且固定阈值只能降低
  完整复制频率，不能从渐进复杂度上消除累计写放大。
- SDK JSONL schema 变化仍需要 codec version 和兼容迁移，不能靠 blob 自动解决。

## 验证要求

接受并实施本 ADR 的 PR 至少覆盖：

1. codec exact-byte round trip，包括小数、Unicode、branch/custom/compaction 与 parent 链；
2. `(org_id, user_id, agent_session_id)` scope miss、跨租户 404 和复合唯一键冲突；
3. fence 过期、并发 Worker、事务回滚和 Outbox 原子性；
4. snapshot + tail、snapshot 损坏全量重建、SDK/codec version 不兼容；
5. 输入准入预算与最终 materialized JSONL 字节数一致；
6. 双写、回填可重入、影子 checksum 和混合版本部署；
7. 当前四套测试；
8. 重建 `agent`、`api-server`、`sandbox` 镜像后的真实链路：登录 → 建会话 → 带工具 Run →
   Worker 重启恢复 → process logs/signal → 跨租户 404。

需要新增至少这些指标：journal append bytes/latency、Session 总 entry/bytes、snapshot
bytes/frequency、recovery snapshot/tail/full-rebuild 次数与延迟、checksum mismatch、shadow mismatch
和准入拒绝原因。指标标签不得包含用户内容、文件名、prompt 或原始 entry。

## 外部实现参考

以下只是固定 commit 的设计证据，不是本仓库现状或规范来源：

- Dify 把 Conversation/Message 作为关系型在线记录，并把文件元数据与 storage key 分离：
  [Message model](https://github.com/langgenius/dify/blob/c8e29d9a7d43/api/models/model.py#L1545-L1602)、
  [UploadFile model](https://github.com/langgenius/dify/blob/c8e29d9a7d43/api/models/model.py#L2409-L2460)。
- Dify 的消息 JSONL.GZ 是流式导出格式，不是在线会话表：
  [message export](https://github.com/langgenius/dify/blob/c8e29d9a7d43/api/services/retention/conversation/message_export_service.py#L172-L188)。
- LibreChat 的 Conversation、Message、File 使用 tenant/user 复合索引和 TTL；其 `tenantId`
  仍可选，因此本 ADR 不照搬其 nullable 语义：
  [message schema](https://github.com/danny-avila/LibreChat/blob/6d499ba3ce17/packages/data-schemas/src/schema/message.ts#L266-L324)、
  [file retention](https://github.com/danny-avila/LibreChat/blob/6d499ba3ce17/packages/data-schemas/src/schema/file.ts#L139-L165)。
- Open WebUI 从整段 chat JSON 回填逐消息表，并在迁移期保留 fallback，说明大 JSON 向规范化
  消息迁移需要显式一致性策略：
  [migration](https://github.com/open-webui/open-webui/blob/d3e8bf3405e8/backend/open_webui/migrations/versions/8452d01d26d7_add_chat_message_table.py#L63-L112)、
  [normalized read path](https://github.com/open-webui/open-webui/blob/d3e8bf3405e8/backend/open_webui/models/chats.py#L1003-L1055)。
- Khoj 每次追加都重写完整 `conversation_log`，是本 ADR 明确不采用的整会话 JSON 方案：
  [save path](https://github.com/khoj-ai/khoj/blob/ae229ca894c0/src/khoj/database/adapters/__init__.py#L1575-L1600)。

## 仓库实现参考

- `agent/src/application/session-recovery-service.js`
- `agent/src/infrastructure/pi/pi-jsonl-codec.js`
- `agent/src/infrastructure/pi/pi-session-adapter.js`
- `agent/src/infrastructure/mysql/repositories/pi-session-journal-repository.js`
- `agent/src/infrastructure/mysql/repositories/agent-session-snapshot-repository.js`
- `agent/src/infrastructure/mysql/migrations/20260718000006_agent_session_snapshot_fencing.js`
- `agent/src/infrastructure/mysql/migrations/20260718000007_pi_session_journal.js`
- `agent/tests/pi/`
