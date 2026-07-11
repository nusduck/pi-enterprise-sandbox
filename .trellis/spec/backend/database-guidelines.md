# 数据库规范

## 当前实现

- `sandbox/database.py` 自带 schema 和 backend 抽象，支持 `sqlite:///...` 与 `postgresql://...` / `postgres://...`。
- SQLite 使用标准库 `sqlite3`、`row_factory = sqlite3.Row`、`PRAGMA foreign_keys = ON`，初始化时启用 WAL。
- PostgreSQL 使用 `psycopg2` 和 `RealDictCursor`；`_ConnectionWrapper` 统一 `?` 参数占位、script 执行和 row 访问差异。
- `sandbox/repositories.py` 是实体持久化入口；当前包括 Session、Execution、Artifact、Conversation、Audit、Approval、User 等 Repository。
- API 与 service 都是同步数据库访问；不要把活跃文档中“aiosqlite”的旧说法当成当前事实。

## Schema 与命名

- 表名使用复数 `snake_case`：`sessions`、`executions`、`audit_logs`、`conversations`、`approvals`、`users`。
- 主键字段通常为业务前缀 ID：`session_id`、`execution_id`、`artifact_id`、`approval_id`；conversation/user 使用 `id`。
- 时间当前存 ISO 8601 文本，应用层以 `datetime.now(timezone.utc).isoformat()` 生成。
- 结构化附加数据当前序列化为 JSON 文本，如 session `metadata`、conversation `messages`、audit `payload`。
- 查询所需字段在 schema 中显式建索引；实例见 `idx_executions_trace_id`、`idx_approvals_status`、`idx_users_username`。

## 查询与事务模式

沿用 Repository 中的短连接上下文和显式提交：

```python
with self.db.connect() as conn:
    row = conn.execute(
        "SELECT * FROM sessions WHERE session_id = ?",
        (session_id,),
    ).fetchone()
```

写入后显式 `conn.commit()`；使用参数绑定，不拼接用户输入。唯一现有动态字段查询 `SessionRepository._get_by` 会先用白名单限制列名。

Upsert 采用 `INSERT ... ON CONFLICT ... DO UPDATE`。跨方言兼容由 `DatabaseBackend` / `_ConnectionWrapper` 负责；新增 SQL 必须同时检查：

- SQLite `?` 占位与 PostgreSQL `%s` 转换。
- Boolean 值 `cast_bool` / `parse_bool`。
- 两份 schema 的字段、默认值和索引一致性。
- SQLite `AUTOINCREMENT` 与 PostgreSQL `SERIAL` 等方言差异。

## 初始化与 schema 变更

- `Database.initialize()` 只应用不可变的空库 migration；`schema_migrations` 保存 version、SHA-256 checksum 和 applied_at。
- PostgreSQL 是生产强制后端；SQLite 仅用于空库开发/测试，不支持历史 schema 自动 ALTER、数据回填或升级承诺。
- Migration 在调用方事务内逐条执行；失败回滚 schema 与版本记录，已应用版本 checksum 不一致时 fail-closed。
- 修改 schema 时，新增 migration 并同步 SQLite/PostgreSQL SQL、Repository 映射、Pydantic model 和持久化测试；不得修改已发布 migration。
- 研发阶段全量切换不使用 backup/restore；受限 reset 流程见 `docs/runbooks/development-reset.md`。

## 实例

- 通用 CRUD/row 映射：`sandbox/repositories.py::SessionRepository`、`ConversationRepository`。
- 方言兼容：`sandbox/database.py::SQLiteBackend`、`PostgreSQLBackend`、`_ConnectionWrapper`。
- 持久化回归：`tests/test_persistence.py`、`tests/test_multi_turn_history.py`、`tests/test_auth_foundation.py`。

## 常见风险

- 不在 Router 或前端直接访问数据库。
- 不把 JSON 字符串当作已经验证的 Pydantic object；通过 Repository helper 统一 dump/load。
- 不遗漏 commit；当前连接 wrapper 不自动提交写事务。
- 生产 overlay 必须提供 PostgreSQL 密码，Sandbox 等待数据库 healthy 后启动；不得回退 SQLite。
- 当前 v1 是研发阶段空库基线，不提供降级或旧数据回填。
