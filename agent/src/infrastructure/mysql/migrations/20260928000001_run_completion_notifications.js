/**
 * 长任务完成邮件通知（docs/design/run-completion-email.md 阶段 1）。
 *
 * - `tbl_agsvc_users.notify_run_complete`：用户自己在账户页打开的开关，默认关。
 *   收件人只来自同一行的 `email`，模型不参与。
 * - `tbl_agsvc_notification_deliveries`：每个 Run 每种通知一行的投递账。
 *   outbox 是至少一次投递——SMTP 已发出但确认前崩溃会重新认领，
 *   `UNIQUE(run_id, kind)` 让重认领先看到「已发送」而不再发第二封。
 *   只记收件地址的 sha256，不落明文邮箱与邮件正文。
 *
 * 命名按 UPspec（ADR 0013）：本迁移在改名之后，直接用物理表名；索引缩写 `nd`。
 * 不给 org_id / user_id 建外键：knex 会为不在索引首列的外键自动建一个不合规名字的索引。
 * run_id 外键由唯一索引 `ind_agsvc_nd_a1` 的首列承接。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const NOTIFICATION_DELIVERIES_TABLE = 'tbl_agsvc_notification_deliveries';

const ID_TYPE = 'CHAR(26)';
const EPOCH = '1970-01-01 00:00:00.000';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(NOTIFICATION_DELIVERIES_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('delivery_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('user_id', ID_TYPE).notNullable();
      t.specificType('run_id', ID_TYPE).notNullable();
      // run_terminal（本期唯一一种）；留列是为了以后的审批提醒等不必改表。
      t.string('kind', 32).notNullable().defaultTo('');
      // sending | sent | skipped | failed
      t.string('status', 32).notNullable().defaultTo('');
      // 投递时解析出的地址摘要；没有邮箱（skipped）时为空。
      t.specificType('recipient_hash', 'CHAR(64)').nullable();
      t.integer('attempts').notNullable().defaultTo(0);
      t.string('last_error', 512).nullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(EPOCH);
      t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(EPOCH);
      t.specificType('sent_at', 'DATETIME(3)').nullable();

      t.primary(['delivery_id']);
      t.unique(['run_id', 'kind'], 'ind_agsvc_nd_a1');
      t.index(['org_id', 'user_id', 'created_at'], 'ind_agsvc_nd_i1');
      t.foreign('run_id').references('tbl_agsvc_runs.run_id');
    });

    await knex.schema.alterTable('tbl_agsvc_users', (t) => {
      t.boolean('notify_run_complete').notNullable().defaultTo(false);
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(NOTIFICATION_DELIVERIES_TABLE);
  if (await knex.schema.hasColumn('tbl_agsvc_users', 'notify_run_complete')) {
    await knex.schema.alterTable('tbl_agsvc_users', (t) => {
      t.dropColumn('notify_run_complete');
    });
  }
}
