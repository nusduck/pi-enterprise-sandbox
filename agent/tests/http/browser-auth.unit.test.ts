import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  BrowserAuthError,
  BrowserAuthService,
  hashPassword,
  verifyPassword,
} from '../../src/application/browser-auth-service.js';
import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { memoryBrowserSessions, memoryIdentity } from '../support/memory-browser-auth.js';

/** 合法 ULID（Crockford 无 I/L/O/U），让活跃准入的 `isUlid` 校验能通过。 */
const GEN_ID = '01M1G3NJD00000000000000000';

function memoryCredentials() {
  const rows = new Map<string, any>();
  return {
    rows,
    async create(input: any) {
      const row = {
        id: input.externalUserId,
        username: input.username,
        passwordHash: input.passwordHash,
        email: input.email,
        displayName: input.displayName || input.username,
        role: input.role,
        organizationId: input.externalOrgId,
        isActive: true,
      };
      rows.set(row.username.toLowerCase(), row);
      return row;
    },
    async getByUsername(username: string) {
      return rows.get(username.toLowerCase()) || null;
    },
    async getByExternalUserId(id: string) {
      return [...rows.values()].find((row) => row.id === id) || null;
    },
    async setRole(id: string, role: string) {
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      if (row) row.role = role;
    },
    async touchLogin() {},
    profileWrites: [] as any[],
    notify: new Map<string, boolean>(),
    prefs: new Map<string, any>(),
    async updateProfile(id: string, subject: string, patch: any) {
      this.profileWrites.push({ id, subject, patch });
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      if (row) {
        if (patch.displayName !== undefined) row.displayName = patch.displayName;
        if (patch.email !== undefined) row.email = patch.email;
      }
      if (patch.notifyRunComplete !== undefined) this.notify.set(subject, patch.notifyRunComplete);
      const prev = this.prefs.get(subject) ?? {};
      const next = { ...prev };
      for (const key of ['notifyRunComplete', 'notifyReviewResult', 'notifyReviewPending', 'notifyRunWaiting']) {
        if (patch[key] !== undefined) next[key] = patch[key];
      }
      this.prefs.set(subject, next);
      return row || null;
    },
    async getNotifyRunComplete(subject: string) {
      return this.notify.get(subject) ?? false;
    },
    async getNotificationPrefs(subject: string) {
      const stored = this.prefs.get(subject) ?? {};
      return {
        notifyRunComplete: this.notify.get(subject) ?? false,
        notifyReviewResult: stored.notifyReviewResult ?? true,
        notifyReviewPending: stored.notifyReviewPending ?? true,
        notifyRunWaiting: stored.notifyRunWaiting ?? true,
      };
    },
  };
}

/**
 * 角色账本的最小替身（`MemberRolePort`）。
 *
 * 角色权威在 `tbl_agsvc_member_roles`，不在 credential 上；这些用例只关心
 * 「凭据 ↔ 内部身份 ↔ 角色集合」这条链的形状，所以账本用内存实现。
 * `pinned` 模拟 `SANDBOX_AUTH_ADMIN_USERNAMES` 的引导（只授予、不降级）。
 */
function memoryMemberRoles(pinned: string[] = []) {
  const pinSet = new Set(pinned.map((name) => name.trim().toLowerCase()));
  const grants = new Map<string, Set<string>>();
  const key = (orgId: string, userId: string) => `${orgId}/${userId}`;
  return {
    pinSet,
    grants,
    key,
    async listRolesForMember(orgId: string, userId: string) {
      return [...(grants.get(key(orgId, userId)) ?? [])];
    },
    async ensureDeploymentGrant({ orgId, userId, username }: any) {
      if (!pinSet.has(String(username || '').trim().toLowerCase())) return;
      const set = grants.get(key(orgId, userId)) ?? new Set<string>();
      set.add('admin');
      grants.set(key(orgId, userId), set);
    },
  };
}

