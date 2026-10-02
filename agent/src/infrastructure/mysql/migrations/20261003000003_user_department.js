/**
 * 部门信息预留（UPspec 表 tbl_agsvc_users 加 department 列）。
 *
 * 只记录与展示，不做任何按部门授权的判断。
 * 加列用 withPartialDdlCleanup + hasColumn 幂等。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const USERS_TABLE = 'tbl_agsvc_users';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async () => {
    if (!(await knex.schema.hasColumn(USERS_TABLE, 'department'))) {
      await knex.schema.alterTable(USERS_TABLE, (t) => {
        t.string('department', 255).nullable();
      });
    }
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  if (await knex.schema.hasColumn(USERS_TABLE, 'department')) {
    await knex.schema.alterTable(USERS_TABLE, (t) => {
      t.dropColumn('department');
    });
  }
}
