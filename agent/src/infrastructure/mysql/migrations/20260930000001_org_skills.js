/**
 * org 层共享 Skill 的账本（ADR 0015 D5/D6/D8，design `skill-catalog-and-agent-binding.md` §5.2）。
 *
 * ## 这三张表解决什么
 *
 * 在 ADR 0015 之前，Skill 只有「归属」一个维度：系统层随 release 交付、用户层按
 * `(org, user)` 启用。用户开发好的包想让别人用，只能各自上传、各自启用，得到的是
 * 互不相干的拷贝。org 层补上「本 org 管理员背书的一份字节，多个 AgentVersion 绑定」。
 *
 * - `org_skill_versions`：**每个已发布摘要一行，不可变**。它回答「这份字节存在吗、
 *   谁发布的、现在是什么状态」。摘要按**复制后的暂存字节**算（与用户层同一纪律），
 *   所以作者之后改草稿不影响已发布的版本（design §7.1）。
 * - `org_skills`：**每名一行的「当前推荐版本」指针**。配置面默认选中它，但**不影响
 *   已钉的 AgentVersion**——绑定钉的是摘要（ADR 0015 D3），跟随最新会让同一个
 *   AgentVersion 在不同时间行为不同，审计无法回答「那次 Run 用的是哪版」。
 * - `skill_share_requests`：用户申请 → 管理员批准的流程账。「批准」是信任等级的提升
 *   （从「只进作者自己的上下文」变成「进他人的 prompt 与执行环境」），所以不能复用
 *   用户自己的「启用」，必须留下谁申请、谁批准、依据哪个摘要。
 *
 * ## 为什么 `revoked` 的字节不立即删
 *
 * `status` 是 `active` / `deprecated` / `revoked`（ADR 0015 D8）。吊销是安全动作、
 * 立刻影响**新 Run 的解析**，但已钉住它的 Run 不被中途撤掉挂载（与 S1「清单固定到
 * Run」一致）。字节保留到「不被任何 AgentVersion 引用、不是 current、且过了宽限期」
 * 才回收（§5.4），便于事后审计。
 *
 * ## 命名
 *
 * 表/索引按 UPspec（ADR 0013）：`tbl_agsvc_<name>` 与
 * `ind_agsvc_<abbr>_(a|i)<n>`，缩写全库唯一。本迁移用 `osv`（versions）、
 * `osk`（skills）、`osr`（share requests）。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

/**
 * 逻辑表名（与更早的迁移同一套写法）。读写方用 `physicalTableName()` 取物理名——
 * 本迁移的 `createTable` 必须直接给物理名（它排在 UPspec 改名之后），但**导出的常量
 * 仍是逻辑名**，否则调用方会分不清「该传逻辑名还是物理名」。
 */
export const ORG_SKILL_VERSIONS_TABLE = 'org_skill_versions';
export const ORG_SKILLS_TABLE = 'org_skills';
export const SKILL_SHARE_REQUESTS_TABLE = 'skill_share_requests';

/** 本迁移的建表名（= `tbl_agsvc_` + 逻辑名）。 */
const PHYSICAL_ORG_SKILL_VERSIONS = 'tbl_agsvc_org_skill_versions';
const PHYSICAL_ORG_SKILLS = 'tbl_agsvc_org_skills';
const PHYSICAL_SKILL_SHARE_REQUESTS = 'tbl_agsvc_skill_share_requests';

