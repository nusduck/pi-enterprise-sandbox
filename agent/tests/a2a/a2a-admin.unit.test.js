import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createA2aAdminHttpHandler } from '../../src/presentation/a2a/admin-http-handler.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN4B';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const AUDIT = '01K0G2PAV8FPMVC9QHJG7JPN5D';
const TRACE = 'a'.repeat(32);

function responseCapture() {
  const chunks = [];
  return {
    response: {
      writeHead(status, headers) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(chunk) {
        if (chunk) chunks.push(String(chunk));
      },
    },
    body() {
      return JSON.parse(chunks.join('') || '{}');
    },
  };
}

function repositories(overrides = {}) {
  const auditWrites = [];
  const bundle = {
    organizations: {
      async getUserByExternalSubject() {
        return { userId: USER };
      },
      async getMembership() {
        return { orgId: ORG, userId: USER, role: 'member', status: 'active' };
      },
    },
    externalRefs: {
      async getOrganizationRef() {
        return { orgId: ORG };
      },
    },
    catalog: {
      async getDefinitionById() {
        return {
          agentId: AGENT,
          orgId: ORG,
          name: 'Default',
          activeVersionId: VERSION,
        };
      },
      async listDefinitionsByOrg() {
        return [{
          agentId: AGENT,
          orgId: ORG,
          name: 'Default',
          activeVersionId: VERSION,
        }];
      },
    },
    a2aCredentials: {
      async listByOrg() {
        return [];
      },
      async getById() {
        return null;
      },
    },
    a2aTasks: {
      async listForOrgAdmin() {
        return [];
      },
    },
    a2aAudit: {
      async listForOrgAdmin() {
        return [];
      },
      async append(input) {
        auditWrites.push(input);
        return input;
      },
    },
    ...overrides,
  };
  return { bundle, auditWrites };
}

function handlerFixture({
  role = 'admin',
  readBody = async () => '',
  credentialService = {},
  repoOverrides = {},
} = {}) {
  const { bundle, auditWrites } = repositories(repoOverrides);
  const handler = createA2aAdminHttpHandler({
    credentialService,
    createRepositories: () => bundle,
    generateId: () => AUDIT,
    publicBaseUrl: 'https://agent.example.com',
    authSubjectsFromRequest: () => ({
      provider: 'bff',
      externalOrgId: 'org-external',
      externalUserId: 'user-external',
      role,
    }),
    resolveTraceId: () => TRACE,
    readBody,
    json(res, status, body) {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    },
  });
  return { handler, auditWrites };
}

describe('A2A admin HTTP', () => {
  it('rejects a non-admin before returning organization data', async () => {
    const { handler } = handlerFixture({ role: 'user' });
    const captured = responseCapture();
    await handler.handle(
      { method: 'GET', headers: {} },
      captured.response,
      new URL('http://agent/internal/a2a/config'),
    );
    assert.equal(captured.response.statusCode, 403);
    assert.equal(captured.body().code, 'ADMIN_REQUIRED');
  });

  it('returns agent endpoints without credential secrets', async () => {
    const { handler } = handlerFixture();
    const captured = responseCapture();
    await handler.handle(
      { method: 'GET', headers: {} },
      captured.response,
      new URL('http://agent/internal/a2a/config'),
    );
    const body = captured.body();
    assert.equal(captured.response.statusCode, 200);
    assert.equal(body.agents[0].agentId, AGENT);
    assert.equal(
      body.agents[0].endpoint,
      `https://agent.example.com/a2a/agents/${AGENT}`,
    );
    assert.equal(JSON.stringify(body).includes('secretHash'), false);
  });

  it('keeps the full owner catalog when selecting one Agent', async () => {
    const secondAgent = {
      agentId: '01K0G2PAV8FPMVC9QHJG7JPN4C',
      orgId: ORG,
      name: 'Reporting',
      activeVersionId: VERSION,
    };
    const { handler } = handlerFixture({
      repoOverrides: {
        catalog: {
          async listDefinitionsByOrg() {
            return [
              {
                agentId: AGENT,
                orgId: ORG,
                name: 'Default',
                activeVersionId: VERSION,
              },
              secondAgent,
            ];
          },
          async getDefinitionById(agentId) {
            return agentId === secondAgent.agentId ? secondAgent : null;
          },
        },
      },
    });
    const captured = responseCapture();
    await handler.handle(
      { method: 'GET', headers: {} },
      captured.response,
      new URL(`http://agent/internal/a2a/config?agent_id=${secondAgent.agentId}`),
    );
    const body = captured.body();
    assert.equal(captured.response.statusCode, 200);
    assert.deepEqual(
      body.agents.map((agent) => agent.agentId),
      [AGENT, secondAgent.agentId],
    );
    assert.equal(body.selectedAgentId, secondAgent.agentId);
  });

  it('issues a client service credential without reusing the admin user', async () => {
    let issueInput = null;
    const credential = {
      credentialId: CRED,
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'analytics',
      keyId: 'a'.repeat(16),
      scopes: ['agent.invoke'],
      status: 'active',
      expiresAt: null,
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    };
    const { handler, auditWrites } = handlerFixture({
      readBody: async () =>
        JSON.stringify({
          agentId: AGENT,
          clientId: 'analytics',
          scopes: ['agent.invoke'],
        }),
      credentialService: {
        async issue(input) {
          issueInput = input;
          return { credential, token: 'a2a_one_time' };
        },
      },
    });
    const captured = responseCapture();
    await handler.handle(
      { method: 'POST', headers: {} },
      captured.response,
      new URL('http://agent/internal/a2a/credentials'),
    );
    assert.equal(captured.response.statusCode, 201);
    assert.equal(captured.body().token, 'a2a_one_time');
    assert.equal(issueInput.orgId, ORG);
    assert.equal(Object.hasOwn(issueInput, 'serviceUserId'), false);
    assert.equal(auditWrites.length, 1);
    assert.equal(auditWrites[0].eventType, 'a2a.credential_issued');
  });

  it('maps invalid JSON to 400', async () => {
    const { handler } = handlerFixture({
      readBody: async () => '{',
      credentialService: { async issue() {} },
    });
    const captured = responseCapture();
    await handler.handle(
      { method: 'POST', headers: {} },
      captured.response,
      new URL('http://agent/internal/a2a/credentials'),
    );
    assert.equal(captured.response.statusCode, 400);
    assert.equal(captured.body().code, 'INVALID_REQUEST');
  });
});
