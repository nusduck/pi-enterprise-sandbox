/**
 * 平台角色账本（design `docs/design/rbac-roles.md` §2）：`tbl_agsvc_member_roles`
 * 与只追加的 `tbl_agsvc_member_role_events`。
 *
 * ## 为什么角色挂在 (org_id, user_id) 上
 *
 * 一期角色是**平台角色**（`admin` / `reviewer`），不是组织内的自定义角色。挂在
 * 组织成员关系上，与 SSO 方案约定的「角色以平台 Membership 为准，不用 SSO claim
 * 自动提权」一致，也让「跨 org 一律 404」这条不变量自然成立：另一个租户的
 * userId 在本 org 的账本里根本不存在。
 *
 * 主键 `(org_id, user_id, role)` 让「授予」天然幂等——重复授予只是撞主键。
 * 撤销是删行（不是把某个列改回 `user`）：一个人可以同时持有 `admin` 与
 * `reviewer`，单值列表达不了集合。
 *
 * ## 为什么审计单独一张表
 *
 * 授予与撤销都是**安全动作**，要回答「谁在什么时候把 admin 给了谁」。和它在同一
 * 事务里写事件行（`MemberRoleService`），就不会出现「账本改了而审计没记」的中间态。
 * 只记身份 ID，不记用户名或邮箱明文（与 `sandbox_audit_events` 同一纪律）。
 *
 * ## 旧列的去留
 *
 * `auth_credentials.role` 停止作为权威：本期保留列，写入 `me` 算出的兼容主角色，
 * 删列放到后续清理 PR。`organization_memberships.role` 语义收窄为「成员类型」
 * （`member`），不参与授权，本期不迁移历史行。
 *
 * ## 数据迁移为什么写成 `INSERT … SELECT`
 *
 * 旧的 `auth_credentials.role = 'admin'` 要落成真正的授予（design §2.4）。这条回填
 * **必须写成一条纯 SQL 的 `INSERT IGNORE … SELECT`**，不能写成「先 SELECT 出来再逐行
 * INSERT」：schema 发布包（`scripts/dev/schema-apply.sh`、`npm run schema:sql --prefix
 * agent`）是在**空影子库**上重放迁移、抓取语句生成的，而抓取只保留
 * `create/alter/insert/update/delete…`（`schema-export.ts` 的 `KEEP`），**读语句会被
 * 丢掉**。逐行写法在空库上一条语句都不产生，于是走发布包升级的部署会**静默跳过
 * 回填**——表和索引都在，老 admin 却没有角色。`INSERT … SELECT` 在空库上是零行空操作，
 * 在真实库上完整回填，两条升级路径效果一致。
 *
 * 回填**不写审计**：事件账本由本迁移创建，这次授予发生在它存在之前。
 * `member_roles.source = 'migration'` 已经记下了来源，凭空造一条带合成 ID 的
 * 「历史事件」是发明历史，不是记录历史。审计从账本上线后的第一次界面/引导操作开始。
 *
 * ## 命名
 *
 * 本迁移排在 UPspec 改名（`20260923000001`）之后，所以直接建物理表名、外键引用
 * 物理父表名。索引缩写 `mr`（member_roles）与 `mre`（member_role_events）全库唯一。
 */

import { withPartialDdlCleanup } from '../migration-partial-ddl.js';

/** 逻辑表名（读写方用 `physicalTableName()` 取物理名）。 */
export const MEMBER_ROLES_TABLE = 'member_roles';
export const MEMBER_ROLE_EVENTS_TABLE = 'member_role_events';

/** 本迁移的建表名（= `tbl_agsvc_` + 逻辑名）。 */
const PHYSICAL_MEMBER_ROLES = 'tbl_agsvc_member_roles';
const PHYSICAL_MEMBER_ROLE_EVENTS = 'tbl_agsvc_member_role_events';

const ID_TYPE = 'CHAR(26)';
const ROLE_TYPE = 'VARCHAR(32)';
const SMALL_TYPE = 'CHAR(16)';
const AT_TYPE = 'DATETIME(3)';

/** 一期固定角色白名单（design §0）。普通用户是默认身份，不是一条授权。 */
const ROLES = Object.freeze(['admin', 'reviewer']);

/**
 * 把老的 `auth_credentials.role = 'admin'` 回填成一条 `admin` 授予。
 *
 * 只迁移**已 provisioning**（`users` + `organization_external_refs` +
 * `organization_memberships` 三张映射齐全）的账号：没登录过的账号还没有 users 行，
 * 它们会在首次登录时走环境变量引导（design §3）。
 *
 * `INSERT IGNORE`（撞 `(org_id, user_id, role)` 主键即跳过）让重跑幂等。
 */
