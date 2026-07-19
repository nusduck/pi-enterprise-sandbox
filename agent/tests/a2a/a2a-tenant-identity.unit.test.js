import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2aTaskService,
  formatA2aExternalUserId,
} from '../../src/application/a2a/task-service.js';

const ORG_A = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const ORG_B = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const USER_A = '01K0G2PAV8FPMVC9QHJG7JPN50';
const USER_B = '01K0G2PAV8FPMVC9QHJG7JPN51';
const AGENT_A = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const AGENT_B = '01K0G2PAV8FPMVC9QHJG7JPN4B';
const CRED_A = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const CRED_B = '01K0G2PAV8FPMVC9QHJG7JPN5D';
const RUN_A = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN_B = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV_A = '01K0G2PAV8FPMVC9QHJG7JPN54';
const CONV_B = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TRACE = 'a'.repeat(32);

describe('A2A tenant-qualified service user identity', () => {
  it('allows two organizations to use the same clientId without a global subject collision', async () => {
    const users = new Map();
    const memberships = new Set();
    const tasks = new Map();
    const createRunAuth = [];
    const getRunAuth = [];

    const createRepositories = () => ({
      externalRefs: {
        async getOrCreateOrganizationRef(input) {
          return input;
        },
      },
      organizations: {
        async getUserByExternalSubject(subject) {
          return users.get(subject) || null;
        },
        async createUserIfAbsent(input) {
          const existing = users.get(input.externalSubject);
          if (existing && existing.userId !== input.userId) {
            throw new Error('global external_subject collision');
          }
          const row = existing || { ...input };
          users.set(input.externalSubject, row);
          return row;
        },
        async addMembershipIfAbsent(input) {
          memberships.add(`${input.orgId}:${input.userId}`);
          return input;
        },
      },
      a2aTasks: {
        async getByRunId(runId, scope) {
          return [...tasks.values()].find(
            (row) =>
              row.runId === runId &&
              row.orgId === scope.orgId &&
              row.clientId === scope.clientId,
          ) || null;
        },
        async insert(input) {
          const row = {
            ...input,
            createdAt: '2026-07-18T08:00:00.000Z',
            updatedAt: '2026-07-18T08:00:00.000Z',
          };
          tasks.set(input.a2aTaskId, row);
          return row;
        },
      },
      a2aAudit: {
        async append(input) {
          return input;
        },
      },
    });

    const service = new A2aTaskService({
      createRunService: {
        async execute(input) {
          createRunAuth.push(input.auth);
          const second = input.auth.externalOrgId === ORG_B;
          return {
            runId: second ? RUN_B : RUN_A,
            conversationId: second ? CONV_B : CONV_A,
            status: 'ACCEPTED',
          };
        },
      },
      getRunService: {
        async execute(input) {
          getRunAuth.push(input.auth);
          return {
            runId: input.runId,
            status: 'ACCEPTED',
            createdAt: '2026-07-18T08:00:00.000Z',
            updatedAt: '2026-07-18T08:00:00.000Z',
          };
        },
      },
      cancelRunService: { async execute() {} },
      createRepositories,
      generateId: () => CRED_A,
    });

    const invoke = (principal, messageId) => service.sendMessage({
      principal,
      agentId: principal.agentId,
      params: {
        message: {
          messageId,
          parts: [{ kind: 'text', text: 'hello' }],
        },
      },
      traceId: TRACE,
      idempotencyKey: messageId,
    });

    const [taskA, taskB] = await Promise.all([
      invoke({
        orgId: ORG_A,
        agentId: AGENT_A,
        serviceUserId: USER_A,
        clientId: 'shared-client',
        credentialId: CRED_A,
        scopes: ['agent.invoke', 'agent.read'],
      }, 'tenant-a-message'),
      invoke({
        orgId: ORG_B,
        agentId: AGENT_B,
        serviceUserId: USER_B,
        clientId: 'shared-client',
        credentialId: CRED_B,
        scopes: ['agent.invoke', 'agent.read'],
      }, 'tenant-b-message'),
    ]);

    assert.notEqual(taskA.id, taskB.id);
    assert.deepEqual([...users.keys()].sort(), [
      `a2a:${ORG_A}:shared-client`,
      `a2a:${ORG_B}:shared-client`,
    ].sort());
    assert.deepEqual(createRunAuth.map((auth) => auth.externalUserId).sort(), [
      `${ORG_A}:shared-client`,
      `${ORG_B}:shared-client`,
    ].sort());
    assert.deepEqual(getRunAuth.map((auth) => auth.externalUserId).sort(), [
      `${ORG_A}:shared-client`,
      `${ORG_B}:shared-client`,
    ].sort());
    assert.deepEqual([...memberships].sort(), [
      `${ORG_A}:${USER_A}`,
      `${ORG_B}:${USER_B}`,
    ].sort());
  });

  it('validates and formats the owner-qualified external user id', () => {
    assert.equal(
      formatA2aExternalUserId(ORG_A, ' client '),
      `${ORG_A}:client`,
    );
    assert.throws(
      () => formatA2aExternalUserId(ORG_A, 'x'.repeat(129)),
      /max length 128/,
    );
  });
});
