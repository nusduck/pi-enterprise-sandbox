/**
 * 会话 / JWT / 活跃 principal 三个边界的单测（design sso-integration-reservation §5.2）。
 *
 * 真库上的会话撤销 CAS 与 owner 映射一致性由
 * `agent/tests/mysql/browser-auth-session.integration.test.js` 证明；这里只锁契约与
 * 失败语义（401 / 409 / 503 的分界）。
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

import { BrowserAuthError } from '../../src/application/browser-auth-errors.js';
import { BrowserSessionTokens } from '../../src/application/browser-session-tokens.js';
import { BrowserSessionService } from '../../src/application/browser-session-service.js';
import { ActivePrincipalService } from '../../src/application/active-principal-service.js';
import { memoryBrowserSessions, memoryIdentity } from '../support/memory-browser-auth.js';

const SECRET = 'session-secret-for-tests-0123456789';
const ORG_ID = '01M1ZRG0000000000000000000';
const USER_ID = '01M1ZSR0000000000000000000';
const NOW = new Date('2026-10-01T00:00:00Z');

function makeTokens(overrides: { secret?: string; now?: () => Date } = {}) {
  return new BrowserSessionTokens({
    secret: overrides.secret ?? SECRET,
    now: overrides.now ?? (() => NOW),
  });
}

function makeSessions(overrides: {
  tokens?: BrowserSessionTokens;
  store?: ReturnType<typeof memoryBrowserSessions>;
  now?: () => Date;
} = {}) {
  const store = overrides.store ?? memoryBrowserSessions();
  const tokens = overrides.tokens ?? makeTokens({ now: overrides.now });
  let counter = 0;
  const service = new BrowserSessionService({
    sessions: store,
    tokens,
    generateId: () => `01M1S3SS0000000000000000${(counter += 1)}`.slice(0, 26),
    now: overrides.now ?? (() => NOW),
  });
  return { service, store, tokens };
}

/** 手工造一个合法签名但缺 sid 的旧 JWT（`tokens.sign` 永远带 sid）。 */
function legacyToken(options: { secret?: string; sub?: string; expOffsetSeconds?: number } = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const iat = Math.floor(NOW.getTime() / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub: options.sub ?? 'user_legacy',
    iat,
    exp: iat + (options.expOffsetSeconds ?? 3600),
    iss: 'dsh-enterprise-sandbox',
    aud: 'dsh-enterprise-sandbox',
  })).toString('base64url');
  const signature = createHmac('sha256', options.secret ?? SECRET)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('BrowserSessionTokens', () => {
  it('signs and verifies a session token, exposing sub/sid/organization', () => {
    const tokens = makeTokens();
    const token = tokens.sign({
      sub: 'user_1',
      sid: '01M1S3SS00000000000000001',
      organizationId: 'org_bootstrap',
      ttlSeconds: 3600,
    });
    const verified = tokens.verify(token);
    assert.equal(verified.state, 'valid');
    if (verified.state !== 'valid') return;
    assert.equal(verified.token.sub, 'user_1');
    assert.equal(verified.token.sid, '01M1S3SS00000000000000001');
    assert.equal(verified.token.organizationId, 'org_bootstrap');
  });

  it('separates invalid signature from expiry and from a missing sid', () => {
    const tokens = makeTokens();
    const live = tokens.sign({ sub: 'u', sid: '01M1S3SS00000000000000001', ttlSeconds: 3600 });
    const [h, p, s] = live.split('.');
    assert.deepEqual(
      tokens.verify(`${h}.${p}.${s![0] === 'A' ? 'B' : 'A'}${s!.slice(1)}`),
      { state: 'invalid' },
    );
    assert.deepEqual(tokens.verify('not-a-jwt'), { state: 'invalid' });

    const expiredTokens = new BrowserSessionTokens({ secret: SECRET, now: () => new Date(NOW.getTime() + 7_200_000) });
    const expired = expiredTokens.verify(live);
    assert.equal(expired.state, 'expired');

    // 合法未到期但缺 sid：状态是 valid 但 sid 为 null（退出契约据此返回 409）。
    const sidLess = tokens.verify(legacyToken());
    assert.equal(sidLess.state, 'valid');
    if (sidLess.state !== 'valid') return;
    assert.equal(sidLess.token.sid, null);
  });

  it('rejects a token signed for another issuer/audience and fails closed without a secret', () => {
    const tokens = makeTokens();
    const foreignIssuer = new BrowserSessionTokens({
      secret: SECRET,
      issuer: 'other-issuer',
      now: () => NOW,
    });
    const token = foreignIssuer.sign({ sub: 'u', sid: 'sid', ttlSeconds: 3600 });
    assert.deepEqual(tokens.verify(token), { state: 'invalid' });

    const noSecret = new BrowserSessionTokens({ secret: '' });
    assert.throws(
      () => noSecret.verify(token),
      (error: any) => error instanceof BrowserAuthError && error.code === 'AUTH_CONFIG_UNAVAILABLE',
    );
    assert.throws(
      () => noSecret.sign({ sub: 'u', sid: 'sid', ttlSeconds: 1 }),
      (error: any) => error.code === 'AUTH_CONFIG_UNAVAILABLE',
    );
  });
});

