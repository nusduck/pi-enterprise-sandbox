/**
 * A2A P0–P2 protocol compliance (static review 2026-08-05).
 * Offline fakes only — error codes, card shape, contextId, taskId multi-turn,
 * acceptedOutputModes, ListTasks, message history.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2A_RPC_ERROR,
  A2A_METHODS,
  A2A_PROTOCOL_VERSION,
  normalizeA2aMethod,
} from '../../src/application/a2a/json-rpc.js';
import {
  buildAgentCard,
  A2A_SUPPORTED_INPUT_MODES,
  A2A_SUPPORTED_OUTPUT_MODES,
  A2A_ENTERPRISE_EXTENSION_URI,
} from '../../src/application/a2a/agent-card.js';
import {
  A2aTaskService,
  A2aTaskError,
  parseSendParams,
  assertSendConfiguration,
} from '../../src/application/a2a/task-service.js';
import {
  projectMessagesToA2aHistory,
  buildA2aTaskObject,
} from '../../src/application/a2a/event-projector.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const TRACE = 'a'.repeat(32);

describe('P0 A2A v0.3 error code mapping', () => {
  it('uses protocol-defined codes (not enterprise auth codes)', () => {
    assert.equal(A2A_RPC_ERROR.TASK_NOT_FOUND.code, -32001);
    assert.equal(A2A_RPC_ERROR.TASK_NOT_CANCELABLE.code, -32002);
    assert.equal(A2A_RPC_ERROR.PUSH_NOT_SUPPORTED.code, -32003);
    assert.equal(A2A_RPC_ERROR.UNSUPPORTED.code, -32004);
    assert.equal(A2A_RPC_ERROR.CONTENT_TYPE.code, -32005);
    assert.equal(A2A_RPC_ERROR.INVALID_AGENT_RESPONSE.code, -32006);
    assert.equal(A2A_RPC_ERROR.AUTHENTICATED_EXTENDED_CARD.code, -32007);
    // Auth uses enterprise extension range — never collides with A2A codes.
    assert.equal(A2A_RPC_ERROR.AUTH.code, -32090);
    assert.equal(A2A_RPC_ERROR.FORBIDDEN.code, -32091);
    assert.ok(A2A_RPC_ERROR.AUTH.code <= -32090);
  });
});

describe('P1 pure v0.3 Agent Card', () => {
  it('declares additionalInterfaces, MIME-only modes, no supportedInterfaces', () => {
    const card = buildAgentCard({
      agentId: AGENT,
      baseUrl: 'https://agent.example.com',
    });
    assert.equal(card.protocolVersion, A2A_PROTOCOL_VERSION);
    assert.equal(card.preferredTransport, 'JSONRPC');
    assert.ok(Array.isArray(card.additionalInterfaces));
    assert.equal(card.additionalInterfaces[0].transport, 'JSONRPC');
    assert.equal(card.additionalInterfaces[0].url, card.url);
    assert.equal(card.supportedInterfaces, undefined);
    assert.deepEqual(card.defaultInputModes, [...A2A_SUPPORTED_INPUT_MODES]);
    assert.deepEqual(card.defaultOutputModes, [...A2A_SUPPORTED_OUTPUT_MODES]);
    assert.ok(!card.defaultInputModes.includes('text'));
    assert.ok(!card.defaultOutputModes.includes('text'));
    assert.equal(card.capabilities.pushNotifications, false);
    assert.equal(card.supportsAuthenticatedExtendedCard, false);
    assert.ok(
      card.extensions.some((e) => e.uri === A2A_ENTERPRISE_EXTENSION_URI),
    );
  });
});

describe('P1 acceptedOutputModes + push config validation', () => {
  it('rejects unsupported output modes with CONTENT_TYPE (-32005)', () => {
    assert.throws(
      () =>
        assertSendConfiguration({
          acceptedOutputModes: ['image/png', 'video/mp4'],
        }),
      (e) =>
        e instanceof A2aTaskError &&
        e.code === 'CONTENT_TYPE_NOT_SUPPORTED' &&
        e.rpc?.code === -32005,
    );
  });

  it('accepts at least one supported output mode', () => {
    assert.doesNotThrow(() =>
      assertSendConfiguration({
        acceptedOutputModes: ['text/plain', 'image/png'],
      }),
    );
  });

  it('rejects pushNotificationConfig with PUSH_NOT_SUPPORTED (-32003)', () => {
    assert.throws(
      () =>
        assertSendConfiguration({
          pushNotificationConfig: { url: 'https://hooks.example.com' },
        }),
      (e) =>
        e instanceof A2aTaskError &&
        e.code === 'PUSH_NOT_SUPPORTED' &&
        e.rpc?.code === -32003,
    );
  });
});

describe('P0 parseSendParams contextId + taskId', () => {
  it('accepts opaque business contextId and message.taskId', () => {
    const parsed = parseSendParams({
      message: {
        messageId: 'm1',
        taskId: '01K0G2PAV8FPMVC9QHJG7JPN5E',
        contextId: 'crm-case-12345',
        role: 'user',
        parts: [{ kind: 'text', text: 'continue' }],
      },
    });
    assert.equal(parsed.contextId, 'crm-case-12345');
    assert.equal(parsed.taskId, '01K0G2PAV8FPMVC9QHJG7JPN5E');
    assert.equal(parsed.messageId, 'm1');
  });

  it('accepts UUID contextId', () => {
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    const parsed = parseSendParams({
      message: {
        messageId: 'm2',
        contextId: uuid,
        parts: [{ kind: 'text', text: 'hi' }],
      },
    });
    assert.equal(parsed.contextId, uuid);
  });
});

describe('P0/P2 multi-turn taskId + opaque context + list + history', () => {
  function makeWorld() {
    /** @type {Map<string, object>} */
    const tasks = new Map();
    /** @type {Map<string, object>} */
    const runs = new Map();
    /** @type {object[]} */
    const audits = [];
    /** @type {object[]} */
    const createCalls = [];
    let runSeq = 0;
    let idSeq = 0;
    const gen = () => {
      const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
      idSeq += 1;
      const tail = String(idSeq).padStart(2, '0');
      return `01K0G2PAV8FPMVC9QHJG7JPN${alphabet[idSeq % 32]}${tail[0]}`;
    };
    // Fixed ULID pool for deterministic run ids used as Crockford ULIDs.
    const runIds = [
      '01K0G2PAV8FPMVC9QHJG7JPN53',
      '01K0G2PAV8FPMVC9QHJG7JPN54',
      '01K0G2PAV8FPMVC9QHJG7JPN55',
      '01K0G2PAV8FPMVC9QHJG7JPN56',
    ];
    const convIds = [
      '01K0G2PAV8FPMVC9QHJG7JPN51',
      '01K0G2PAV8FPMVC9QHJG7JPN52',
    ];

    const principal = {
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'client-a',
      credentialId: CRED,
      scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
    };

    /** @type {Map<string, string>} external subject → conversationId */
    const convByExternal = new Map();

    const createRepositories = () => ({
      a2aTasks: {
        async insert(input) {
          const row = {
            ...input,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          tasks.set(input.a2aTaskId, row);
          return row;
        },
        async getById(id, scope) {
          const row = tasks.get(id);
          if (!row) return null;
          if (row.orgId !== scope.orgId || row.clientId !== scope.clientId) {
            return null;
          }
          return row;
        },
        async getByRunId(runId, scope) {
          for (const row of tasks.values()) {
            if (
              row.runId === runId &&
              row.orgId === scope.orgId &&
              row.clientId === scope.clientId
            ) {
              return row;
            }
          }
          return null;
        },
        async listForClient(scope, opts = {}) {
          const all = [...tasks.values()].filter(
            (t) =>
              t.orgId === scope.orgId &&
              t.clientId === scope.clientId &&
              (!opts.agentId || t.agentId === opts.agentId) &&
              (!opts.contextId || t.contextId === opts.contextId),
          );
          const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
          return all.slice(0, limit);
        },
      },
      a2aAudit: {
        async append(input) {
          audits.push(input);
          return input;
        },
      },
      messages: {
        async listByConversation(conversationId, _scope, opts = {}) {
          const limit = opts.limit ?? 200;
          return [
            {
              messageId: '01K0G2PAV8FPMVC9QHJG7JPN6A',
              role: 'user',
              contentJson: { text: 'first turn' },
              sequenceNo: 1,
            },
            {
              messageId: '01K0G2PAV8FPMVC9QHJG7JPN6B',
              role: 'assistant',
              contentJson: { text: 'assistant reply' },
              sequenceNo: 2,
            },
          ].slice(0, limit);
        },
      },
    });

    const createRunService = {
      async execute(input) {
        createCalls.push(input);
        const runId = runIds[runSeq % runIds.length];
        runSeq += 1;
        let conversationId;
        const ext = input.auth?.externalConversationId;
        if (ext && convByExternal.has(ext)) {
          conversationId = convByExternal.get(ext);
        } else if (ext && /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(ext)) {
          conversationId = ext.toUpperCase();
          convByExternal.set(ext, conversationId);
        } else if (ext) {
          conversationId = convIds[convByExternal.size % convIds.length];
          convByExternal.set(ext, conversationId);
        } else {
          conversationId = convIds[0];
        }
        runs.set(runId, {
          runId,
          status: 'SUCCEEDED',
          conversationId,
          orgId: ORG,
          userId: USER,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        return {
          runId,
          status: 'SUCCEEDED',
          conversationId,
        };
      },
    };

    const getRunService = {
      async execute({ runId }) {
        const r = runs.get(runId);
        if (!r) throw new OwnerScopedNotFoundError('Run not found');
        return r;
      },
    };

    const cancelRunService = {
      async execute({ runId }) {
        const r = runs.get(runId);
        if (r) r.status = 'CANCELLED';
        return r;
      },
    };

    const svc = new A2aTaskService({
      createRunService,
      getRunService,
      cancelRunService,
      createRepositories,
      generateId: gen,
      defaultProvider: 'a2a',
    });

    return { svc, principal, tasks, runs, audits, createCalls, gen };
  }

  it('maps opaque contextId into createRun externalConversationId', async () => {
    const { svc, principal, createCalls, tasks } = makeWorld();
    const task = await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'ctx-1',
          contextId: 'crm-case-12345',
          role: 'user',
          parts: [{ kind: 'text', text: 'analyze case' }],
        },
      },
      traceId: TRACE,
    });
    assert.equal(createCalls[0].auth.externalConversationId, 'crm-case-12345');
    assert.equal(task.contextId, 'crm-case-12345');
    const stored = [...tasks.values()][0];
    assert.equal(stored.contextId, 'crm-case-12345');
  });

  it('continues conversation when message.taskId is set on a completed task', async () => {
    const { svc, principal, createCalls, runs } = makeWorld();
    const first = await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'turn-1',
          contextId: 'thread-abc',
          role: 'user',
          parts: [{ kind: 'text', text: 'first' }],
        },
      },
      traceId: TRACE,
    });
    assert.equal(first.contextId, 'thread-abc');

    const second = await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'turn-2',
          taskId: first.id,
          role: 'user',
          parts: [{ kind: 'text', text: 'follow up' }],
        },
      },
      traceId: TRACE,
    });

    assert.notEqual(second.id, first.id);
    assert.equal(second.contextId, 'thread-abc');
    // Second create uses the parent task's internal conversation ULID.
    const firstConv = [...runs.values()][0].conversationId;
    assert.equal(createCalls[1].auth.externalConversationId, firstConv);
    assert.equal(createCalls[0].auth.externalConversationId, 'thread-abc');
  });

  it('rejects follow-up on a busy (RUNNING) task with UNSUPPORTED (-32004)', async () => {
    const { svc, principal, runs } = makeWorld();
    const first = await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'busy-1',
          parts: [{ kind: 'text', text: 'go' }],
        },
      },
      traceId: TRACE,
    });
    // Force parent run to RUNNING.
    const mappingRunId = [...runs.keys()][0];
    runs.get(mappingRunId).status = 'RUNNING';

    await assert.rejects(
      () =>
        svc.sendMessage({
          principal,
          agentId: AGENT,
          params: {
            message: {
              messageId: 'busy-2',
              taskId: first.id,
              parts: [{ kind: 'text', text: 'more' }],
            },
          },
          traceId: TRACE,
        }),
      (e) =>
        e instanceof A2aTaskError &&
        e.code === 'TASK_BUSY' &&
        e.rpc?.code === -32004,
    );
  });

  it('ListTasks returns client-scoped tasks filtered by contextId', async () => {
    const { svc, principal } = makeWorld();
    await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'l1',
          contextId: 'ctx-a',
          parts: [{ kind: 'text', text: 'a' }],
        },
      },
      traceId: TRACE,
    });
    await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'l2',
          contextId: 'ctx-b',
          parts: [{ kind: 'text', text: 'b' }],
        },
      },
      traceId: TRACE,
    });
    const listed = await svc.listTasks({
      principal,
      agentId: AGENT,
      contextId: 'ctx-a',
    });
    assert.equal(listed.tasks.length, 1);
    assert.equal(listed.tasks[0].contextId, 'ctx-a');
  });

  it('GetTask includes history when historyLength is set', async () => {
    const { svc, principal } = makeWorld();
    const task = await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'hist-1',
          parts: [{ kind: 'text', text: 'hello' }],
        },
      },
      traceId: TRACE,
    });
    const got = await svc.getTask({
      principal,
      agentId: AGENT,
      taskId: task.id,
      historyLength: 10,
    });
    assert.ok(Array.isArray(got.history));
    assert.equal(got.history.length, 2);
    assert.equal(got.history[0].role, 'user');
    assert.equal(got.history[1].role, 'agent');
    assert.equal(got.history[0].parts[0].text, 'first turn');
  });
});

