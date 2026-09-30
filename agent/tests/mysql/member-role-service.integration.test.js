/**
 * 平台角色账本与 `MemberRoleService` 的真实 MySQL 门禁（design rbac-roles §5 并发要求）。
 *
 * 这里跑的是**真表、真事务、真 `SELECT … FOR UPDATE`**：并发撤销必须靠数据库的锁
 * 语义证明，用内存替身「证明」不了——替身里没有并发，也没有会回滚的事务。
 *
 * Requires TEST_MYSQL_URL=mysql://…；缺配置时整组跳过。**必须是专用库**：
 * 它会清空角色账本与身份映射表。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const TEST_MYSQL_URL = (process.env.TEST_MYSQL_URL || '').trim();
const require = createRequire(import.meta.url);

function mysqlDepsAvailable() {
  try {
    require.resolve('knex');
    require.resolve('mysql2');
    return true;
  } catch {
    return false;
  }
}

const runLive =
  Boolean(TEST_MYSQL_URL) &&
  mysqlDepsAvailable() &&
  (TEST_MYSQL_URL.startsWith('mysql://') || TEST_MYSQL_URL.startsWith('mysql2://'));

const describeLive = runLive ? describe : describe.skip;

/** 部署锁定名单里的账号（`SANDBOX_AUTH_ADMIN_USERNAMES`）。 */
const PINNED_USERNAME = 'root-admin';