describe('BrowserSessionService', () => {
  const issueInput = {
    userId: USER_ID,
    orgId: ORG_ID,
    externalUserId: 'user_1',
    externalOrgId: 'org_bootstrap',
    loginMethod: 'local',
    identityProvider: null,
    source: 'login' as const,
    ttlSeconds: 3600,
  };

  it('issues a session row and resolves the same sid, then revokes it', async () => {
    const { service, store } = makeSessions();
    const issued = await service.issue(issueInput);
    assert.equal(store.rows.size, 1);
    const resolved = await service.resolve(`Bearer ${issued.token}`);
    assert.equal(resolved.session.sessionId, issued.sessionId);
    assert.equal(resolved.session.userId, USER_ID);
    assert.equal(resolved.session.orgId, ORG_ID);

    assert.deepEqual(await service.revoke(`Bearer ${issued.token}`), { ok: true, revocation: 'confirmed' });
    assert.equal(Number(Boolean(store.rows.get(issued.sessionId)?.revokedAt)), 1);
    await assert.rejects(
      service.resolve(`Bearer ${issued.token}`),
      (error: any) => error.status === 401 && error.code === 'INVALID_TOKEN',
    );
    // 幂等：再次退出是 not_required，且不再写行。
    const before = store.rows.get(issued.sessionId)?.revokedAt;
    assert.deepEqual(await service.revoke(`Bearer ${issued.token}`), { ok: true, revocation: 'not_required' });
    assert.equal(store.rows.get(issued.sessionId)?.revokedAt, before);
  });

  it('keeps another sid of the same user valid', async () => {
    const { service } = makeSessions();
    const first = await service.issue(issueInput);
    const second = await service.issue({ ...issueInput, source: 'login' });
    await service.revoke(`Bearer ${first.token}`);
    await assert.rejects(service.resolve(`Bearer ${first.token}`), (e: any) => e.status === 401);
    await service.resolve(`Bearer ${second.token}`);
  });

  it('rejects no credentials, malformed tokens and sid-less legacy JWTs', async () => {
    const { service } = makeSessions();
    await assert.rejects(service.resolve(undefined), (e: any) => e.status === 401);
    await assert.rejects(service.resolve('Bearer forged'), (e: any) => e.status === 401);
    // 旧无 sid JWT：会话面统一 401，不建立兼容旁路。
    await assert.rejects(service.resolve(`Bearer ${legacyToken()}`), (e: any) => e.status === 401);
  });

  it('maps the logout contract to confirmed / not_required / 409 / 503', async () => {
    const { service, store } = makeSessions();
    // 无凭据永远 not_required。
    assert.deepEqual(await service.revoke(undefined), { ok: true, revocation: 'not_required' });
    // 无效签名不写库。
    assert.deepEqual(await service.revoke('Bearer forged'), { ok: true, revocation: 'not_required' });
    // 合法未到期缺 sid：409，不能声称撤销完成。
    await assert.rejects(
      service.revoke(`Bearer ${legacyToken()}`),
      (error: any) => error.status === 409 && error.code === 'LEGACY_SESSION_NOT_REVOCABLE',
    );
    // 合法签名但已到期：not_required。
    const expiredTokens = makeTokens({ now: () => new Date(NOW.getTime() + 7_200_000) });
    const { service: lateService } = makeSessions({ tokens: expiredTokens, now: () => new Date(NOW.getTime() + 7_200_000) });
    const live = await makeSessions().service.issue(issueInput);
    assert.deepEqual(await lateService.revoke(`Bearer ${live.token}`), { ok: true, revocation: 'not_required' });

    // 权威存储不可达：503，绝不 {ok:true}。
    const issued = await service.issue(issueInput);
    store.failNextGet = true;
    await assert.rejects(
      service.revoke(`Bearer ${issued.token}`),
      (error: any) => error.status === 503 && error.code === 'AUTH_REVOCATION_UNCONFIRMED',
    );
    store.failNextRevoke = true;
    await assert.rejects(
      service.revoke(`Bearer ${issued.token}`),
      (error: any) => error.status === 503 && error.code === 'AUTH_REVOCATION_UNCONFIRMED',
    );
    // 缺签名材料同样不能确认。
    const noSecret = new BrowserSessionService({
      sessions: store,
      tokens: new BrowserSessionTokens({ secret: '' }),
    });
    await assert.rejects(
      noSecret.revoke(`Bearer ${issued.token}`),
      (error: any) => error.status === 503 && error.code === 'AUTH_REVOCATION_UNCONFIRMED',
    );
  });

  it('rejects an expired session row and a drifted sid/owner binding', async () => {
    const { service, store } = makeSessions();
    const issued = await service.issue(issueInput);
    // 会话行到期（token 仍在有效期内）也必须拒绝。
    store.rows.get(issued.sessionId)!.expiresAt = new Date(NOW.getTime() - 1000).toISOString();
    await assert.rejects(service.resolve(`Bearer ${issued.token}`), (e: any) => e.status === 401);

    const drifted = await service.issue(issueInput);
    store.rows.get(drifted.sessionId)!.externalUserId = 'someone_else';
    await assert.rejects(service.resolve(`Bearer ${drifted.token}`), (e: any) => e.status === 401);
    // owner 漂移的会话不能通过退出被「确认撤销」。
    assert.deepEqual(await service.revoke(`Bearer ${drifted.token}`), { ok: true, revocation: 'not_required' });
  });

  it('binds the session to its issued external org for resolve and revoke', async () => {
    const { service, store } = makeSessions();
    const issued = await service.issue(issueInput);
    // JWT 里 organization_id 仍是签发时的 org；会话行的外部 org 被改掉后，
    // 解析必须 401，退出也不能撤销这个「已经不属于该 org」的 sid。
    store.rows.get(issued.sessionId)!.externalOrgId = 'attacker-org';
    await assert.rejects(service.resolve(`Bearer ${issued.token}`), (e: any) => e.status === 401);
    assert.deepEqual(await service.revoke(`Bearer ${issued.token}`), { ok: true, revocation: 'not_required' });
    assert.equal(store.rows.get(issued.sessionId)!.revokedAt, null, 'no revoke write on an org mismatch');
  });

  it('returns 503 when loading the session row fails', async () => {
    const { service, store } = makeSessions();
    const issued = await service.issue(issueInput);
    store.failNextGet = true;
    await assert.rejects(
      service.resolve(`Bearer ${issued.token}`),
      (error: any) => error.status === 503 && error.code === 'AUTH_STORE_UNAVAILABLE',
    );
  });
});