export const BACKFILL_LEGACY_ADMIN_SQL = `
INSERT IGNORE INTO ${PHYSICAL_MEMBER_ROLES}
  (org_id, user_id, role, granted_by, source, created_at)
SELECT oer.org_id, u.user_id, '${ROLES[0]}', NULL, 'migration', ac.updated_at
  FROM tbl_agsvc_auth_credentials ac
  JOIN tbl_agsvc_users u
    ON u.external_subject = CONCAT('bff:', ac.external_user_id)
  JOIN tbl_agsvc_organization_external_refs oer
    ON oer.provider = 'bff' AND oer.external_subject = ac.external_org_id
  JOIN tbl_agsvc_organization_memberships m
    ON m.org_id = oer.org_id AND m.user_id = u.user_id
 WHERE ac.role = '${ROLES[0]}'
`;

/**
 * 回填历史 admin 授予。
 *
 * **导出**是为了让集成测试能在真表上直接驱动它：迁移本身只跑一次，测不了「重跑幂等」
 * 与「未 provisioning 不迁移」这两条。
 *
 * @param {import('knex').Knex} knex
 */
export async function backfillLegacyAdmins(knex) {
  await knex.raw(BACKFILL_LEGACY_ADMIN_SQL);
}

/** @param {import('knex').Knex} knex */
export async function up(knex) {
  await withPartialDdlCleanup(knex, async (tracker) => {
    // ── 授予账本：一行 = 一条授权 ────────────────────────────────────────────
    await tracker.createTable(PHYSICAL_MEMBER_ROLES, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('user_id', ID_TYPE).notNullable();
      // admin | reviewer；应用层白名单校验，未知值拒绝写入。
      t.specificType('role', ROLE_TYPE).notNullable().defaultTo('');
      // 授予人 user_id；环境变量引导与数据迁移写 NULL（没有具体的人）。
      t.specificType('granted_by', ID_TYPE).nullable();
      // console（admin 在界面授予）| bootstrap（环境变量引导）| migration。
      t.specificType('source', SMALL_TYPE).notNullable().defaultTo('');
      t.specificType('created_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));

      t.primary(['org_id', 'user_id', 'role'], 'pk_member_roles');
      // 「本组织有几个 admin」「审核员列表」：按 (org, role) 反查，不必扫主键再回表。
      t.index(['org_id', 'role'], 'ind_agsvc_mr_i1');
      // users 外键需要以 user_id 打头的索引（主键是 (org_id, …)，前缀用不上）。
      t.index(['user_id'], 'ind_agsvc_mr_i2');
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
      t.foreign('user_id').references('tbl_agsvc_users.user_id');
    });

    // ── 只追加的审计：一行 = 一次授予或撤销 ──────────────────────────────────
    await tracker.createTable(PHYSICAL_MEMBER_ROLE_EVENTS, (t) => {
      t.engine('InnoDB');
      t.charset('utf8mb4');
      t.collate('utf8mb4_unicode_ci');

      t.specificType('event_id', ID_TYPE).notNullable();
      t.specificType('org_id', ID_TYPE).notNullable();
      t.specificType('user_id', ID_TYPE).notNullable();
      t.specificType('role', ROLE_TYPE).notNullable().defaultTo('');
      // grant | revoke。
      t.specificType('action', SMALL_TYPE).notNullable().defaultTo('');
      // 操作者 user_id；环境变量引导写 NULL。
      t.specificType('actor_user_id', ID_TYPE).nullable();
      t.specificType('source', SMALL_TYPE).notNullable().defaultTo('');
      t.specificType('created_at', AT_TYPE).notNullable().defaultTo(knex.fn.now(3));

      t.primary(['event_id'], 'pk_member_role_events');
      // 某个成员的角色变更记录（org 外键也跟着这条走）。
      t.index(['org_id', 'user_id', 'created_at'], 'ind_agsvc_mre_i1');
      t.index(['user_id'], 'ind_agsvc_mre_i2');
      t.foreign('org_id').references('tbl_agsvc_organizations.org_id');
      t.foreign('user_id').references('tbl_agsvc_users.user_id');
    });

    // 建表之后才回填历史数据：新库上这条 INSERT … SELECT 命中零行，是空操作。
    await backfillLegacyAdmins(knex);
  });
}

/** @param {import('knex').Knex} knex */
export async function down(knex) {
  await knex.schema.dropTableIfExists(PHYSICAL_MEMBER_ROLE_EVENTS);
  await knex.schema.dropTableIfExists(PHYSICAL_MEMBER_ROLES);
}
