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
    async updateProfile(id: string, subject: string, patch: any) {
      this.profileWrites.push({ id, subject, patch });
      const row = [...rows.values()].find((candidate) => candidate.id === id);
      if (row) {
        if (patch.displayName !== undefined) row.displayName = patch.displayName;
        if (patch.email !== undefined) row.email = patch.email;
      }
      return row || null;
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

  it('registers, logs in, verifies tokens, and reconciles deployment roles', async () => {
    const credentials = memoryCredentials();
    const now = new Date('2026-09-01T00:00:00Z');
    const service = new BrowserAuthService({
      credentials,
      secret: 'a'.repeat(32),
      adminUsernames: ['alice'],
      now: () => now,
    });
    const registered: any = await service.register({
      username: 'alice',
      password: 'secret1',
      organization_id: 'attacker-org',
    });
    assert.equal(registered.user.organization_id, 'org_bootstrap');
    assert.equal(registered.user.role, 'admin');
    assert.equal((await service.me(`Bearer ${registered.token}`) as any).username, 'alice');
    const alteredToken = `${registered.token.slice(0, -1)}${registered.token.endsWith('a') ? 'b' : 'a'}`;
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
    assert.equal(createdMemberships[0].role, 'user');

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
  async function setup() {
    const credentials = memoryCredentials();
    const service = new BrowserAuthService({
      credentials,
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
    assert.deepEqual(profile.editable_fields, ['display_name', 'email']);
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
