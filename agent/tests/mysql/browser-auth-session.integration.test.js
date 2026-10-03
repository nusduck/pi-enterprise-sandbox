/**
 * 可撤销浏览器会话的真实 MySQL 门禁（design sso-integration-reservation §5.2）。
 *
 * 这里跑的是**真表、真唯一约束、真撤销写入**：会话行、内部 owner 与外部兼容映射
 * 的一致性、撤销后同 JWT 401、另一个 sid 不受影响，都必须在数据库上证明；内存替身
 * 无法证明列/外键/更新的真实语义。
 *
 * Requires TEST_MYSQL_URL=mysql://…；缺配置时整组跳过。**必须是专用库**：它会清空
 * 会话、身份映射与凭据表。
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
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
const SECRET = 'b'.repeat(32);

/** 解出 JWT 载荷（不验签；验签由被测服务负责）。 */
function decodePayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** 合法未到期、缺 sid 的旧 JWT。 */
function legacyToken({ sub = 'user_legacy', expOffsetSeconds = 3600 } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    iat,
    exp: iat + expOffsetSeconds,
    iss: 'dsh-enterprise-sandbox',
    aud: 'dsh-enterprise-sandbox',
  })).toString('base64url');
  const signature = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('browser auth session integration gate', () => {
  it('documents skip when TEST_MYSQL_URL / deps missing', () => {
    assert.equal(typeof runLive, 'boolean');
  });
});