/** 构造一个带会话账本与活跃身份替身的服务。 */
function makeService(overrides: {
  credentials?: ReturnType<typeof memoryCredentials>;
  identity?: ReturnType<typeof memoryIdentity>;
  memberRoles?: ReturnType<typeof memoryMemberRoles>;
  sessions?: ReturnType<typeof memoryBrowserSessions>;
  now?: () => Date;
  generateId?: () => string;
  allowPublicRegister?: boolean;
} = {}) {
  const credentials = overrides.credentials ?? memoryCredentials();
  const identity = overrides.identity ?? memoryIdentity();
  const sessions = overrides.sessions ?? memoryBrowserSessions();
  const service = new BrowserAuthService({
    credentials,
    organizations: identity.organizations,
    externalRefs: identity.externalRefs,
    memberRoles: overrides.memberRoles,
    sessions,
    generateId: overrides.generateId,
    secret: 'a'.repeat(32),
    now: overrides.now,
    allowPublicRegister: overrides.allowPublicRegister,
  });
  return { service, credentials, identity, sessions };
}

describe('BrowserAuthService', () => {
  it('hashes passwords and rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse');
    assert.equal(await verifyPassword('correct horse', stored), true);
    assert.equal(await verifyPassword('wrong horse', stored), false);
    assert.equal(await verifyPassword('correct horse', 'broken'), false);
  });

  it('registers, logs in, verifies sessions, and bootstraps deployment roles', async () => {
    const now = new Date('2026-09-01T00:00:00Z');
    const { service, sessions, identity } = makeService({
      memberRoles: memoryMemberRoles(['alice']),
      now: () => now,
    });
    const registered: any = await service.register({
      username: 'alice',
      password: 'secret1',
      organization_id: 'attacker-org',
    });
    assert.equal(registered.user.organization_id, 'org_bootstrap');
    assert.equal(registered.user.role, 'admin');
    assert.deepEqual(registered.user.roles, ['admin']);
    assert.equal(registered.user.login_method, 'local');
    assert.equal(registered.user.identity_provider, null);

    // 会话落到了权威账本，且带内部 owner 与外部兼容映射。
    assert.equal(sessions.rows.size, 1);
    const [record] = [...sessions.rows.values()];
    assert.equal(record.loginMethod, 'local');
    assert.equal(record.source, 'register');
    assert.equal(record.externalUserId, registered.user.id);
    assert.equal(record.externalOrgId, 'org_bootstrap');
    assert.ok(record.userId && record.orgId, 'session keeps internal owner ids');

    const me: any = await service.me(`Bearer ${registered.token}`);
    assert.equal(me.username, 'alice');
    assert.deepEqual(me.roles, ['admin']);
    assert.equal(me.login_method, 'local');

    // 签名被改必须 401（改签名段首字符；尾字符只带 4 个有效位，可能仍解出同串字节）。
    const [header, payload, signature] = registered.token.split('.');
    const alteredToken = `${header}.${payload}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    assert.notEqual(alteredToken, registered.token);
    await assert.rejects(
      service.me(`Bearer ${alteredToken}`),
      (error: any) => error instanceof BrowserAuthError && error.status === 401,
    );
    await assert.rejects(
      service.login({ username: 'alice', password: 'bad' }),
      (error: any) => error instanceof BrowserAuthError && error.code === 'INVALID_CREDENTIALS',
    );
    assert.equal(identity.counters.createdUsers, 1);
  });

  it('fails closed without signing material', async () => {
    const service = new BrowserAuthService({
      credentials: memoryCredentials(),
      sessions: memoryBrowserSessions(),
      secret: '',
    });
    await assert.rejects(
      service.register({ username: 'alice', password: 'secret1' }),
      (error: any) => error.code === 'AUTH_CONFIG_UNAVAILABLE' && error.status === 503,
    );
  });

  it('fails closed without the session ledger instead of issuing a sid-less token', async () => {
    const service = new BrowserAuthService({
      credentials: memoryCredentials(),
      secret: 'a'.repeat(32),
    });
    await assert.rejects(
      service.register({ username: 'alice', password: 'secret1' }),
      (error: any) => error.code === 'AUTH_STORE_UNAVAILABLE' && error.status === 503,
    );
  });

  it('provisions user and membership into tbl_agsvc_organizations on register and login', async () => {
    const { service, identity } = makeService({ generateId: () => GEN_ID });
    await service.register({ username: 'bob', password: 'password123' });
    assert.equal(identity.counters.createdUsers, 1);
    assert.equal(identity.createdUserInputs[0].displayName, 'bob');
    assert.equal(identity.counters.membershipWrites, 1);
    // 成员关系的 role 已收窄为「成员类型」，角色权威是 member_roles（design §2.3）。
    assert.equal(identity.createdMembershipInputs[0].role, 'member');

    await service.login({ username: 'bob', password: 'password123' });
    // 第二次登录重新对账：membership 调用再来一次，但用户不重复创建。
    assert.equal(identity.counters.membershipWrites, 2);
    assert.equal(identity.counters.createdUsers, 1);
  });

  it('me() 不重放 provisioning，但每次都核对活跃 user/org/Membership', async () => {
    const { service, identity } = makeService({ generateId: () => GEN_ID });
    const registered: any = await service.register({ username: 'carol', password: 'password123' });
    const after = {
      createdUsers: identity.counters.createdUsers,
      membershipWrites: identity.counters.membershipWrites,
    };

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await service.me(`Bearer ${registered.token}`) as any).username, 'carol');
    }
    // 身份补建不再每请求重放（缓存没了，但 me 走会话行里的 owner）。
    assert.equal(identity.counters.createdUsers, after.createdUsers);
    assert.equal(identity.counters.membershipWrites, after.membershipWrites);
    // 但权威状态每请求都读：用户、组织、Membership、外部映射至少各 5 次。
    assert.ok(identity.counters.userReads >= 5, 'active user is re-read');
    assert.ok(identity.counters.orgReads >= 5, 'active org is re-read');
    assert.ok(identity.counters.membershipReads >= 5, 'active membership is re-read');
    assert.ok(identity.counters.orgRefLookups >= 5, 'owner mapping is re-checked');
  });
});

/**
 * 回归（review）：login/register 必须在**签发会话与引导 admin 之前**做活跃准入。
 *
 * 修复前 `establishLocalSession` 只做 provisioning 就直接
 * `rolesForIdentity`（含 `ensureDeploymentGrant` 引导 admin）+ `issue`，所以被停用
 * 的 user/org/Membership 仍会拿到 200 + sid，甚至在被停用主体上写出 admin 授予。
 * 这里锁住：停用主体 401、无新会话、无新授予；活跃主体仍成功；register 走同一准入。
 */
describe('BrowserAuthService — active admission before session issuance', () => {
  const ORG_ID = '01M1ZRG0000000000000000000';
  const USER_ID = '01M1ZSR0000000000000000000';
  const PASSWORD = 'password123';

  /** 预置一套 active 的 org/user/Membership + 一个可 login 的密码凭据。 */
  async function seedActivePrincipal(
    credentials: ReturnType<typeof memoryCredentials>,
    identity: ReturnType<typeof memoryIdentity>,
    username: string,
    externalUserId = 'user_1',
  ) {
    identity.orgRefs.set('org_bootstrap', ORG_ID);
    identity.orgs.set(ORG_ID, { orgId: ORG_ID, name: 'org', status: 'active' });
    identity.usersById.set(USER_ID, {
      userId: USER_ID,
      externalSubject: `bff:${externalUserId}`,
      status: 'active',
    });
    identity.usersBySubject.set(`bff:${externalUserId}`, identity.usersById.get(USER_ID));
    identity.memberships.set(`${ORG_ID}/${USER_ID}`, {
      orgId: ORG_ID,
      userId: USER_ID,
      role: 'member',
      status: 'active',
    });
    return credentials.create({
      username,
      passwordHash: await hashPassword(PASSWORD),
      externalUserId,
      externalOrgId: 'org_bootstrap',
      email: null,
      displayName: username,
      role: 'user',
    });
  }

  for (const [label, disable] of [
    ['disabled user', (identity: ReturnType<typeof memoryIdentity>) => {
      identity.usersById.get(USER_ID)!.status = 'disabled';
    }],
    ['disabled organisation', (identity: ReturnType<typeof memoryIdentity>) => {
      identity.orgs.get(ORG_ID)!.status = 'disabled';
    }],
    ['disabled Membership', (identity: ReturnType<typeof memoryIdentity>) => {
      identity.memberships.get(`${ORG_ID}/${USER_ID}`)!.status = 'disabled';
    }],
  ] as const) {
    it(`rejects login for a ${label} with no session and no deployment grant`, async () => {
      const memberRoles = memoryMemberRoles(['alice']);
      const { service, credentials, identity, sessions } = makeService({ memberRoles });
      await seedActivePrincipal(credentials, identity, 'alice');
      disable(identity);
      assert.equal(memberRoles.grants.size, 0, 'precondition: nothing granted yet');

      await assert.rejects(
        service.login({ username: 'alice', password: PASSWORD }),
        (error: any) => error.status === 401 && error.code === 'INVALID_TOKEN',
      );
      assert.equal(sessions.rows.size, 0, 'no sid may be issued for a disabled principal');
      assert.equal(memberRoles.grants.size, 0, 'no admin may be bootstrapped on a disabled principal');
    });
  }

  it('still issues a session for a fully active principal', async () => {
    const { service, credentials, identity, sessions } = makeService();
    await seedActivePrincipal(credentials, identity, 'frank');
    const result: any = await service.login({ username: 'frank', password: PASSWORD });
    assert.ok(result.token);
    assert.equal(sessions.rows.size, 1);
  });

  it('applies the same admission to register after provisioning', async () => {
    const memberRoles = memoryMemberRoles(['newbie']);
    const { service, identity, sessions } = makeService({ memberRoles });
    // 预置外部组织映射到一个已停用的内部 org：provisioning 会补建用户/Membership，
    // 准入必须看到停用 org 并拒绝，而不是先引导 admin 再签发。
    identity.orgRefs.set('org_bootstrap', ORG_ID);
    identity.orgs.set(ORG_ID, { orgId: ORG_ID, name: 'org', status: 'disabled' });

    await assert.rejects(
      service.register({ username: 'newbie', password: PASSWORD }),
      (error: any) => error.status === 401,
    );
    assert.equal(sessions.rows.size, 0);
    assert.equal(memberRoles.grants.size, 0);
  });

  it('rejects a session when the credential org no longer matches the session-fixed org', async () => {
    const { service, credentials, identity, sessions } = makeService();
    const registered: any = await service.register({ username: 'erin', password: PASSWORD });
    const [{ orgId }] = [...sessions.rows.values()] as any[];
    // 另一个外部 org 依旧映射到同一个内部 org：修复前 `authenticated` 传的是当前
    // credential 的 org，于是会话固定 org 被悄悄换掉仍能通过。
    identity.orgRefs.set('attacker-org', orgId);
    credentials.rows.get('erin')!.organizationId = 'attacker-org';

    await assert.rejects(
      service.me(`Bearer ${registered.token}`),
      (error: any) => error.status === 401 && error.code === 'INVALID_TOKEN',
    );
  });
});

describe('BrowserAuthService — own profile', () => {
  async function setup(notificationCapability?: { available: boolean; min_run_duration_ms: number | null }) {
    const credentials = memoryCredentials();
    const identity = memoryIdentity();
    // 预置 org 映射：profile 的 organization_name 来自 organizations.name。
    identity.orgRefs.set('org_bootstrap', identity.state.orgId);
    const service = new BrowserAuthService({
      credentials,
      organizations: identity.organizations,
      externalRefs: identity.externalRefs,
      sessions: memoryBrowserSessions(),
      notificationCapability,
      secret: 'a'.repeat(32),
    });
    const { token }: any = await service.register({ username: 'dora', password: 'password123' });
    return { service, credentials, identity, auth: `Bearer ${token}` };
  }

  it('shows organisation, status, login source and the editable fields', async () => {
    const { service, auth } = await setup();
    const profile: any = await service.profile(auth);
    assert.equal(profile.username, 'dora');
    assert.equal(profile.organization_name, '华东销售部');
    assert.equal(profile.status, 'active');
    assert.equal(profile.login_method, 'local');
    assert.equal(profile.identity_provider, null);
    assert.deepEqual(profile.editable_fields, [
      'display_name',
      'email',
      'notify_run_complete',
      'notify_review_result',
      'notify_review_pending',
      'notify_run_waiting',
    ]);
    assert.equal(profile.notify_run_complete, false);
    // 新开关默认开（与迁移回填一致），旧开关默认关。
    assert.equal(profile.notify_review_result, true);
    assert.equal(profile.notify_review_pending, true);
    assert.equal(profile.notify_run_waiting, true);
    assert.deepEqual(profile.notifications, { email: { available: false, min_run_duration_ms: null } });
  });

  it('turns run-completion email on and off when the deployment supports it', async () => {
    const { service, credentials, auth } = await setup({ available: true, min_run_duration_ms: 300_000 });
    const on: any = await service.updateProfile(auth, { email: 'dora@example.com', notify_run_complete: true });
    assert.equal(on.notify_run_complete, true);
    assert.deepEqual(on.notifications.email, { available: true, min_run_duration_ms: 300_000 });
    assert.deepEqual(credentials.profileWrites[0].patch, { email: 'dora@example.com', notifyRunComplete: true });
    await assert.rejects(
      service.updateProfile(auth, { email: '' }),
      (error: any) => error instanceof BrowserAuthError && error.code === 'NOTIFY_EMAIL_REQUIRED',
      'the address cannot be cleared while notification is on',
    );
    const off: any = await service.updateProfile(auth, { notify_run_complete: false });
    assert.equal(off.notify_run_complete, false);
    assert.equal((await service.profile(auth) as any).notify_run_complete, false);
    // Clearing in one request is fine when run_complete goes off in the same request.
    await service.updateProfile(auth, { notify_run_complete: true });
    const cleared: any = await service.updateProfile(auth, {
      email: '',
      notify_run_complete: false,
      notify_review_result: false,
      notify_review_pending: false,
      notify_run_waiting: false,
    });
    assert.equal(cleared.email, null);
    assert.equal(cleared.notify_run_complete, false);
  });

  it('refuses to turn run-completion email on when it could never be delivered', async () => {
    const code = (c: string) => (error: any) => error instanceof BrowserAuthError && error.code === c;
    const unavailable = await setup();
    await unavailable.service.updateProfile(unavailable.auth, { email: 'dora@example.com' });
    await assert.rejects(
      unavailable.service.updateProfile(unavailable.auth, { notify_run_complete: true }),
      code('NOTIFICATION_UNAVAILABLE'),
    );
    // Turning it off is always allowed, even without the capability.
    await unavailable.service.updateProfile(unavailable.auth, { notify_run_complete: false });

    const noEmail = await setup({ available: true, min_run_duration_ms: 0 });
    await assert.rejects(
      noEmail.service.updateProfile(noEmail.auth, { notify_run_complete: true }),
      code('NOTIFY_EMAIL_REQUIRED'),
    );
    await assert.rejects(
      noEmail.service.updateProfile(noEmail.auth, { email: '', notify_run_complete: true }),
      code('NOTIFY_EMAIL_REQUIRED'),
    );
    await assert.rejects(
      noEmail.service.updateProfile(noEmail.auth, { notify_run_complete: 'yes' }),
      code('AUTH_INPUT_INVALID'),
    );
    assert.equal(noEmail.credentials.profileWrites.length, 0, 'nothing is written on a refused request');
  });

  it('turns the three new notification switches on and off with the same guards', async () => {
    const status = (s: number, c: string) => (error: any) =>
      error instanceof BrowserAuthError && error.status === s && error.code === c;
    const { service, credentials, auth } = await setup({ available: true, min_run_duration_ms: 0 });
    const on: any = await service.updateProfile(auth, {
      email: 'dora@example.com',
      notify_review_result: true,
      notify_review_pending: false,
      notify_run_waiting: true,
    });
    assert.equal(on.notify_review_result, true);
    assert.equal(on.notify_review_pending, false);
    assert.equal(on.notify_run_waiting, true);
    assert.deepEqual(credentials.profileWrites[0].patch, {
      email: 'dora@example.com',
      notifyReviewResult: true,
      notifyReviewPending: false,
      notifyRunWaiting: true,
    });
    // 四个开关类型不是布尔一律 → 422 AUTH_INPUT_INVALID（消息里带字段名）。
    await assert.rejects(
      service.updateProfile(auth, { notify_review_result: 'yes' }),
      status(422, 'AUTH_INPUT_INVALID'),
    );
    await assert.rejects(
      service.updateProfile(auth, { notify_run_waiting: 1 }),
      status(422, 'AUTH_INPUT_INVALID'),
    );
    // 三个默认开关为开时清空邮箱成功：只拦 notify_run_complete。
    await service.updateProfile(auth, { notify_review_result: true });
    const clearedNew: any = await service.updateProfile(auth, { email: '' });
    assert.equal(clearedNew.email, null);
    // 对照：notify_run_complete 为开时清空邮箱仍 422。
    await service.updateProfile(auth, { email: 'dora@example.com', notify_run_complete: true });
    await assert.rejects(
      service.updateProfile(auth, { email: '' }),
      status(422, 'NOTIFY_EMAIL_REQUIRED'),
    );
    const cleared: any = await service.updateProfile(auth, {
      email: '',
      notify_run_complete: false,
    });
    assert.equal(cleared.email, null);
    assert.equal(cleared.notify_run_complete, false);
  });

  it('refuses the new switches when mail is unavailable or the address is missing', async () => {
    const code = (c: string) => (error: any) => error instanceof BrowserAuthError && error.code === c;
    const unavailable = await setup();
    await unavailable.service.updateProfile(unavailable.auth, { email: 'dora@example.com' });
    await assert.rejects(
      unavailable.service.updateProfile(unavailable.auth, { notify_review_pending: true }),
      code('NOTIFICATION_UNAVAILABLE'),
    );
    await unavailable.service.updateProfile(unavailable.auth, { notify_review_pending: false });

    const noEmail = await setup({ available: true, min_run_duration_ms: 0 });
    await assert.rejects(
      noEmail.service.updateProfile(noEmail.auth, { notify_run_waiting: true }),
      code('NOTIFY_EMAIL_REQUIRED'),
    );
  });

  it('updates display name and email in both identity stores', async () => {
    const { service, credentials, auth } = await setup();
    const updated: any = await service.updateProfile(auth, { display_name: '  多拉 ', email: 'dora@example.com' });
    assert.equal(updated.display_name, '多拉');
    assert.equal(updated.email, 'dora@example.com');
    const [write] = credentials.profileWrites;
    assert.equal(write.subject, `bff:${write.id}`, 'users row is addressed by its external subject');
    assert.deepEqual(write.patch, { displayName: '多拉', email: 'dora@example.com' });
    // 三个新开关默认开也不拦清空（只看 notify_run_complete，默认关）；其他字段不受影响。
    const cleared: any = await service.updateProfile(auth, { email: '' });
    assert.equal(cleared.email, null);
    assert.equal(cleared.display_name, '多拉');
    assert.deepEqual(credentials.profileWrites[1].patch, { email: null });
  });

  it('refuses fields the user may not change, bad values and anonymous callers', async () => {
    const { service, credentials, auth } = await setup();
    const code = (c: string) => (error: any) => error instanceof BrowserAuthError && error.code === c;
    await assert.rejects(service.updateProfile(auth, { role: 'admin' }), code('PROFILE_FIELD_NOT_EDITABLE'));
    await assert.rejects(service.updateProfile(auth, { display_name: 'x', organization_id: 'other' }), code('PROFILE_FIELD_NOT_EDITABLE'));
    await assert.rejects(service.updateProfile(auth, { email: 'not-an-email' }), code('AUTH_INPUT_INVALID'));
    await assert.rejects(service.updateProfile(auth, { display_name: '   ' }), code('AUTH_INPUT_INVALID'));
    await assert.rejects(service.updateProfile(auth, {}), code('AUTH_INPUT_INVALID'));
    await assert.rejects(service.updateProfile('Bearer forged', { display_name: 'x' }), code('INVALID_TOKEN'));
    assert.equal(credentials.profileWrites.length, 0, 'nothing is written on a refused request');
  });

  it('rejects a token after its session is revoked', async () => {
    const { service, auth } = await setup();
    assert.equal((await service.profile(auth) as any).username, 'dora');
    assert.deepEqual(await service.logout(auth), { ok: true, revocation: 'confirmed' });
    await assert.rejects(
      service.profile(auth),
      (error: any) => error instanceof BrowserAuthError && error.status === 401,
    );
    // 再次退出是幂等的 not_required，不改写已撤销行。
    assert.deepEqual(await service.logout(auth), { ok: true, revocation: 'not_required' });
  });

  it('rejects a valid session whose owner mapping drifted or whose membership is inactive', async () => {
    const disabledUser = await setup();
    const user = [...disabledUser.identity.usersById.values()][0] as any;
    user.status = 'disabled';
    await assert.rejects(
      disabledUser.service.profile(disabledUser.auth),
      (error: any) => error.status === 401,
    );

    const inactiveMembership = await setup();
    for (const membership of inactiveMembership.identity.memberships.values()) {
      (membership as any).status = 'disabled';
    }
    await assert.rejects(
      inactiveMembership.service.profile(inactiveMembership.auth),
      (error: any) => error.status === 401,
    );
  });

  it('takes role revocation into effect on the next request', async () => {
    const credentials = memoryCredentials();
    const identity = memoryIdentity();
    const memberRoles = memoryMemberRoles(['dora']);
    const service = new BrowserAuthService({
      credentials,
      organizations: identity.organizations,
      externalRefs: identity.externalRefs,
      memberRoles,
      sessions: memoryBrowserSessions(),
      secret: 'a'.repeat(32),
    });
    const { token }: any = await service.register({ username: 'dora', password: 'password123' });
    const auth = `Bearer ${token}`;
    assert.deepEqual((await service.me(auth) as any).roles, ['admin']);
    // 账本撤销（同时把部署名单移除，避免下一次请求又被引导回来）。
    memberRoles.pinSet.delete('dora');
    memberRoles.grants.clear();
    assert.deepEqual((await service.me(auth) as any).roles, []);
  });

  it('returns 503 when the role ledger is unreachable', async () => {
    const credentials = memoryCredentials();
    const identity = memoryIdentity();
    const memberRoles = memoryMemberRoles();
    const service = new BrowserAuthService({
      credentials,
      organizations: identity.organizations,
      externalRefs: identity.externalRefs,
      memberRoles,
      sessions: memoryBrowserSessions(),
      secret: 'a'.repeat(32),
    });
    const { token }: any = await service.register({ username: 'dora', password: 'password123' });
    memberRoles.listRolesForMember = async () => {
      throw new Error('role ledger down');
    };
    await assert.rejects(
      service.me(`Bearer ${token}`),
      (error: any) => error.status === 503 && error.code === 'AUTH_STORE_UNAVAILABLE',
    );
  });
});

describe('browser auth HTTP route', () => {
  let server: any;
  let port: number;

  before(async () => {
    server = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      browserAuthService: {
        register: async (body: any) => ({ token: 'signed', user: { username: body.username } }),
        login: async () => ({ token: 'signed', user: { username: 'alice' } }),
        me: async (authorization: string) => ({ username: 'alice', authorization }),
        profile: async (authorization: string) => ({ username: 'alice', organization_name: 'org', authorization }),
        updateProfile: async (authorization: string, body: any) => ({ username: 'alice', body, authorization }),
        authConfig: () => ({
          mode: 'local',
          methods: {
            local: { enabled: true, registration_enabled: false },
            sso: { enabled: false, available: false, label: '公司 SSO' },
          },
          profile_policy: { editable_fields: ['display_name', 'email', 'notify_run_complete'] },
        }),
        logout: async (authorization: string | undefined) => {
          if (authorization === 'Bearer legacy') {
            throw new BrowserAuthError(409, 'LEGACY_SESSION_NOT_REVOCABLE', 'legacy session');
          }
          if (authorization === 'Bearer unreachable') {
            throw new BrowserAuthError(503, 'AUTH_REVOCATION_UNCONFIRMED', 'store down');
          }
          return authorization === 'Bearer live'
            ? { ok: true, revocation: 'confirmed' }
            : { ok: true, revocation: 'not_required' };
        },
      },
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => new Promise<void>((resolve) => server.close(resolve)));

  it('serves register and me only on the internal plane', async () => {
    const registered = await fetch(`http://127.0.0.1:${port}/internal/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'alice' }),
    });
    assert.equal(registered.status, 200);
    assert.equal((await registered.json() as any).token, 'signed');

    const me = await fetch(`http://127.0.0.1:${port}/internal/auth/me`, {
      headers: { Authorization: 'Bearer signed' },
    });
    assert.equal(me.status, 200);
    assert.equal((await me.json() as any).authorization, 'Bearer signed');
  });

  it('serves the profile on GET and edits it on PATCH', async () => {
    const got = await fetch(`http://127.0.0.1:${port}/internal/auth/profile`, { headers: { Authorization: 'Bearer signed' } });
    assert.equal(got.status, 200);
    assert.equal((await got.json() as any).organization_name, 'org');
    const patched = await fetch(`http://127.0.0.1:${port}/internal/auth/profile`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'a@b.co' }),
    });
    assert.equal(patched.status, 200);
    assert.deepEqual((await patched.json() as any).body, { email: 'a@b.co' });
    const array = await fetch(`http://127.0.0.1:${port}/internal/auth/profile`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer signed', 'Content-Type': 'application/json' },
      body: '[]',
    });
    assert.equal(array.status, 400);
  });

  it('serves the locked login-capability DTO on config', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/auth/config`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      mode: 'local',
      methods: {
        local: { enabled: true, registration_enabled: false },
        sso: { enabled: false, available: false, label: '公司 SSO' },
      },
      profile_policy: { editable_fields: ['display_name', 'email', 'notify_run_complete'] },
    });
  });

  it('maps the logout contract to confirmed / not_required / 409 / 503', async () => {
    const noCredentials = await fetch(`http://127.0.0.1:${port}/internal/auth/logout`, { method: 'POST' });
    assert.equal(noCredentials.status, 200);
    assert.deepEqual(await noCredentials.json(), { ok: true, revocation: 'not_required' });

    const live = await fetch(`http://127.0.0.1:${port}/internal/auth/logout`, {
      method: 'POST',
      headers: { Authorization: 'Bearer live' },
    });
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { ok: true, revocation: 'confirmed' });

    const legacy = await fetch(`http://127.0.0.1:${port}/internal/auth/logout`, {
      method: 'POST',
      headers: { Authorization: 'Bearer legacy' },
    });
    assert.equal(legacy.status, 409);
    assert.equal((await legacy.json() as any).code, 'LEGACY_SESSION_NOT_REVOCABLE');

    const unreachable = await fetch(`http://127.0.0.1:${port}/internal/auth/logout`, {
      method: 'POST',
      headers: { Authorization: 'Bearer unreachable' },
    });
    assert.equal(unreachable.status, 503);
    assert.equal((await unreachable.json() as any).code, 'AUTH_REVOCATION_UNCONFIRMED');
  });
});
