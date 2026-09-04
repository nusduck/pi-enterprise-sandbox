/**
 * Durable exec artifact / dataset ledgers.
 *
 * `exec/` owns these facts and is the only runtime writer; Agent owns schema
 * migration for the shared MySQL instance, so the tables are created here —
 * same split as `20260901000001_exec_jobs.js`.
 *
 * 这两张表的 DDL 常量早就写在 `exec/src/db/repositories/{artifacts,datasets}.ts`
 * 里，但一直没有配套迁移，于是 `createExecAppFromEnv` 只能落回内存实现——
 * 容器一重启，产物列表与下载就整片消失。`tests/test_exec_schema_migrations.py`
 * 现在会挡住"定义了表却没有迁移"这条路。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const EXEC_ARTIFACTS_TABLE = 'exec_artifacts';
export const EXEC_DATASETS_TABLE = 'exec_datasets';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(EXEC_ARTIFACTS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.string('artifact_id', 64).notNullable();
      t.string('session_id', 191).notNullable();
      t.string('workspace_id', 191).notNullable();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      t.string('name', 1024).notNullable();
      t.string('source_path', 4096).notNullable();
      t.string('mime_type', 255).notNullable().defaultTo('application/octet-stream');
      t.specificType('sha256', 'CHAR(64)').notNullable();
      t.specificType('size_bytes', 'BIGINT UNSIGNED').notNullable();
      t.json('identity').nullable();
      // 写入方（`MySqlArtifactStore.insert`）不带 created_at，靠列默认值。
      t.specificType('created_at', 'DATETIME(3)')
        .notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));

      t.primary(['artifact_id'], 'pk_exec_artifacts');
      t.index(['session_id'], 'idx_exec_artifacts_session');
      t.index(['workspace_id'], 'idx_exec_artifacts_workspace');
      t.index(['org_id', 'user_id'], 'idx_exec_artifacts_owner');
    });

    await tracker.createTable(EXEC_DATASETS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.string('dataset_id', 64).notNullable();
      t.string('session_id', 191).notNullable();
      t.string('conversation_id', 191).notNullable();
      t.string('workspace_id', 191).notNullable();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      t.string('original_filename', 1024).notNullable();
      t.string('stored_relative_path', 4096).notNullable();
      t.string('mime_type', 255).notNullable().defaultTo('application/octet-stream');
      t.specificType('sha256', 'CHAR(64)').nullable();
      t.specificType('size_bytes', 'BIGINT UNSIGNED').notNullable().defaultTo(0);
      t.string('status', 16).notNullable().defaultTo('uploading');
      t.string('idempotency_key', 255).nullable();
      t.specificType('created_at', 'DATETIME(3)')
        .notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
      t.specificType('completed_at', 'DATETIME(3)').nullable();

      t.primary(['dataset_id'], 'pk_exec_datasets');
      // 幂等键唯一 —— 只在调用方给了 key 时生效（MySQL 的 UNIQUE 允许多行 NULL），
      // 这正是"没给幂等键就每次都是新上传"的语义。
      t.unique(
        ['org_id', 'user_id', 'session_id', 'idempotency_key'],
        { indexName: 'uniq_exec_datasets_idem' },
      );
      t.index(['session_id'], 'idx_exec_datasets_session');
      t.index(['workspace_id'], 'idx_exec_datasets_workspace');
      t.index(['org_id', 'user_id'], 'idx_exec_datasets_owner');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(EXEC_DATASETS_TABLE);
  await knex.schema.dropTableIfExists(EXEC_ARTIFACTS_TABLE);
}
