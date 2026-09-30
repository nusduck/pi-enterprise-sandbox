/**
 * 产物可见性（design `agent-output-review.md` §3.2，ADR 0016 D1）。
 *
 * `tbl_agsvc_exec_artifacts` 增加三列：
 * - `visibility`：`released` | `held` | `withdrawn`。存量行与 direct 工作区
 *   全部是 `released`——默认值就是它，所以这次迁移**不改写任何既有行**。
 * - `revision_of`：审核员上传的修订版指向被替换的那一版；原件永不覆盖，
 *   审核历史就是这条 `revision_of` 链。
 * - `created_by_kind`：`agent` | `reviewer`。
 *
 * DDL 常量在 `exec/src/db/repositories/artifacts.ts`；这里必须与它逐列一致
 * （`tests/test_exec_schema_migrations.py` 只钉「接了就必须有迁移」，列的一致性
 * 由 `contract/schema/schema-manifest.json` 的只读核对负责）。
 *
 * 用 `knex.schema.alterTable` 而不是 `tracker.alterTable`：tracker 只跟踪
 * `createTable`（MySQL 的 DDL 不是事务性的，加列失败可能留下"加了一半"的表）。
 * 所以每一步都先 `hasColumn` 再改，让一次失败后的重跑是安全的——
 * 与 `20260928000001_run_completion_notifications.js` 同一处理。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const EXEC_ARTIFACTS_TABLE = 'tbl_agsvc_exec_artifacts';

/** 本迁移新增的三列；顺带让 `down` 与幂等检查共用一份事实。 */
export const EXEC_ARTIFACT_VISIBILITY_COLUMNS = Object.freeze([
  'visibility',
  'revision_of',
  'created_by_kind',
]);

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async () => {
    if (!(await knex.schema.hasColumn(EXEC_ARTIFACTS_TABLE, 'visibility'))) {
      await knex.schema.alterTable(EXEC_ARTIFACTS_TABLE, (t) => {
        // 默认 `released`：这条迁移对存量行是空操作，direct 工作区行为完全不变。
        t.specificType('visibility', 'CHAR(16)').notNullable().defaultTo('released');
      });
    }
    if (!(await knex.schema.hasColumn(EXEC_ARTIFACTS_TABLE, 'revision_of'))) {
      await knex.schema.alterTable(EXEC_ARTIFACTS_TABLE, (t) => {
        t.string('revision_of', 64).nullable();
      });
    }
    if (!(await knex.schema.hasColumn(EXEC_ARTIFACTS_TABLE, 'created_by_kind'))) {
      await knex.schema.alterTable(EXEC_ARTIFACTS_TABLE, (t) => {
        t.specificType('created_by_kind', 'CHAR(16)').notNullable().defaultTo('agent');
      });
    }
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  for (const column of EXEC_ARTIFACT_VISIBILITY_COLUMNS) {
    if (!(await knex.schema.hasColumn(EXEC_ARTIFACTS_TABLE, column))) continue;
    await knex.schema.alterTable(EXEC_ARTIFACTS_TABLE, (t) => {
      t.dropColumn(column);
    });
  }
}
