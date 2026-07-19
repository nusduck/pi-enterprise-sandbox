/**
 * A2A agent selection must survive the CreateRun parent graph and bind the
 * resulting Run to the selected Agent's immutable/session version.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { A2aTaskService } from '../../src/application/a2a/task-service.js';
import { hashCreateRunRequest } from '../../src/application/canonical-json.js';
import { CreateRunService } from '../../src/application/create-run-service.js';
import { ValidationError } from '../../src/application/errors.js';
import { RunParentProvisioner } from '../../src/application/parent/run-parent-provisioner.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
  TRACE,
} from '../run-services/helpers/fake-run-world.js';

const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const VERSION_1 = '01K0G2PAV8FPMVC9QHJG7JPN4B';
const VERSION_2 = '01K0G2PAV8FPMVC9QHJG7JPN4C';
const TASK = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const TRACE_ID = 'a'.repeat(32);

const A2A_AUTH = {
  provider: 'a2a',
  externalOrgId: 'a2a-org-binding',
  externalUserId: 'a2a-client-binding',
  displayName: 'A2A binding test',
  orgName: 'A2A binding org',
};

function addAgentVersion(world, { agentId, versionId, versionNo, createdBy }) {
  world.tables.agent_versions.push({
    agent_version_id: versionId,
    agent_id: agentId,
    version_no: versionNo,
    config_json: '{}',
    config_hash: String(versionNo).padStart(1, '0').repeat(64).slice(0, 64),
    pi_sdk_version: '0.80.3',
    status: 'active',
    created_by: createdBy,
    created_at: '2026-07-18 07:00:00.000',
  });
  return versionId;
}

async function provisionDefault(world) {
  return world.transactionManager.run(async (trx) => {
    const repos = world.createRepositories(trx);
    const provisioner = new RunParentProvisioner(
      {
        organizations: repos.organizations,
        externalRefs: repos.externalRefs,
        catalog: repos.catalog,
        conversations: repos.conversations,
        sessions: repos.sessions,
      },
      { generateId: world.generateId, db: trx },
    );
    return provisioner.provision(A2A_AUTH);
  });
}

function buildCreateRun(world) {
  return new CreateRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: () => new Date('2026-07-18T08:00:00.000Z'),
    runQueue: world.runQueue,
    defaultProvider: 'a2a',
    source: 'a2a',
  });
}

describe('A2A agent binding -> CreateRun agent version', () => {
  it('propagates the credential agent and selects its active version', async () => {
    const world = createFakeRunWorld();
    const base = await provisionDefault(world);
    world.tables.agent_definitions.push({
      agent_id: AGENT,
      org_id: base.orgId,
      name: 'analysis',
      description: null,
      status: 'active',
      active_version_id: VERSION_1,
      created_by: base.userId,
      created_at: '2026-07-18 07:00:00.000',
      updated_at: '2026-07-18 07:00:00.000',
    });
    addAgentVersion(world, {
      agentId: AGENT,
      versionId: VERSION_1,
      versionNo: 1,
      createdBy: base.userId,
    });

    const create = buildCreateRun(world);
    const messages = [{ role: 'user', content: 'analyze' }];
    const result = await create.execute({
      messages,
      auth: { ...A2A_AUTH, externalConversationId: 'binding-conv' },
      traceId: TRACE_ID,
      idempotencyKey: 'binding-1',
      agentId: AGENT,
      // Keep the legacy hash field equal to the selected Agent for replay
      // compatibility with A2A requests issued before this fix.
      agentProfileId: AGENT,
    });

    const run = world.tables.runs.find((row) => row.run_id === result.runId);
    assert.equal(run.agent_version_id, VERSION_1);
    const conversation = world.tables.conversations.find(
      (row) => row.conversation_id === result.conversationId,
    );
    assert.equal(conversation.agent_id, AGENT);
    const session = world.tables.agent_sessions.find(
      (row) => row.conversation_id === result.conversationId,
    );
    assert.equal(session.agent_version_id, VERSION_1);
    assert.equal(
      world.tables.idempotency_records[0].request_hash,
      hashCreateRunRequest({
        messages,
        externalConversationId: 'binding-conv',
        agentProfileId: AGENT,
      }),
      'explicit agent selection must retain the pre-fix A2A idempotency hash shape',
    );
  });

  it('keeps an existing A2A session version pinned after active version changes', async () => {
    const world = createFakeRunWorld();
    const base = await provisionDefault(world);
    world.tables.agent_definitions.push({
      agent_id: AGENT,
      org_id: base.orgId,
      name: 'analysis',
      description: null,
      status: 'active',
      active_version_id: VERSION_1,
      created_by: base.userId,
      created_at: '2026-07-18 07:00:00.000',
      updated_at: '2026-07-18 07:00:00.000',
    });
    addAgentVersion(world, {
      agentId: AGENT,
      versionId: VERSION_1,
      versionNo: 1,
      createdBy: base.userId,
    });
    const create = buildCreateRun(world);
    const first = await create.execute({
      messages: [{ role: 'user', content: 'first' }],
      auth: { ...A2A_AUTH, externalConversationId: 'stable-conv' },
      traceId: TRACE_ID,
      idempotencyKey: 'binding-first',
      agentId: AGENT,
      agentProfileId: AGENT,
    });

    addAgentVersion(world, {
      agentId: AGENT,
      versionId: VERSION_2,
      versionNo: 2,
      createdBy: base.userId,
    });
    world.tables.agent_definitions.find(
      (row) => row.agent_id === AGENT,
    ).active_version_id = VERSION_2;

    const second = await create.execute({
      messages: [{ role: 'user', content: 'second' }],
      auth: { ...A2A_AUTH, externalConversationId: 'stable-conv' },
      traceId: TRACE_ID,
      idempotencyKey: 'binding-second',
      agentId: AGENT,
      agentProfileId: AGENT,
    });
    const firstRun = world.tables.runs.find((row) => row.run_id === first.runId);
    const secondRun = world.tables.runs.find((row) => row.run_id === second.runId);
    assert.equal(firstRun.agent_version_id, VERSION_1);
    assert.equal(secondRun.agent_version_id, VERSION_1);
  });

  it('rejects a context mapped to a different Agent instead of silently running it', async () => {
    const world = createFakeRunWorld();
    const base = await provisionDefault(world);
    world.tables.agent_definitions.push({
      agent_id: AGENT,
      org_id: base.orgId,
      name: 'analysis',
      description: null,
      status: 'active',
      active_version_id: VERSION_1,
      created_by: base.userId,
      created_at: '2026-07-18 07:00:00.000',
      updated_at: '2026-07-18 07:00:00.000',
    });
    addAgentVersion(world, {
      agentId: AGENT,
      versionId: VERSION_1,
      versionNo: 1,
      createdBy: base.userId,
    });
    const create = buildCreateRun(world);
    await create.execute({
      messages: [{ role: 'user', content: 'first' }],
      auth: { ...A2A_AUTH, externalConversationId: 'wrong-agent-conv' },
      traceId: TRACE_ID,
      idempotencyKey: 'binding-context-a',
    });

    await assert.rejects(
      create.execute({
        messages: [{ role: 'user', content: 'wrong agent' }],
        auth: { ...A2A_AUTH, externalConversationId: 'wrong-agent-conv' },
        traceId: TRACE_ID,
        idempotencyKey: 'binding-context-b',
        agentId: AGENT,
        agentProfileId: AGENT,
      }),
      ValidationError,
    );
  });
});

describe('A2A SendMessage agent propagation', () => {
  it('passes the credential-bound Agent to CreateRun', async () => {
    let captured;
    const tasks = new Map();
    const principal = {
      orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-binding',
      credentialId: CRED,
      scopes: ['agent.invoke', 'agent.read'],
    };
    const createRepositories = () => ({
      a2aTasks: {
        async insert(row) {
          tasks.set(row.a2aTaskId, {
            ...row,
            createdAt: '2026-07-18T08:00:00.000Z',
            updatedAt: '2026-07-18T08:00:00.000Z',
          });
        },
        async getByRunId(runId) {
          return [...tasks.values()].find((row) => row.runId === runId) || null;
        },
        async getById(id) {
          return tasks.get(id) || null;
        },
      },
    });
    const service = new A2aTaskService({
      createRunService: {
        async execute(input) {
          captured = input;
          return {
            runId: RUN,
            conversationId: CONV,
            status: 'ACCEPTED',
          };
        },
      },
      getRunService: {
        async execute() {
          return {
            runId: RUN,
            status: 'ACCEPTED',
            createdAt: '2026-07-18T08:00:00.000Z',
            updatedAt: '2026-07-18T08:00:00.000Z',
          };
        },
      },
      cancelRunService: { async execute() {} },
      createRepositories,
      generateId: () => TASK,
      requireAudit: false,
    });

    await service.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'a2a-agent-binding-message',
          parts: [{ kind: 'text', text: 'hello' }],
        },
      },
      traceId: TRACE,
      traceState: 'vendor=value',
      spanId: 'd'.repeat(16),
      idempotencyKey: 'a2a-agent-binding-message',
    });

    assert.equal(captured.agentId, AGENT);
    assert.equal(captured.agentProfileId, AGENT);
    assert.equal(captured.traceState, 'vendor=value');
    assert.equal(captured.spanId, 'd'.repeat(16));
  });
});