describe('ActivePrincipalService', () => {
  const base = {
    orgId: ORG_ID,
    userId: USER_ID,
    externalUserId: 'user_1',
    externalOrgId: 'org_bootstrap',
  };

  function seed() {
    const identity = memoryIdentity();
    identity.orgRefs.set('org_bootstrap', ORG_ID);
    // 造一个与 state 对齐的 active 用户/组织/Membership。
    identity.usersById.set(USER_ID, {
      userId: USER_ID,
      externalSubject: 'bff:user_1',
      status: 'active',
    });
    identity.usersBySubject.set('bff:user_1', identity.usersById.get(USER_ID));
    identity.orgs.set(ORG_ID, { orgId: ORG_ID, name: 'org', status: 'active' });
    identity.memberships.set(`${ORG_ID}/${USER_ID}`, {
      orgId: ORG_ID,
      userId: USER_ID,
      role: 'member',
      status: 'active',
    });
    return identity;
  }

  it('accepts a fully active principal and rejects inactive status or drifted mapping', async () => {
    const identity = seed();
    const service = new ActivePrincipalService({
      organizations: identity.organizations,
      externalRefs: identity.externalRefs,
    });
    assert.deepEqual(await service.resolveActive(base), { orgId: ORG_ID, userId: USER_ID });

    identity.usersById.get(USER_ID)!.status = 'disabled';
    await assert.rejects(service.resolveActive(base), (e: any) => e.status === 401);
    identity.usersById.get(USER_ID)!.status = 'active';

    identity.orgs.get(ORG_ID)!.status = 'disabled';
    await assert.rejects(service.resolveActive(base), (e: any) => e.status === 401);
    identity.orgs.get(ORG_ID)!.status = 'active';

    identity.memberships.get(`${ORG_ID}/${USER_ID}`)!.status = 'disabled';
    await assert.rejects(service.resolveActive(base), (e: any) => e.status === 401);
    identity.memberships.get(`${ORG_ID}/${USER_ID}`)!.status = 'active';

    // 外部映射被改到别的用户/组织：同一个 sid 不能再授权。
    identity.usersById.get(USER_ID)!.externalSubject = 'bff:someone_else';
    await assert.rejects(service.resolveActive(base), (e: any) => e.status === 401);
    identity.usersById.get(USER_ID)!.externalSubject = 'bff:user_1';
    identity.orgRefs.set('org_bootstrap', '01M1ZRG0000000000000000001');
    await assert.rejects(service.resolveActive(base), (e: any) => e.status === 401);
  });

  it('returns 503 when the authoritative store throws, and 401 for a non-ULID owner', async () => {
    const identity = seed();
    const service = new ActivePrincipalService({
      organizations: identity.organizations,
      externalRefs: identity.externalRefs,
    });
    await assert.rejects(
      service.resolveActive({ ...base, userId: 'not-a-ulid' }),
      (e: any) => e.status === 401,
    );
    identity.organizations.getMembership = async () => {
      throw new Error('db down');
    };
    await assert.rejects(
      service.resolveActive(base),
      (error: any) => error.status === 503 && error.code === 'AUTH_STORE_UNAVAILABLE',
    );
  });
});
