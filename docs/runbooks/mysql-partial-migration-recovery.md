# MySQL partial migration recovery

## Symptom

Agent container / migrate fails with one of:

1. Illegal SQL on composite primary:
   `constraint … as indexName primary key` — Knex MySQL `t.primary(cols, { indexName })` bug (fixed: use string constraint name).
2. Retry after a failed migrate:
   `Table 'organizations' already exists` (or another core table) while `knex_migrations` has **no** matching migration row.
3. Explicit gate:
   `Orphan MySQL schema detected (fail closed)` from `assertNoOrphanPartialSchema`.
4. Trigger / binary log gate (before DDL when migrations are pending):
   `MYSQL_TRIGGER_BINLOG_BLOCKED` / `log_bin_trust_function_creators` — see
   [Triggers and binary logging](#triggers-and-binary-logging).
5. Mid-migration raw MySQL error on `CREATE TRIGGER` (legacy builds without preflight):
   `You do not have the SUPER privilege and binary logging is enabled` /
   `log_bin_trust_function_creators`.

MySQL DDL is **not** transactional. Knex only inserts into `knex_migrations` after a successful `up`. A mid-migration failure can leave a **partial schema** that blocks every restart.

## Fail-closed policy

- Do **not** auto-`DROP` arbitrary existing tables in production.
- In-process recovery (current code) only drops objects **created during the failed `up` attempt** (this-run tracker), then rethrows.
- Residual state from older builds (before this-run cleanup) or from failed cleanup must be repaired by an operator using this runbook.

## Classify the schema

```sql
SELECT DATABASE();
SELECT name FROM knex_migrations ORDER BY id;
SHOW TABLES;
```

| State | Meaning | Action |
| --- | --- | --- |
| Empty DB, no app tables | Healthy empty | `migrate:latest` |
| Full schema + migration rows present | Healthy | no recovery |
| Some/all app tables exist, **missing** `20260718000001_core_platform_schema.js` (or later create migration) in `knex_migrations` | **Orphan / half-migration** | recover below |
| Migration row present, app tables missing | Manual corruption | restore from backup or rebuild empty |

## A) Empty / development schema (no production data)

Only when you are certain the schema holds **no** production tenant data (fresh Compose volume, throwaway lab schema, CI database).

### Option A1 — drop schema and recreate (preferred for lab)

```sql
-- Connect as admin; replace names with your env.
DROP DATABASE IF EXISTS agent_dev;
CREATE DATABASE agent_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Then restart Agent with `migrate:latest` / container migrate-on-start.

### Option A2 — FK-safe drop of known app tables only

Use only the platform table list (core + known additive create migrations). Do not guess unrelated customer tables in a shared MySQL instance.

```sql
SET FOREIGN_KEY_CHECKS = 0;

-- A2A (migration 00009), if present
DROP TABLE IF EXISTS a2a_audit_events;
DROP TABLE IF EXISTS a2a_tasks;
DROP TABLE IF EXISTS a2a_api_credentials;

-- External refs (migration 00003)
DROP TABLE IF EXISTS conversation_external_refs;
DROP TABLE IF EXISTS organization_external_refs;

-- Core drop order (children → parents); triggers go with tables
DROP TABLE IF EXISTS idempotency_records;
DROP TABLE IF EXISTS domain_outbox;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS artifacts;
DROP TABLE IF EXISTS datasets;
DROP TABLE IF EXISTS sandbox_audit_events;
DROP TABLE IF EXISTS sandbox_executions;
DROP TABLE IF EXISTS process_executions;
DROP TABLE IF EXISTS sandbox_sessions;
DROP TABLE IF EXISTS tool_executions;
DROP TABLE IF EXISTS run_events;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS agent_session_snapshots;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS conversations;
DROP TABLE IF EXISTS agent_versions;
DROP TABLE IF EXISTS agent_definitions;
DROP TABLE IF EXISTS organization_memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS organizations;

-- Optional: clear knex bookkeeping if present without a complete batch
DROP TABLE IF EXISTS knex_migrations;
DROP TABLE IF EXISTS knex_migrations_lock;

SET FOREIGN_KEY_CHECKS = 1;
```

Also drop leftover triggers if tables were removed without cascade:

```sql
DROP TRIGGER IF EXISTS trg_messages_forbid_update;
DROP TRIGGER IF EXISTS trg_messages_forbid_delete;
DROP TRIGGER IF EXISTS trg_agent_session_snapshots_forbid_update;
DROP TRIGGER IF EXISTS trg_agent_session_snapshots_forbid_delete;
```

Then run:

```bash
cd agent && npm run migrate:latest
# or restart the Agent container with migrate-on-start
```

## B) Production or shared schema with unknown data

1. **Stop** writers (Agent HTTP + workers).
2. **Backup** the schema (`mysqldump` / managed snapshot).
3. **Do not** run Option A blindly.
4. Inventory:
   - Which tables exist vs `CORE_TABLES_CREATE_ORDER` / A2A / external_refs.
   - Whether any table has rows (`SELECT COUNT(*)`).
5. If **any** production rows exist in a partial graph: treat as incident — restore from last good backup or complete schema surgically with DBA review. Never invent a full auto-drop.
6. If counts are **zero** on all orphan tables and the migration was never recorded, Option A2 may be used under change control.

## Triggers and binary logging

Agent schema migrations create **append-only triggers** (`CREATE TRIGGER`) as the
**application** MySQL user (`MYSQL_USER` / DSN user). That account must **not**
be granted `SUPER` / `SYSTEM_VARIABLES_ADMIN`.

On MySQL 8.0 with **binary logging enabled** (common default), non-SUPER
`CREATE TRIGGER` requires:

```text
@@GLOBAL.log_bin_trust_function_creators = 1
```

### Compose-managed MySQL (this repo)

`docker-compose.yml` and `docker-compose.prod.yml` pass:

```text
--log-bin-trust-function-creators=1
```

to the `mysql` service. Recreate the MySQL container after pull so mysqld
picks up the flag (data volume can be kept).

```bash
docker compose up -d mysql
# or prod overlay:
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d mysql
```

Verify:

```sql
SELECT @@GLOBAL.log_bin, @@GLOBAL.log_bin_trust_function_creators;
-- expect trust_function_creators = 1 when log_bin = 1
```

### External / managed MySQL

The Agent process **will not** `SET GLOBAL` or rewrite remote configuration.
A DBA (or cloud parameter group) must enable the equivalent of
`log_bin_trust_function_creators=1` **before** first migrate / Agent start with
pending migrations.

Until that is done, `migrateLatest` fail-closes with `MYSQL_TRIGGER_BINLOG_BLOCKED`
so tables are not created only to die on `CREATE TRIGGER`.

### After a legacy half-migration (tables created, trigger failed)

Use sections A/B above to clear orphan tables if the migration was never recorded,
then fix instance flags, then re-run migrate.

## C) Prevention (current code)

1. Composite `primary` uses a **string** constraint name, never `{ indexName }` / options objects (illegal `as indexName` SQL on create).
2. createTable migrations wrap `up` in `withPartialDdlCleanup`: on failure, drop only this-run tables/triggers, rethrow.
3. `migrateLatest` calls `assertNoOrphanPartialSchema` before applying — residual orphans fail closed with a pointer to this runbook.
4. When pending migrations exist, `assertMysqlTriggerMigrationCapability` fail-closes if `log_bin=1` and `log_bin_trust_function_creators=0` (no SUPER grant, no remote SET GLOBAL).

## Verify after recovery

```bash
cd agent && npm run migrate:status
# expect core + later migrations listed as applied
```

Smoke: Agent starts, `SELECT 1`, health checks pass, create a throwaway org/conversation in non-prod.
