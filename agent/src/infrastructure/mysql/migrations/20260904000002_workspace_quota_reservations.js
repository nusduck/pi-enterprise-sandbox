/**
 * Durable workspace quota reservations.
 *
 * `exec/` owns these facts and is the only runtime writer; Agent owns schema
 * migration for the shared MySQL instance — same split as the two migrations
 * before this one.
 *
 * 为什么预留记录必须在**工作区外面**（`quota-store.ts` 头注释原话）：子进程能
 * 删掉工作区内的文件，账本放里面就能被篡改来超卖配额。DB 天然满足"在外面"，
 * 而且不需要 `fcntl.flock`。这张表以前只有 DDL 常量、没有迁移，于是
 * `ArtifactService` / `DatasetService` 各自默认装配一个 `InMemoryQuotaStore`：
 * 既重启即忘（配额计数归零 = 多放行），又**互相看不见**（同一个工作区的产物与
 * 数据集各算各的，1024MB 的额度实际能被用掉两份）。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const WORKSPACE_QUOTA_RESERVATIONS_TABLE = 'workspace_quota_reservations';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(WORKSPACE_QUOTA_RESERVATIONS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.string('workspace_id', 191).notNullable();
      t.string('reservation_id', 191).notNullable();
      t.specificType('bytes', 'BIGINT UNSIGNED').notNullable();
      t.specificType('created_at', 'DATETIME(3)')
        .notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));
      t.specificType('updated_at', 'DATETIME(3)')
        .notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)'));

      // `PRIMARY KEY (workspace_id, reservation_id)` 已经是 `WHERE workspace_id = ?`
      // 的最左前缀，`sumReserved()` 不需要额外索引。
      t.primary(['workspace_id', 'reservation_id'], 'pk_workspace_quota_reservations');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(WORKSPACE_QUOTA_RESERVATIONS_TABLE);
}
