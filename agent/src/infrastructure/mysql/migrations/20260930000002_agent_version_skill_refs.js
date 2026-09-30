/**
 * AgentVersion → Skill 的引用账本（ADR 0015 D5，design §5.2）。
 *
 * ## 这张表回答两个问题
 *
 * 1. **「哪些 Agent 在用这个 org 版本」**——吊销一个 org 版本时，运维要立刻知道影响面
 *    （design §7.2 的响应带 `affectedAgentVersionIds`）。扫所有 AgentVersion 的
 *    `config_json` 既慢又不可靠（那是 JSON，不是可索引的事实）。
 * 2. **GC 判定**——被任何 AgentVersion 引用的 org 版本**不回收**（design §5.4）。
 *    这一条必须建立在可索引的引用上：靠扫描 JSON 判「还有人用吗」，漏一个就会删掉
 *    在跑的 Run 要挂载的字节。
 *
 * ## 为什么只增不改
 *
 * AgentVersion 是不可变的（plan 的既有纪律，ADR 0015 D3 再次确认），所以它的引用集合
 * 在创建那一刻就冻结了。没有 UPDATE 路径，也就没有「引用改到一半」的中间态。
 *
 * `scope` 取 `system` / `org`：**只登记这两层**。用户层没有引用一说——它属于调用者，
 * 随启用账本变化，不随 AgentVersion 固定。所以这张表里不会出现 `user`，写别的值也是
 * 调用方的 bug。
 *
 * ## 命名
 *
 * 本迁移排在 UPspec 改名之后，所以直接建物理表名、外键引用物理父表名（同
 * `20260928000001` / `20260930000001` 的写法）。索引缩写 `avsr` 全库唯一。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

/** 逻辑表名（读写方用 `physicalTableName()` 取物理名）。 */
export const AGENT_VERSION_SKILL_REFS_TABLE = 'agent_version_skill_refs';

/** 本迁移的建表名（= `tbl_agsvc_` + 逻辑名）。 */
const PHYSICAL_AGENT_VERSION_SKILL_REFS = 'tbl_agsvc_agent_version_skill_refs';

const ID_TYPE = 'CHAR(26)';
const DIGEST_TYPE = 'CHAR(64)';
const SCOPE_TYPE = 'CHAR(16)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(PHYSICAL_AGENT_VERSION_SKILL_REFS, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      // 复合主键（version_id, scope, skill_name）而不是代理键：这张表没有独立身份，
      // 「这个版本引用了这个 skill」本身就是唯一的，多一个代理键只会多一个可以漂的字段。
      t.specificType('agent_version_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      // `system` / `org`。用户层不进这张表（见模块说明）。
      t.specificType('scope', SCOPE_TYPE).notNullable();
      t.string('skill_name', 191).notNullable();
      // system 层按名选择、不钉摘要，所以是空串；org 层是钉住的摘要。
      t.specificType('content_digest', DIGEST_TYPE).notNullable().defaultTo('');
      t.specificType('created_at', 'DATETIME(3)').notNullable().defaultTo(knex.fn.now(3));

      t.primary(['agent_version_id', 'scope', 'skill_name'], 'pk_agent_version_skill_refs');
      // 吊销影响面：按 (org, scope, name, digest) 反查引用了它的 AgentVersion。
      t.index(
        ['org_id', 'scope', 'skill_name', 'content_digest'],
        'ind_agsvc_avsr_i1',
      );
      t.foreign('agent_version_id').references('tbl_agsvc_agent_versions.agent_version_id');
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(PHYSICAL_AGENT_VERSION_SKILL_REFS);
}
