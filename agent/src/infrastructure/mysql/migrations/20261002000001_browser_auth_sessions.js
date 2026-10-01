/**
 * 可撤销浏览器会话账本（design `docs/design/sso-integration-reservation.md` §5.2，
 * 本轮 P1a）。表 `tbl_agsvc_browser_auth_sessions`。
 *
 * ## 为什么单独一张表而不是继续用无状态 JWT
 *
 * 无 sid 的 JWT 签发后无法撤销：退出只能清 Cookie，重放同一串 JWT 依旧通过。
 * 这张表让「退出/停用/换机」有权威落点。JWT 只带 `sid`，判定每次都回表。
 *
 * ## 为什么同时存内部与外部 owner
 *
 * 资源归属用内部 ULID（`user_id` / `org_id`），而兼容的 HTTP 命名空间仍是
 * `users.external_subject = bff:<外部用户 ID>` 与 `organization_external_refs`。
 * 两者都记在会话行上，读取时核对其一致性——任何一侧被改到别的 owner 都会在
 * 下一个请求变成 401（`ActivePrincipalService`），不会出现「JWT 还能用但 owner 已漂移」。
 *
 * ## 列与索引按 UPspec
 *
 * 命名沿用 `20260923000001_upspec_naming.js` 之后的直接物理名；索引缩写 `bas`
 * 全库唯一（`ind_agsvc_bas_i1` / `ind_agsvc_bas_i2`）。`login_method` / `source`
 * 是定长 ≤16 的枚举投影，用 `CHAR(16)`。NOT NULL 列带默认值：`expires_at` 的默认
 * 是 `CURRENT_TIMESTAMP(3)`，漏写时立即过期（fail-closed），不是永不过期。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

/** 逻辑表名（读写方用 `physicalTableName()` 取物理名）。 */
export const BROWSER_AUTH_SESSIONS_TABLE = 'browser_auth_sessions';

/** 本迁移的建表名（= `tbl_agsvc_` + 逻辑名）。 */
const PHYSICAL_BROWSER_AUTH_SESSIONS = 'tbl_agsvc_browser_auth_sessions';

const ID_TYPE = 'CHAR(26)';
const SMALL_TYPE = 'CHAR(16)';
const AT_TYPE = 'DATETIME(3)';
const EXTERNAL_ID_TYPE = 'VARCHAR(128)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(PHYSICAL_BROWSER_AUTH_SESSIONS, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('session_id', ID_TYPE).notNullable();
      // 会话 owner：内部 ULID，资源归属与成员校验用。
      t.specificType('user_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      // 兼容映射（签发时的外部 ID），读取时与权威映射核对一致。
      t.specificType('external_user_id', EXTERNAL_ID_TYPE).notNullable();
      t.specificType('external_org_id', EXTERNAL_ID_TYPE).notNullable();
      // local | sso | …；本轮只写 local。
      t.specificType('login_method', SMALL_TYPE).notNullable().defaultTo('');
      // 协议来源标识；local 会话为 NULL。长度 64 属既有 provider 约定。
      t.string('identity_provider', 64).nullable();
      // login | register（同一凭据来源的两种入口）。
      t.specificType('source', SMALL_TYPE).notNullable().defaultTo('');
      t.specificType('created_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));
      // 默认即过期：漏写 expires_at 的会话不可用，而不是永不过期。
      t.specificType('expires_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));
      t.specificType('revoked_at', AT_TYPE).nullable();

      t.primary(['session_id'], 'pk_browser_auth_sessions');
      // 某 owner 的会话列表 / 撤销审计；org_id 前缀同时覆盖 org 外键。
      t.index(['org_id', 'user_id', 'created_at'], 'ind_agsvc_bas_i1');
      // users 外键需要以 user_id 打头的索引（i1 前缀用不上）。
      t.index(['user_id'], 'ind_agsvc_bas_i2');
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
      t.foreign('user_id').references('tbl_agsvc_users.user_id');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(PHYSICAL_BROWSER_AUTH_SESSIONS);
}
