/**
 * 邮件通知场景扩展（docs/design/notification-scenarios.md §3.1）。
 *
 * - `tbl_agsvc_notification_deliveries.dedupe_key`：一个 outbox 行可对应多个收件人
 *   （待我审核给每位审核员各一封），`UNIQUE(run_id, kind)` 装不下了。改为
 *   `UNIQUE(dedupe_key)`，规则见设计稿 §3.1（`run_terminal:<runId>` 等既有语义不变，
 *   所以回填就是 `CONCAT(kind, ':', run_id)`）。旧唯一索引 `ind_agsvc_nd_a1`
 *   同时承接着 `run_id` 外键：**先**给 `run_id` 建普通索引（`ind_agsvc_nd_i2`），
 *   **再**删旧索引，否则 MySQL 拒绝删除承接外键的索引。
 * - `tbl_agsvc_users`：`notify_review_result`（回填为当时的 `notify_run_complete`，
 *   保持现有行为）、`notify_review_pending`、`notify_run_waiting`，新用户默认全开。
 * - `tbl_agsvc_cron_jobs.notify_policy`：`never` / `failure`（默认）/ `always`。
 *
 * 回填都写成纯 SQL（`UPDATE` / `INSERT … SELECT`），不先 SELECT 再逐行写：schema
 * 发布包只抓取写语句（`schema-export.ts` 的 `KEEP`），读语句会被丢掉（见
 * `20261001000001_member_roles.js` 的注释）。加列用 `hasColumn` 幂等。
 * 索引缩写 `nd` 沿用旧迁移（`ind_agsvc_nd_a2/i2` 全库唯一）。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async () => {
  // 1. 投递账加 dedupe_key：先可空，加上来再回填、再收紧，避免存量行直接 NOT NULL 失败。
  if (!(await knex.schema.hasColumn('tbl_agsvc_notification_deliveries', 'dedupe_key'))) {
    await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
      t.string('dedupe_key', 191).nullable();
    });
  }
  await knex.raw(
    "UPDATE `tbl_agsvc_notification_deliveries` SET `dedupe_key` = CONCAT(`kind`, ':', `run_id`) WHERE `dedupe_key` IS NULL",
  );
  await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
    t.string('dedupe_key', 191).notNullable().alter();
  });

  // 2. 先给 run_id 建普通索引（外键的新承接），再加新唯一键，最后删旧唯一键。
  await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
    t.index(['run_id'], 'ind_agsvc_nd_i2');
  });
  await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
    t.unique(['dedupe_key'], { indexName: 'ind_agsvc_nd_a2' });
  });
  await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
    t.dropUnique(['run_id', 'kind'], 'ind_agsvc_nd_a1');
  });

  // 3. 用户偏好三列。审核结果沿用旧开关的值回填（D5），另外两个默认开。
  if (!(await knex.schema.hasColumn('tbl_agsvc_users', 'notify_review_result'))) {
    await knex.schema.alterTable('tbl_agsvc_users', (t) => {
      t.boolean('notify_review_result').notNullable().defaultTo(true);
    });
  }
  await knex.raw(
    'UPDATE `tbl_agsvc_users` SET `notify_review_result` = `notify_run_complete`',
  );
  if (!(await knex.schema.hasColumn('tbl_agsvc_users', 'notify_review_pending'))) {
    await knex.schema.alterTable('tbl_agsvc_users', (t) => {
      t.boolean('notify_review_pending').notNullable().defaultTo(true);
    });
  }
  if (!(await knex.schema.hasColumn('tbl_agsvc_users', 'notify_run_waiting'))) {
    await knex.schema.alterTable('tbl_agsvc_users', (t) => {
      t.boolean('notify_run_waiting').notNullable().defaultTo(true);
    });
  }

  // 4. 定时任务的完成通知策略。
  if (!(await knex.schema.hasColumn('tbl_agsvc_cron_jobs', 'notify_policy'))) {
    await knex.schema.alterTable('tbl_agsvc_cron_jobs', (t) => {
      t.specificType('notify_policy', 'CHAR(16)').notNullable().defaultTo('failure');
    });
  }
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // 逆序回滚：先恢复旧唯一键（它重新承接 run_id 外键），再拆新键。
  await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
    t.unique(['run_id', 'kind'], { indexName: 'ind_agsvc_nd_a1' });
  });
  await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
    t.dropUnique(['dedupe_key'], 'ind_agsvc_nd_a2');
  });
  await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
    t.dropIndex(['run_id'], 'ind_agsvc_nd_i2');
  });
  if (await knex.schema.hasColumn('tbl_agsvc_notification_deliveries', 'dedupe_key')) {
    await knex.schema.alterTable('tbl_agsvc_notification_deliveries', (t) => {
      t.dropColumn('dedupe_key');
    });
  }

  for (const column of ['notify_review_result', 'notify_review_pending', 'notify_run_waiting']) {
    if (await knex.schema.hasColumn('tbl_agsvc_users', column)) {
      await knex.schema.alterTable('tbl_agsvc_users', (t) => {
        t.dropColumn(column);
      });
    }
  }

  if (await knex.schema.hasColumn('tbl_agsvc_cron_jobs', 'notify_policy')) {
    await knex.schema.alterTable('tbl_agsvc_cron_jobs', (t) => {
      t.dropColumn('notify_policy');
    });
  }
}
