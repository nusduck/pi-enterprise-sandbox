/**
 * exec 工作区交付策略（design `agent-output-review.md` §3.1，ADR 0016 D1）。
 *
 * 判定「这个工作区里的产物要不要先审核」必须发生在 exec：产物库
 * （`GET /artifacts`）与跨会话导入都不经过 agent，只在 BFF 或 agent 外面拦
 * 等于没有拦。表建在 agent 的迁移目录里，是因为共享 MySQL 的建表权威在
 * `agent/`（AGENTS.md §1、`tests/test_exec_schema_migrations.py`）。
 *
 * 只存非默认策略：`direct` 就是没有行，所以不需要撤销接口，写入侧用
 * `INSERT IGNORE`（`MySqlWorkspacePolicyStore.rememberReview`）。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const EXEC_WORKSPACE_POLICIES_TABLE = 'tbl_agsvc_exec_workspace_policies';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(EXEC_WORKSPACE_POLICIES_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      // 工作区 id 的形状与 `exec_artifacts.workspace_id` 一致（VARCHAR(191)）。
      t.string('workspace_id', 191).notNullable();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      // 目前唯一取值是 `review`；列宽 16 与既有状态列一致。
      t.specificType('delivery', 'CHAR(16)').notNullable().defaultTo('review');
      t.specificType('created_at', 'DATETIME(3)')
        .notNullable()
        .defaultTo(knex.raw('CURRENT_TIMESTAMP(3)'));

      // 主键即工作区：一个工作区一条策略。
      t.primary(['workspace_id'], 'pk_exec_workspace_policies');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(EXEC_WORKSPACE_POLICIES_TABLE);
}
