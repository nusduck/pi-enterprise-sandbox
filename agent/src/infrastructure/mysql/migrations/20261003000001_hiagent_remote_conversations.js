/**
 * HiAgent 远端会话绑定（docs/design/hiagent-remote-delegation.md §3）。
 *
 * 同一平台会话里对同一远端的连续委派默认续用上一次的 HiAgent 会话；
 * 模型拿不到也传不进远端会话 ID（工具参数里没有这个字段），绑定只活在服务端。
 *
 * 会话删除是软删除（`conversations.archive` 只改 status/archived_at，不删行），
 * conversation_id 是 ULID、永不复用，所以归档时不需要额外清理绑定：
 * 残留行永远不会被再次命中（新会话拿新 id），查询又一律带 org/user scope。
 * 没有硬删除路径，也就没有孤儿外键问题。
 *
 * UPspec 命名：表 `tbl_agsvc_remote_conversations`（逻辑名 remote_conversations，
 * 缩写 rc），索引 `ind_agsvc_rc_a1`（唯一）/ `ind_agsvc_rc_i1` / `ind_agsvc_rc_i2`。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const REMOTE_CONVERSATIONS_TABLE = 'tbl_agsvc_remote_conversations';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(REMOTE_CONVERSATIONS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('binding_id', 'CHAR(26)').notNullable();
      t.specificType('org_id', 'CHAR(26)').notNullable();
      t.specificType('user_id', 'CHAR(26)').notNullable();
      t.specificType('conversation_id', 'CHAR(26)').notNullable();
      t.string('remote_agent_id', 32).notNullable();
      t.string('remote_conversation_id', 191).notNullable();
      t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.fn.now(3));
      t.specificType('updated_at', 'DATETIME(3)').notNullable().defaultTo(knex.fn.now(3));

      t.primary(['binding_id'], 'pk_remote_conversations');
      t.unique(['conversation_id', 'remote_agent_id'], 'ind_agsvc_rc_a1');
      t.index(['org_id', 'user_id'], 'ind_agsvc_rc_i1');
      // users 外键需要以 user_id 打头的索引（i1 的前缀是 org_id），否则 MySQL 自动建一个不合规名的。
      t.index(['user_id'], 'ind_agsvc_rc_i2');
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
      t.foreign('user_id').references('tbl_agsvc_users.user_id');
      t.foreign('conversation_id').references('tbl_agsvc_conversations.conversation_id');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(REMOTE_CONVERSATIONS_TABLE);
}
