/**
 * 智能体可见范围（design `docs/design/agent-visibility.md` §3）。
 *
 * - `tbl_agsvc_agent_definitions.visibility`：`org`（本组织全员可用）| `restricted`
 *   （只有被授予的成员可用）。默认 `org`：存量智能体行为完全不变，这条迁移不改写任何既有行。
 * - `tbl_agsvc_agent_user_grants`：受限智能体的使用授予，一行 = 一个成员。按内部
 *   `user_id`（ULID）授予——工号只是查找人的方式，不是授权键（工号可变）。
 *
 * 加列用 `knex.schema.alterTable` + `hasColumn` 幂等（MySQL DDL 不是事务性的，见
 * `20261001000003_exec_artifact_visibility.js`）；建表走 tracker，失败时清理半成品。
 * 索引缩写 `aug` 全库唯一。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const AGENT_DEFINITIONS_TABLE = 'tbl_agsvc_agent_definitions';
export const AGENT_USER_GRANTS_TABLE = 'agent_user_grants';
const PHYSICAL_AGENT_USER_GRANTS = 'tbl_agsvc_agent_user_grants';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    if (!(await knex.schema.hasColumn(AGENT_DEFINITIONS_TABLE, 'visibility'))) {
      await knex.schema.alterTable(AGENT_DEFINITIONS_TABLE, (t) => {
        t.specificType('visibility', 'CHAR(16)').notNullable().defaultTo('org');
      });
    }
    await tracker.createTable(PHYSICAL_AGENT_USER_GRANTS, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('agent_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      // 冗余 org_id：「我能用哪些智能体」按 (org, user) 一次查出，不用回表 join。
      t.specificType('org_id', 'CHAR(26)').notNullable();
      // 授予人（内部 user_id）；审计用，不参与判定。
      t.specificType('granted_by', 'CHAR(26)').nullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.fn.now(3));

      t.index(['org_id', 'user_id'], 'ind_agsvc_aug_i1');
      // users 外键需要以 user_id 打头的索引（i1 的前缀是 org_id）。
      t.index(['user_id'], 'ind_agsvc_aug_i2');
      t.foreign('agent_id').references('tbl_agsvc_agent_definitions.agent_id');
      t.foreign('user_id').references('tbl_agsvc_users.user_id');
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
      t.primary(['agent_id', 'user_id'], 'pk_agent_user_grants');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(PHYSICAL_AGENT_USER_GRANTS);
  if (await knex.schema.hasColumn(AGENT_DEFINITIONS_TABLE, 'visibility')) {
    await knex.schema.alterTable(AGENT_DEFINITIONS_TABLE, (t) => {
      t.dropColumn('visibility');
    });
  }
}
