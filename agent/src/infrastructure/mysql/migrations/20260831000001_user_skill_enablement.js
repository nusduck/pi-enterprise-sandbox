/**
 * 用户侧 Skill 的启用态（ADR 0009 D7 / 计划 H6.6）。
 *
 * ## 这张表是闸门的账
 *
 * D7 取消了整套 skill 变更工具：模型用 `write` / `bash` 在草稿根里造包，
 * **写不再经任何审批**。闸门只剩人在 UI 上按的那一下「启用」——而这张表就是
 * 那一下的durable 记录。没有它，「哪些包会进这个用户的 system prompt 与只读挂载」
 * 就只能靠扫目录，而目录是模型可写的。
 *
 * ## 为什么记 content_digest，又为什么**不需要**每 Run 重算
 *
 * 启用时会把草稿的字节**复制**成一份只读的已发布副本（`skills/enablement.ts`），
 * 所以已启用的包与草稿是两份字节：模型改草稿动不了已启用的那份。
 * ADR 0006 P1 (B) 那条绕过因此在**构造上**消失了，不需要常驻校验。
 *
 * digest 留下来是为了别的事：审批/审计要能回答「界面上显示的那一版，和现在挂着
 * 的这一版，是同一份吗」，以及重复启用同一份内容时可以识别成无变化。
 *
 * ## owner-scoped
 *
 * 每一行都带 org_id + user_id，读写都必须带上——一个用户启用的包永远进不了
 * 另一个用户（或另一个 org）的上下文。这与 skill 的物理布局是同一条纪律
 * （`<base>/<orgId>/<userId>`）。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

export const USER_SKILL_ENABLEMENTS_TABLE = 'user_skill_enablements';

const ID_TYPE = 'CHAR(26)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(USER_SKILL_ENABLEMENTS_TABLE, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('enablement_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('user_id', ID_TYPE).notNullable();
      // 包名即 skill 名（SKILL.md frontmatter 的 name），也是挂载目标的最后一段。
      // 191 让唯一索引落在 utf8mb4 的 767 字节前缀限制内。
      t.string('skill_name', 191).notNullable();
      // 已发布副本的内容摘要（sha256 hex）。绑字节，不绑时间戳。
      t.specificType('content_digest', 'CHAR(64)').notNullable();
      t.integer('file_count').notNullable();
      t.bigInteger('total_bytes').notNullable();
      // 谁按的那一下、什么时候。闸门只有这一处，所以它必须留痕。
      t.specificType('enabled_by_user_id', ID_TYPE).notNullable();
      t.specificType('enabled_at', 'DATETIME(3)').notNullable();
      t.specificType('updated_at', 'DATETIME(3)').notNullable();

      t.primary(['enablement_id'], 'pk_user_skill_enablements');
      // 一个用户对同一个包名只能有一条启用记录：重新启用是**替换**那份副本
      // （`atomicReplaceDir`），不是再加一行——两行会让「挂哪一份」没有答案。
      t.unique(['org_id', 'user_id', 'skill_name'], 'uk_user_skill_enablements_owner_name');
      t.index(['org_id', 'user_id', 'enabled_at'], 'idx_user_skill_enablements_owner');
      t.foreign('org_id').references('organizations.org_id');
      t.foreign('user_id').references('users.user_id');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(USER_SKILL_ENABLEMENTS_TABLE);
}
