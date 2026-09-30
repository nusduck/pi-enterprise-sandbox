import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  BrowserAuthError,
  BrowserAuthService,
  hashPassword,
  verifyPassword,
} from '../../src/application/browser-auth-service.js';
import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';

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
    async updateProfile(id: string, subject: string, patch: any) {
      this.profileWrites.push({ id, subject, patch });
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      if (row) {
        if (patch.displayName !== undefined) row.displayName = patch.displayName;
        if (patch.email !== undefined) row.email = patch.email;
      }
      if (patch.notifyRunComplete !== undefined) this.notify.set(subject, patch.notifyRunComplete);
      return row || null;
    },
    async getNotifyRunComplete(subject: string) {
      return this.notify.get(subject) ?? false;
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
    grants,
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

/** provisioning 需要的最小 org / user / membership 映射（角色不在这里）。 */
function memoryIdentity(orgId = '01M1ORG0000000000000000000') {
  return {
    organizations: {
      async createOrganization() {},
      async getUserByExternalSubject() {
        return { userId: '01M1USER000000000000000000' };
      },
      async createUserIfAbsent(u: any) {
        return u;
      },
      async addMembershipIfAbsent(m: any) {
        return m;
      },
      async getOrganization() {
        return { name: '华东销售部' };
      },
    },
    externalRefs: {
      async getOrganizationRef() {
        return { orgId };
      },
      async getOrCreateOrganizationRef(ref: any) {
        return { orgId: ref.orgId };
      },
    },
  };
}

describe('BrowserAuthService', () => {
  it('hashes passwords and rejects a wrong password', async () => {
    const stored = await hashPassword('correct horse');
    assert.equal(await verifyPassword('correct horse', stored), true);
    assert.equal(await verifyPassword('wrong horse', stored), false);
    assert.equal(await verifyPassword('correct horse', 'broken'), false);
  });

  it('registers, logs in, verifies tokens, and bootstraps deployment roles', async () => {
    const credentials = memoryCredentials();
    const now = new Date('2026-09-01T00:00:00Z');
    const service = new BrowserAuthService({
      credentials,
      ...memoryIdentity(),
      // 名单内的账号由账本引导成 admin；角色不再由用户名现算。
      memberRoles: memoryMemberRoles(['alice']),
      secret: 'a'.repeat(32),
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
    assert.equal((await service.me(`Bearer ${registered.token}`) as any).username, 'alice');
    assert.deepEqual((await service.me(`Bearer ${registered.token}`) as any).roles, ['admin']);
    // 改**签名段的首字符**，不改最后一个：JWT 签名是 base64url 编码的 HMAC（43 字符
    // 承载 32 字节），最后一位只带 4 个有效位——翻它有时解出**同一串字节**，签名照样通过，
    // 于是这条用例会随机变红（用户 id 是随机 ULID，token 每次都不同）。这是 base64url 的
    // 非规范编码，不是安全问题：伪造签名仍然要密钥。
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
  });

  it('fails closed without signing material', async () => {
    const service = new BrowserAuthService({ credentials: memoryCredentials(), secret: '' });
    await assert.rejects(
      service.register({ username: 'alice', password: 'secret1' }),
      (error: any) => error.code === 'AUTH_CONFIG_UNAVAILABLE' && error.status === 503,
    );
  });

  it('provisions user and membership into tbl_agsvc_organizations on register and login', async () => {
    const credentials = memoryCredentials();
    const createdUsers: any[] = [];
    const createdMemberships: any[] = [];
    const organizations = {
      async createOrganization() {},
      async getUserByExternalSubject() { return null; },
      async createUserIfAbsent(u: any) {
        createdUsers.push(u);
        return u;
      },
      async addMembershipIfAbsent(m: any) {
        createdMemberships.push(m);
        return m;
      },
    };
    const externalRefs = {
      async getOrganizationRef() { return null; },
      async getOrCreateOrganizationRef(ref: any) { return { orgId: ref.orgId }; },
    };
    const service = new BrowserAuthService({
      credentials,
      organizations,
      externalRefs,
      generateId: () => '01M1GENID00000000000000000',
      secret: 'a'.repeat(32),
    });
    await service.register({ username: 'bob', password: 'password123' });
    assert.equal(createdUsers.length, 1);
    assert.equal(createdUsers[0].displayName, 'bob');
    assert.equal(createdMemberships.length, 1);
    // 成员关系的 role 已收窄为「成员类型」，角色权威是 member_roles（design §2.3）。
    assert.equal(createdMemberships[0].role, 'member');

    await service.login({ username: 'bob', password: 'password123' });
    assert.equal(createdMemberships.length, 2);
  });

  it('me() 不得每次调用都打一遍 organizations —— 它挂在 BFF 的每请求鉴权上', async () => {
    // `resolveTrustedAuth()` 每个已认证请求调一次 `/internal/auth/me`。
    // provisioning 是一次性补建，放在这条路上不做记忆 = 每请求 3~4 次 MySQL 往返。
    const credentials = memoryCredentials();
    let orgRefLookups = 0;
    let membershipWrites = 0;
    const organizations = {
      async createOrganization() {},
      async getUserByExternalSubject() { return null; },
      async createUserIfAbsent(u: any) { return u; },
      async addMembershipIfAbsent(m: any) {
        membershipWrites += 1;
        return m;
      },
    };
    const externalRefs = {
      async getOrganizationRef() {
        orgRefLookups += 1;
        return null;
      },
      async getOrCreateOrganizationRef(ref: any) { return { orgId: ref.orgId }; },
    };
    const service = new BrowserAuthService({
      credentials,
      organizations,
      externalRefs,
      generateId: () => '01M1GENID00000000000000000',
      secret: 'a'.repeat(32),
    });
    const registered: any = await service.register({ username: 'carol', password: 'password123' });
    const afterRegister = { orgRefLookups, membershipWrites };
    assert.equal(afterRegister.membershipWrites, 1);

    for (let i = 0; i < 5; i += 1) {
      assert.equal((await service.me(`Bearer ${registered.token}`) as any).username, 'carol');
    }
    assert.equal(orgRefLookups, afterRegister.orgRefLookups, 'me() 不该再查 org ref');
    assert.equal(membershipWrites, afterRegister.membershipWrites, 'me() 不该再写 membership');

    // 但 login 必须重新对账：那条路上凭据刚变过。
    await service.login({ username: 'carol', password: 'password123' });
    assert.equal(membershipWrites, afterRegister.membershipWrites + 1);
  });
});

describe('BrowserAuthService — own profile', () => {
  async function setup(notificationCapability?: { available: boolean; min_run_duration_ms: number | null }) {
    const credentials = memoryCredentials();
    const service = new BrowserAuthService({
      credentials,
      notificationCapability,
      organizations: {
        async createOrganization() {},
        async getUserByExternalSubject() { return { userId: '01M1USER000000000000000000' }; },
        async createUserIfAbsent(u: any) { return u; },
        async addMembershipIfAbsent(m: any) { return m; },
        async getOrganization() { return { name: '华东销售部' }; },
      },
      externalRefs: {
        async getOrganizationRef() { return { orgId: '01M1ORG0000000000000000000' }; },
        async getOrCreateOrganizationRef(ref: any) { return { orgId: ref.orgId }; },
      },
      secret: 'a'.repeat(32),
    });
    const { token }: any = await service.register({ username: 'dora', password: 'password123' });
    return { service, credentials, auth: `Bearer ${token}` };
  }

  it('shows organisation, status and the editable fields', async () => {
    const { service, auth } = await setup();
    const profile: any = await service.profile(auth);
    assert.equal(profile.username, 'dora');
    assert.equal(profile.organization_name, '华东销售部');
    assert.equal(profile.status, 'active');
    assert.deepEqual(profile.editable_fields, ['display_name', 'email', 'notify_run_complete']);
    assert.equal(profile.notify_run_complete, false);
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
    // Clearing both in one request is fine.
    await service.updateProfile(auth, { notify_run_complete: true });
    const cleared: any = await service.updateProfile(auth, { email: '', notify_run_complete: false });
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

  it('updates display name and email in both identity stores', async () => {
    const { service, credentials, auth } = await setup();
    const updated: any = await service.updateProfile(auth, { display_name: '  多拉 ', email: 'dora@example.com' });
    assert.equal(updated.display_name, '多拉');
    assert.equal(updated.email, 'dora@example.com');
    const [write] = credentials.profileWrites;
    assert.equal(write.subject, `bff:${write.id}`, 'users row is addressed by its external subject');
    assert.deepEqual(write.patch, { displayName: '多拉', email: 'dora@example.com' });
    // Clearing the email is allowed; the other field stays untouched.
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
});