describeLive('browser auth sessions (TEST_MYSQL_URL)', () => {
  let knex;
  let ulid;
  let createRepositoryBundle;
  let BrowserAuthService;

  before(async () => {
    ({ ulid } = await import('../../src/domain/shared/ulid.js'));
    ({ createRepositoryBundle } = await import('../../src/bootstrap/container-env.js'));
    ({ BrowserAuthService } = await import('../../src/application/browser-auth-service.js'));
    const mysql = await import('../../src/infrastructure/mysql/index.js');
    knex = mysql.createMysqlKnex(TEST_MYSQL_URL, { pool: { min: 0, max: 8 } });
    await mysql.migrateLatest(knex);
  });

  after(async () => {
    if (knex) await knex.destroy();
  });

  beforeEach(async () => {
    // 专用库：按外键顺序清干净，让每条用例看到同一个起点。
    for (const table of [
      'tbl_agsvc_browser_auth_sessions',
      'tbl_agsvc_member_role_events',
      'tbl_agsvc_member_roles',
      'tbl_agsvc_organization_memberships',
      'tbl_agsvc_organization_external_refs',
      'tbl_agsvc_auth_credentials',
      'tbl_agsvc_users',
      'tbl_agsvc_organizations',
    ]) {
      await knex(table).del();
    }
  });

  /** 真实仓储 + 真实会话账本的 BrowserAuthService。 */
  function makeService() {
    const repos = createRepositoryBundle(knex, { generateId: () => ulid() });
    const service = new BrowserAuthService({
      credentials: repos.authCredentials,
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
      sessions: repos.browserAuthSessions,
      generateId: () => ulid(),
      secret: SECRET,
    });
    return { repos, service };
  }

  it('persists a sid session on register/login and rejects replay after revoke', async () => {
    const { service } = makeService();
    const registered = await service.register({ username: 'alice', password: 'password123' });
    const claims = decodePayload(registered.token);
    assert.ok(claims.sid, 'JWT carries a sid');

    const row = await knex('tbl_agsvc_browser_auth_sessions')
      .where({ session_id: claims.sid })
      .first();
    assert.ok(row, 'session row is written');
    assert.equal(row.login_method, 'local');
    assert.equal(row.source, 'register');
    assert.equal(row.identity_provider, null);
    assert.equal(row.external_user_id, registered.user.id);
    assert.ok(row.org_id && row.user_id, 'internal owner ids are stored');

    const me = await service.me(`Bearer ${registered.token}`);
    assert.equal(me.username, 'alice');
    assert.equal(me.login_method, 'local');
    assert.equal(me.identity_provider, null);

    assert.deepEqual(await service.logout(`Bearer ${registered.token}`), {
      ok: true,
      revocation: 'confirmed',
    });
    const revoked = await knex('tbl_agsvc_browser_auth_sessions')
      .where({ session_id: claims.sid })
      .first();
    assert.ok(revoked.revoked_at, 'revoked_at is persisted');
    await assert.rejects(
      service.me(`Bearer ${registered.token}`),
      (error) => error.status === 401,
    );
    assert.deepEqual(await service.logout(`Bearer ${registered.token}`), {
      ok: true,
      revocation: 'not_required',
    });

    // 重新登录拿到新 sid；旧 sid 不影响它。
    const again = await service.login({ username: 'alice', password: 'password123' });
    assert.notEqual(decodePayload(again.token).sid, claims.sid);
    assert.equal((await service.me(`Bearer ${again.token}`)).username, 'alice');
  });

  it('revokes only the current sid; another sid of the same user stays valid', async () => {
    const { service } = makeService();
    await service.register({ username: 'bob', password: 'password123' });
    const a = await service.login({ username: 'bob', password: 'password123' });
    const b = await service.login({ username: 'bob', password: 'password123' });
    assert.notEqual(decodePayload(a.token).sid, decodePayload(b.token).sid);

    await service.logout(`Bearer ${a.token}`);
    await assert.rejects(service.me(`Bearer ${a.token}`), (error) => error.status === 401);
    assert.equal((await service.me(`Bearer ${b.token}`)).username, 'bob');
  });

  it('rejects a sid whose active user/org/Membership or owner mapping no longer holds', async () => {
    const { service } = makeService();
    const registered = await service.register({ username: 'carol', password: 'password123' });
    const claims = decodePayload(registered.token);
    const session = await knex('tbl_agsvc_browser_auth_sessions')
      .where({ session_id: claims.sid })
      .first();

    // Membership 停用：下一个请求 401，恢复后又能用。
    await knex('tbl_agsvc_organization_memberships')
      .where({ org_id: session.org_id, user_id: session.user_id })
      .update({ status: 'disabled' });
    await assert.rejects(service.me(`Bearer ${registered.token}`), (error) => error.status === 401);
    await knex('tbl_agsvc_organization_memberships')
      .where({ org_id: session.org_id, user_id: session.user_id })
      .update({ status: 'active' });
    assert.equal((await service.me(`Bearer ${registered.token}`)).username, 'carol');

    // 用户停用：同样 401。
    await knex('tbl_agsvc_users').where({ user_id: session.user_id }).update({ status: 'disabled' });
    await assert.rejects(service.me(`Bearer ${registered.token}`), (error) => error.status === 401);
    await knex('tbl_agsvc_users').where({ user_id: session.user_id }).update({ status: 'active' });

    // 外部映射被改到别的 org：sid 的 owner 漂移，401。
    const otherOrgId = ulid();
    await knex('tbl_agsvc_organizations').insert({
      org_id: otherOrgId,
      name: 'other-org',
      status: 'active',
      created_at: knex.fn.now(3),
      updated_at: knex.fn.now(3),
    });
    await knex('tbl_agsvc_organization_external_refs')
      .where({ provider: 'bff', external_subject: 'org_bootstrap' })
      .update({ org_id: otherOrgId });
    await assert.rejects(service.me(`Bearer ${registered.token}`), (error) => error.status === 401);
  });

  it('rejects a valid unexpired legacy JWT as an ordinary invalid session', async () => {
    const { service } = makeService();
    await assert.rejects(
      service.logout(`Bearer ${legacyToken()}`),
      (error) => error.status === 401 && error.code === 'INVALID_TOKEN',
    );
    // 旧 JWT 也不能当有效会话。
    await assert.rejects(service.me(`Bearer ${legacyToken()}`), (error) => error.status === 401);
  });
});