const ID_TYPE = 'CHAR(26)';
const DIGEST_TYPE = 'CHAR(64)';
const STATUS_TYPE = 'CHAR(16)';
const AT_TYPE = 'DATETIME(3)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    // ── 每个已发布的 org 版本一行，不可变 ────────────────────────────────────
    await tracker.createTable(PHYSICAL_ORG_SKILL_VERSIONS, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('version_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      // 包名；191 让索引落在 utf8mb4 的前缀限制内。
      t.string('skill_name', 191).notNullable().defaultTo('');
      // 按**复制后的暂存字节**计算，不按草稿（草稿模型可写）。
      t.specificType('content_digest', DIGEST_TYPE).notNullable();
      t.integer('file_count').notNullable().defaultTo(0);
      t.bigInteger('total_bytes').notNullable().defaultTo(0);
      // 发布时从 frontmatter 取，供配置面展示——不必为了列表去读字节。
      t.string('description', 1024).notNullable().defaultTo('');
      // 这份字节从哪来：作者申请批准 / 管理员直接上传。
      t.specificType('origin_kind', STATUS_TYPE).notNullable().defaultTo('');
      t.specificType('origin_user_id', ID_TYPE).notNullable();
      // 来自申请时填写；管理员直传为空串（NOT NULL 但允许空值，省掉一个 nullable 列）。
      t.specificType('origin_request_id', ID_TYPE).notNullable().defaultTo('');
      // active / deprecated / revoked（ADR 0015 D8）。
      t.specificType('status', STATUS_TYPE).notNullable().defaultTo('active');
      t.specificType('published_by_user_id', ID_TYPE).notNullable();
      t.specificType('published_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));
      // 弃用/吊销留痕：谁改的、什么时候、为什么。吊销是安全动作，必须能追责。
      t.specificType('status_changed_by_user_id', ID_TYPE).notNullable().defaultTo('');
      t.specificType('status_changed_at', AT_TYPE).nullable();
      t.string('status_reason', 1024).notNullable().defaultTo('');
      t.specificType('updated_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));

      t.primary(['version_id'], 'pk_org_skill_versions');
      // 同一摘要只发布一次：重复发布同一份内容是无变化，不是新版本
      // （`revoked` 的摘要不允许再次发布，见 §7.1，那一层在应用层判）。
      t.unique(['org_id', 'skill_name', 'content_digest'], 'ind_agsvc_osv_a1');
      t.index(['org_id', 'skill_name', 'published_at'], 'ind_agsvc_osv_i1');
      t.index(['org_id', 'status'], 'ind_agsvc_osv_i2');
      // 本迁移排在 UPspec 改名之后，所以引用**物理**表名（见 20260928000001 的同一写法）。
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
    });

    // ── 每名一行的「当前推荐版本」指针 ──────────────────────────────────────
    await tracker.createTable(PHYSICAL_ORG_SKILLS, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('org_skill_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.string('skill_name', 191).notNullable().defaultTo('');
      // 配置面默认选中它；**已钉的 AgentVersion 不受影响**（ADR 0015 D3）。
      t.specificType('current_digest', DIGEST_TYPE).notNullable().defaultTo('');
      t.specificType('updated_by_user_id', ID_TYPE).notNullable();
      t.specificType('updated_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));

      t.primary(['org_skill_id'], 'pk_org_skills');
      // 一行就是「这个名字在 org 层存在」的权威记录，也是发布/弃用/吊销的
      // `SELECT … FOR UPDATE` 锁对象（design §5.3：同 org 同名串行）。
      t.unique(['org_id', 'skill_name'], 'ind_agsvc_osk_a1');
      // 本迁移排在 UPspec 改名之后，所以引用**物理**表名（见 20260928000001 的同一写法）。
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
    });

    // ── 用户申请 → 管理员决定 ────────────────────────────────────────────────
    await tracker.createTable(PHYSICAL_SKILL_SHARE_REQUESTS, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('request_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('requester_user_id', ID_TYPE).notNullable();
      t.string('skill_name', 191).notNullable().defaultTo('');
      // 申请时钉住的摘要。批准时从作者的**已发布版本**复制并重算，二者不等即拒绝
      // （design §5.3）——所以要留原值以便对照。
      t.specificType('content_digest', DIGEST_TYPE).notNullable();
      t.string('note', 1024).notNullable().defaultTo('');
      // pending / approved / rejected / withdrawn / superseded。
      t.specificType('status', STATUS_TYPE).notNullable().defaultTo('pending');
      t.specificType('decided_by_user_id', ID_TYPE).notNullable().defaultTo('');
      t.specificType('decided_at', AT_TYPE).nullable();
      t.string('decision_note', 1024).notNullable().defaultTo('');
      t.specificType('created_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));

      t.primary(['request_id'], 'pk_skill_share_requests');
      // 「同一 (org, requester, name) 至多一条 pending」由应用层在事务内保证
      // （design §5.2 原话）：历史行要保留，所以不能在这里做唯一约束。
      t.index(['org_id', 'status', 'created_at'], 'ind_agsvc_osr_i1');
      t.index(['org_id', 'requester_user_id', 'created_at'], 'ind_agsvc_osr_i2');
      // 本迁移排在 UPspec 改名之后，所以引用**物理**表名（见 20260928000001 的同一写法）。
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  // 依赖顺序与 up 相反（versions 引用 requests 的 id 只在应用层，没有 FK）。
  await knex.schema.dropTableIfExists(PHYSICAL_SKILL_SHARE_REQUESTS);
  await knex.schema.dropTableIfExists(PHYSICAL_ORG_SKILLS);
  await knex.schema.dropTableIfExists(PHYSICAL_ORG_SKILL_VERSIONS);
}
