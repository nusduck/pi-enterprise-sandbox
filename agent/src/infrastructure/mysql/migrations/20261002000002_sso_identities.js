/**
 * 公司 SSO 外部身份关联（design `docs/design/sso-oidc-dev.md` §3）。
 * 表 `tbl_agsvc_sso_identities`。
 *
 * ## 为什么按 `(issuer, subject)` 绑定
 *
 * OIDC Core §5.7：只有 `iss` + `sub` 组合在 IdP 内稳定且唯一。工号、邮箱、姓名都可能
 * 变更或复用，只作为属性存下来（`employee_id` 供 admin 按工号搜索），**不作为绑定键**。
 *
 * ## 为什么挂到凭据的 `external_user_id`
 *
 * 平台身份链（会话行、`users.external_subject = bff:<id>`、资料页、通知开关）都以
 * 凭据的外部用户 ID 为锚。SSO 用户也落一行没有可用密码的凭据，这张表只负责
 * 「公司身份 → 这个外部用户 ID」的一跳；一个外部用户 ID 至多对应一个公司身份。
 *
 * ## 列与索引按 UPspec
 *
 * 索引缩写 `ssi` 全库唯一。`issuer` / `subject` 各 255：两列唯一索引 2040 字节，
 * 在 MySQL 5.7 DYNAMIC 行格式的 3072 上限内。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

/** 逻辑表名。 */
export const SSO_IDENTITIES_TABLE = 'sso_identities';

/** 本迁移的建表名（= `tbl_agsvc_` + 逻辑名）。 */
const PHYSICAL_SSO_IDENTITIES = 'tbl_agsvc_sso_identities';

const ID_TYPE = 'CHAR(26)';
const AT_TYPE = 'DATETIME(3)';
const EXTERNAL_ID_TYPE = 'VARCHAR(128)';

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    await tracker.createTable(PHYSICAL_SSO_IDENTITIES, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('identity_id', ID_TYPE).notNullable();
      t.string('issuer', 255).notNullable().defaultTo('');
      t.string('subject', 255).notNullable().defaultTo('');
      // 平台侧锚点：`tbl_agsvc_auth_credentials.external_user_id`。
      t.specificType('external_user_id', EXTERNAL_ID_TYPE).notNullable().defaultTo('');
      // 工号来自可配置 claim；IdP 没给时为 NULL，不编造。
      t.specificType('employee_id', EXTERNAL_ID_TYPE).nullable();
      t.specificType('created_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));
      t.specificType('last_login_at', AT_TYPE).nullable();

      // 一个公司身份只绑一个平台用户；并发首次登录靠它收敛。
      t.unique(['issuer', 'subject'], { indexName: 'ind_agsvc_ssi_a1' });
      // 一个平台用户至多一个公司身份。
      t.unique(['external_user_id'], { indexName: 'ind_agsvc_ssi_a2' });
      // admin 按工号查人。
      t.index(['employee_id'], 'ind_agsvc_ssi_i1');
      // 主键放最后：见 review_ledger 迁移里 `migration-primary-options` 棘轮的说明。
      t.primary(['identity_id'], 'pk_sso_identities');
    });
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(PHYSICAL_SSO_IDENTITIES);
}
