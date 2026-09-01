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
});