describe('P2 message history projection', () => {
  it('maps durable messages to A2A Message objects', () => {
    const history = projectMessagesToA2aHistory(
      [
        {
          messageId: '01K0G2PAV8FPMVC9QHJG7JPN6A',
          role: 'user',
          contentJson: { text: 'hi' },
        },
        {
          messageId: '01K0G2PAV8FPMVC9QHJG7JPN6B',
          role: 'assistant',
          contentJson: { content: 'yo' },
        },
      ],
      { a2aTaskId: '01K0G2PAV8FPMVC9QHJG7JPN5E', contextId: 'ctx' },
    );
    assert.equal(history.length, 2);
    assert.equal(history[0].kind, 'message');
    assert.equal(history[0].contextId, 'ctx');
    assert.equal(history[1].role, 'agent');
  });
});

describe('P2 ListTasks method aliases', () => {
  it('normalizes tasks/list and ListTasks', () => {
    assert.equal(normalizeA2aMethod('tasks/list'), A2A_METHODS.LIST_TASKS);
    assert.equal(normalizeA2aMethod('ListTasks'), A2A_METHODS.LIST_TASKS);
  });
});

describe('buildA2aTaskObject history field', () => {
  it('omits empty history and includes non-empty', () => {
    const bare = buildA2aTaskObject({
      a2aTaskId: '01K0G2PAV8FPMVC9QHJG7JPN5E',
      runStatus: 'SUCCEEDED',
    });
    assert.equal(bare.history, undefined);
    const withHist = buildA2aTaskObject({
      a2aTaskId: '01K0G2PAV8FPMVC9QHJG7JPN5E',
      runStatus: 'SUCCEEDED',
      history: [{ kind: 'message', messageId: 'm1', role: 'user', parts: [] }],
    });
    assert.equal(withHist.history.length, 1);
  });
});