describe('member role ledger integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / deps missing', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('member roles (TEST_MYSQL_URL)', () => {
  let knex;
  let ulid;
  let createRepositoryBundle;
  let TransactionManager;
  let MemberRoleService;
  let MemberRoleRepository;
  let backfillLegacyAdmins;
  let service;
  let forward;

  before(async () => {
    ({ ulid } = await import('../../src/domain/shared/ulid.js'));
    ({ createRepositoryBundle } = await import('../../src/bootstrap/container-env.js'));
    ({ TransactionManager } = await import('../../src/infrastructure/mysql/transaction-manager.js'));
    ({ MemberRoleService } = await import('../../src/application/member-role-service.js'));
    ({ MemberRoleRepository } = await import(
      '../../src/infrastructure/mysql/repositories/member-role-repository.js'
    ));
    ({ backfillLegacyAdmins } = await import(
      '../../src/infrastructure/mysql/migrations/20261001000001_member_roles.js'
    ));
    const mysql = await import('../../src/infrastructure/mysql/index.js');
    knex = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 12 } });
    await mysql.migrateLatest(knex);
    forward = 0;
    const generateId = () => ulid();
    service = new MemberRoleService({
      db: knex,
      createRepositories: (db) => createRepositoryBundle(db, { generateId }),
      transactionManager: new TransactionManager(knex),
      pinnedAdminUsernames: [PINNED_USERNAME],
      generateId,
    });
  });

  after(async () => {
    if (knex) await knex.destroy();
  });

  beforeEach(async () => {
    // 专用库：按外键顺序清干净，让每条用例看到同一个起点。
    for (const table of [
      'tbl_agsvc_member_role_events',
      'tbl_agsvc_member_roles',
      'tbl_agsvc_organization_memberships',
      'tbl_agsvc_auth_credentials',
      'tbl_agsvc_organization_external_refs',
      'tbl_agsvc_users',
      'tbl_agsvc_organizations',
    ]) {
      await knex(table).del();
    }
  });

  /** 建一个 org 与一批成员；返回内部 ULID 与可直接当 `X-Acting-*` 用的外部身份。 */
  async function seed(usernames) {
    forward += 1;
    const orgExternal = `org_rbac_${forward}`;
    const orgId = ulid();
    await knex('tbl_agsvc_organizations').insert({
      org_id: orgId,
      name: orgExternal,
      status: 'active',
      created_at: knex.fn.now(3),
      updated_at: knex.fn.now(3),
    });
    await knex('tbl_agsvc_organization_external_refs').insert({
      provider: 'bff',
      external_subject: orgExternal,
      org_id: orgId,
      created_at: knex.fn.now(3),
    });
    const members = {};
    for (const username of usernames) {
      const userId = ulid();
      const externalUserId = ulid();
      await knex('tbl_agsvc_users').insert({
        user_id: userId,
        external_subject: `bff:${externalUserId}`,
        display_name: username,
        email: `${username}@example.com`,
        status: 'active',
        created_at: knex.fn.now(3),
        updated_at: knex.fn.now(3),
      });
      await knex('tbl_agsvc_auth_credentials').insert({
        username,
        password_hash: 'pbkdf2_sha256$test$test',
        external_user_id: externalUserId,
        external_org_id: orgExternal,
        display_name: username,
        email: `${username}@example.com`,
        role: 'user',
        is_active: true,
        created_at: knex.fn.now(3),
        updated_at: knex.fn.now(3),
        last_login_at: knex.fn.now(3),
      });
      await knex('tbl_agsvc_organization_memberships').insert({
        org_id: orgId,
        user_id: userId,
        role: 'member',
        status: 'active',
        created_at: knex.fn.now(3),
      });
      members[username] = { userId, externalUserId };
    }
    return { orgId, orgExternal, members };
  }

  const actor = (externalOrgId, externalUserId, role) => ({
    externalOrgId,
    externalUserId,
    role,
  });

  async function rolesOf(orgId, userId) {
    return new MemberRoleRepository(knex).listRoles(orgId, userId);
  }

  async function eventCount(orgId, userId) {
    const [row] = await knex('tbl_agsvc_member_role_events')
      .where({ org_id: orgId, user_id: userId })
      .count({ n: '*' });
    return Number(row.n);
  }

  it('授予与撤销都是幂等的，且每次真实变更只写一条审计', async () => {
    const { orgId, orgExternal, members } = await seed(['alice', 'bob']);
    const admin = actor(orgExternal, members.alice.externalUserId, 'admin');
    const bob = members.bob.userId;

    const granted = await service.grantRole(admin, bob, 'reviewer');
    assert.deepEqual(granted.roles, ['reviewer']);
    // 幂等：第二次内容相同，且不重复写审计。
    const again = await service.grantRole(admin, bob, 'reviewer');
    assert.deepEqual(again.roles, ['reviewer']);
    assert.equal(await eventCount(orgId, bob), 1);

    const revoked = await service.revokeRole(admin, bob, 'reviewer');
    assert.deepEqual(revoked.roles, []);
    // 幂等：撤销一个本来就没有的角色是 200 空操作，也不写审计。
    const againRevoked = await service.revokeRole(admin, bob, 'reviewer');
    assert.deepEqual(againRevoked.roles, []);
    assert.equal(await eventCount(orgId, bob), 2, 'grant + revoke 各一条');
  });

  it('一个人可以同时持有 admin 与 reviewer；X-Acting-Role 集合里的 admin 被放行', async () => {
    const { orgId, orgExternal, members } = await seed(['alice', 'bob']);
    // 关键正向对照：调用者自己是 `admin,reviewer` 集合，不能被旧的字面判定误拒。
    const both = actor(orgExternal, members.alice.externalUserId, 'admin,reviewer');
    await service.grantRole(both, members.bob.userId, 'reviewer');
    const view = await service.grantRole(both, members.bob.userId, 'admin');
    assert.deepEqual(view.roles, ['admin', 'reviewer']);
    assert.deepEqual((await rolesOf(orgId, members.bob.userId)).map((r) => r.role), [
      'admin',
      'reviewer',
    ]);
  });

  it('reviewer 与缺失角色都拿不到管理面（fail-closed）', async () => {
    const { orgExternal, members } = await seed(['alice', 'bob']);
    const bob = members.bob.userId;
    for (const role of ['reviewer', null, '', 'root']) {
      await assert.rejects(
        service.grantRole(actor(orgExternal, members.alice.externalUserId, role), bob, 'reviewer'),
        (error) => error.code === 'ADMIN_REQUIRED' && error.status === 403,
        `role=${String(role)} 必须被拒绝`,
      );
    }
  });

  it('未知角色 422、跨 org 与不存在的 userId 同一个 404', async () => {
    const a = await seed(['alice', 'bob']);
    const b = await seed(['carol']);
    const admin = actor(a.orgExternal, a.members.alice.externalUserId, 'admin');

    await assert.rejects(
      service.grantRole(admin, a.members.bob.userId, 'root'),
      (error) => error.code === 'ROLE_UNKNOWN' && error.status === 422,
    );
    // 别的 org 的成员：存在性不能泄漏，与「不存在」同一个 404。
    await assert.rejects(
      service.grantRole(admin, b.members.carol.userId, 'reviewer'),
      (error) => error.code === 'NOT_FOUND' && error.status === 404,
    );
    await assert.rejects(
      service.revokeRole(admin, ulid(), 'reviewer'),
      (error) => error.code === 'NOT_FOUND' && error.status === 404,
    );
    await assert.rejects(
      service.listRoleEvents(admin, b.members.carol.userId),
      (error) => error.code === 'NOT_FOUND' && error.status === 404,
    );
  });

  it('撤销本 org 最后一个 admin 得到 LAST_ADMIN，撤销自己但还有别人则允许', async () => {
    const { orgId, orgExternal, members } = await seed(['alice', 'bob']);
    const admin = actor(orgExternal, members.alice.externalUserId, 'admin');
    await service.grantRole(admin, members.bob.userId, 'admin');

    // 两个 admin 时，alice 可以撤销自己的 admin。
    await service.revokeRole(admin, members.alice.userId, 'admin');
    await assert.rejects(
      service.revokeRole(admin, members.bob.userId, 'admin'),
      (error) => error.code === 'LAST_ADMIN' && error.status === 409,
    );
    assert.equal((await rolesOf(orgId, members.bob.userId)).length, 1, '最后那个 admin 还在');
  });

  it('部署锁定：名单内的 admin 不能撤销，未在名单里的可以', async () => {
    const { orgId, orgExternal, members } = await seed([PINNED_USERNAME, 'alice']);
    const pinned = members[PINNED_USERNAME];
    const admin = actor(orgExternal, members.alice.externalUserId, 'admin');
    await service.grantRole(admin, members.alice.userId, 'admin');
    await service.ensureDeploymentGrant({
      orgId,
      userId: pinned.userId,
      username: PINNED_USERNAME,
    });

    await assert.rejects(
      service.revokeRole(admin, pinned.userId, 'admin'),
      (error) => error.code === 'ROLE_PINNED_BY_DEPLOYMENT' && error.status === 409,
    );
    // 同一个服务实例、同一个名单：非名单成员照常可撤销。
    await service.revokeRole(admin, members.alice.userId, 'admin');
    assert.deepEqual(await service.listRolesForMember(orgId, pinned.userId), ['admin']);
    assert.deepEqual(await service.listRolesForMember(orgId, members.alice.userId), []);
  });

  it('环境变量引导只授予、不降级，且不重复写库', async () => {
    const { orgId, members } = await seed([PINNED_USERNAME, 'alice']);
    const pinned = members[PINNED_USERNAME];
    await service.ensureDeploymentGrant({ orgId, userId: pinned.userId, username: PINNED_USERNAME });
    assert.deepEqual(await service.listRolesForMember(orgId, pinned.userId), ['admin']);
    // 再跑一次不应写第二条审计（旧 reconcileRole 每请求写库的毛病）。
    await service.ensureDeploymentGrant({ orgId, userId: pinned.userId, username: PINNED_USERNAME });
    assert.equal(await eventCount(orgId, pinned.userId), 1);
    // 名单外的人什么都不做。
    await service.ensureDeploymentGrant({
      orgId,
      userId: members.alice.userId,
      username: 'alice',
    });
    assert.deepEqual(await service.listRolesForMember(orgId, members.alice.userId), []);
  });

  it('成员列表带出角色、部署锁定与用户名', async () => {
    const { orgId, orgExternal, members } = await seed([PINNED_USERNAME, 'alice']);
    const admin = actor(orgExternal, members.alice.externalUserId, 'admin');
    await service.grantRole(admin, members.alice.userId, 'admin');
    await service.grantRole(admin, members.alice.userId, 'reviewer');
    await service.ensureDeploymentGrant({
      orgId,
      userId: members[PINNED_USERNAME].userId,
      username: PINNED_USERNAME,
    });

    const { members: rows } = await service.listMembers(admin, {});
    const byName = Object.fromEntries(rows.map((row) => [row.username, row]));
    assert.deepEqual(byName.alice.roles, ['admin', 'reviewer']);
    assert.deepEqual(byName.alice.pinned_roles, []);
    assert.deepEqual(byName[PINNED_USERNAME].pinned_roles, ['admin']);
    assert.equal(byName.alice.last_login_at !== null, true);

    // 按角色筛选与搜索都只命中预期的人。
    const admins = await service.listMembers(admin, { role: 'admin' });
    assert.equal(admins.members.length, 2);
    const reviewer = await service.listMembers(admin, { role: 'reviewer' });
    assert.deepEqual(reviewer.members.map((row) => row.username), ['alice']);
    const searched = await service.listMembers(admin, { q: PINNED_USERNAME });
    assert.deepEqual(searched.members.map((row) => row.username), [PINNED_USERNAME]);
    await assert.rejects(
      service.listMembers(admin, { role: 'root' }),
      (error) => error.code === 'ROLE_UNKNOWN',
    );
  });

  it('两个 admin 并发互相撤销：后提交的一方得到 409，最终至少剩一个 admin', async () => {
    const { orgId, orgExternal, members } = await seed(['alice', 'bob']);
    const aliceActor = actor(orgExternal, members.alice.externalUserId, 'admin');
    const bobActor = actor(orgExternal, members.bob.externalUserId, 'admin');
    await service.grantRole(aliceActor, members.alice.userId, 'admin');
    await service.grantRole(aliceActor, members.bob.userId, 'admin');
    assert.equal((await rolesOf(orgId, members.alice.userId)).length, 1);

    const results = await Promise.allSettled([
      service.revokeRole(aliceActor, members.bob.userId, 'admin'),
      service.revokeRole(bobActor, members.alice.userId, 'admin'),
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    assert.equal(fulfilled.length, 1, '恰好一方成功');
    assert.equal(rejected.length, 1, '恰好一方被拒');
    assert.equal(rejected[0].reason.code, 'LAST_ADMIN');
    assert.equal(rejected[0].reason.status, 409);

    // 不变量：org 里至少还有一个 admin——0 个 admin 是不可恢复的运维事故。
    const [row] = await knex('tbl_agsvc_member_roles')
      .where({ org_id: orgId, role: 'admin' })
      .count({ n: '*' });
    assert.equal(Number(row.n), 1);
  });

  it('数据迁移回填历史 admin：只迁已 provisioning 的，重跑幂等，且不写审计', async () => {
    const { orgId, orgExternal, members } = await seed(['legacy-admin', 'legacy-ghost', 'plain']);
    // legacy-admin：老的 auth_credentials.role = 'admin'，且已 provisioning。
    await knex('tbl_agsvc_auth_credentials')
      .where({ username: 'legacy-admin' })
      .update({ role: 'admin' });
    // legacy-ghost：老 admin 但**没有** users 行（没登录过）——不能被迁移，
    // 它会在首次登录时走环境变量引导（design §2.4 / §3）。
    await knex('tbl_agsvc_auth_credentials')
      .where({ username: 'legacy-ghost' })
      .update({ role: 'admin' });
    await knex('tbl_agsvc_organization_memberships')
      .where({ user_id: members['legacy-ghost'].userId })
      .del();
    await knex('tbl_agsvc_users').where({ user_id: members['legacy-ghost'].userId }).del();

    await backfillLegacyAdmins(knex);

    assert.deepEqual(await service.listRolesForMember(orgId, members['legacy-admin'].userId), ['admin']);
    assert.deepEqual(await service.listRolesForMember(orgId, members.plain.userId), []);
    const grants = await knex('tbl_agsvc_member_roles').where({ org_id: orgId });
    assert.equal(grants.length, 1);
    assert.equal(grants[0].source, 'migration');
    assert.equal(grants[0].granted_by, null);
    // 事件账本由本迁移创建：不为它存在之前的授予发明历史事件。
    assert.equal(await eventCount(orgId, members['legacy-admin'].userId), 0);

    // 重跑幂等（INSERT IGNORE 撞主键即跳过）。
    await backfillLegacyAdmins(knex);
    assert.equal((await knex('tbl_agsvc_member_roles').where({ org_id: orgId })).length, 1);
    // 回填出来的 admin 是**真实**授权：可以直接当调用者用。
    const legacyActor = actor(orgExternal, members['legacy-admin'].externalUserId, 'admin');
    await service.grantRole(legacyActor, members.plain.userId, 'reviewer');
    assert.deepEqual(await service.listRolesForMember(orgId, members.plain.userId), ['reviewer']);
  });

  it('角色变更记录带操作者与来源', async () => {
    const { orgExternal, members } = await seed(['alice', 'bob']);
    const admin = actor(orgExternal, members.alice.externalUserId, 'admin');
    await service.grantRole(admin, members.bob.userId, 'reviewer');
    await service.revokeRole(admin, members.bob.userId, 'reviewer');

    const { events } = await service.listRoleEvents(admin, members.bob.userId, {});
    assert.equal(events.length, 2);
    assert.deepEqual(events.map((e) => [e.action, e.role, e.source]), [
      ['revoke', 'reviewer', 'console'],
      ['grant', 'reviewer', 'console'],
    ]);
    assert.equal(events[0].actor_username, 'alice');
    assert.equal(events[0].actor_user_id, members.alice.userId);
  });
});
