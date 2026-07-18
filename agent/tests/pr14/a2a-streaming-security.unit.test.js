/**
 * PR-14 offline: A2A streaming, client isolation, credential expiry/rotation,
 * task-mapping duplicate side-effect compensation (plan §20 / §25.7–25.8).
 *
 * Authority is Agent /internal + A2A — not Sandbox /agent-runs (removed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2aStreamService,
  formatA2aSseHeartbeatComment,
} from '../../src/application/a2a/stream-service.js';
import {
  A2aTaskService,
  A2aTaskError,
  A2aAuditError,
  requireStableIdempotencyKey,
} from '../../src/application/a2a/task-service.js';
import {
  A2aCredentialService,
  A2aAuthError,
  normalizeFutureExpiresAt,
  evaluateStoredExpiry,
} from '../../src/application/a2a/credential-service.js';
import { deterministicA2aTaskId } from '../../src/application/a2a/deterministic-task-id.js';
import { ValidationError } from '../../src/application/errors.js';
import { A2A_CREDENTIAL_STATUS } from '../../src/infrastructure/mysql/repositories/a2a-credential-repository.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN4A';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5C';
const TRACE = 'a'.repeat(32);

function principal(clientId) {
  return {
    orgId: ORG,
    agentId: AGENT,
    serviceUserId: USER,
    clientId,
    credentialId: CRED,
    scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
  };
}

function evt(seq, type = 'run.started', status = 'RUNNING') {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let id = '01K0G2PAV8FPMVC9QHJG7';
  const pad = String(seq).padStart(5, '0');
  for (const ch of pad) id += alphabet[Number(ch) % 32];
  id = id.slice(0, 26);
  return {
    sequence: seq,
    eventId: id,
    event: { type, status, eventId: id },
    ts: seq,
  };
}

describe('PR-14 A2A: idempotency + mapping duplicate side effects', () => {
  it('requireStableIdempotencyKey rejects missing keys (no random fallback)', () => {
    assert.throws(() => requireStableIdempotencyKey({}), ValidationError);
    assert.equal(requireStableIdempotencyKey({ messageId: 'm1' }), 'm1');
  });

  it('mapping insert failure cancels Run; retry does not create second Run', async () => {
    let createCalls = 0;
    let cancelCalls = 0;
    const runsCreated = [];
    /** @type {Map<string, object>} */
    const tasks = new Map();
    /** @type {Map<string, object>} */
    const runs = new Map();
    let insertFailOnce = true;
    const audits = [];

    const svc = new A2aTaskService({
      createRunService: {
        async execute() {
          createCalls += 1;
          if (!runs.has(RUN)) {
            runs.set(RUN, {
              runId: RUN,
              status: 'ACCEPTED',
              conversationId: CONV,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            runsCreated.push(RUN);
          }
          return {
            runId: RUN,
            status: 'ACCEPTED',
            conversationId: CONV,
            replayed: createCalls > 1,
          };
        },
      },
      getRunService: {
        async execute({ runId }) {
          return runs.get(runId);
        },
      },
      cancelRunService: {
        async execute({ runId }) {
          cancelCalls += 1;
          const r = runs.get(runId);
          if (r) r.status = 'CANCELLING';
          return r;
        },
      },
      createRepositories: () => ({
        a2aTasks: {
          async insert(row) {
            if (insertFailOnce) {
              insertFailOnce = false;
              const err = new Error('dup');
              err.code = 'ER_DUP_ENTRY';
              throw err;
            }
            tasks.set(row.a2aTaskId, row);
            return row;
          },
          async getByRunId(runId, scope) {
            for (const t of tasks.values()) {
              if (
                t.runId === runId &&
                t.orgId === scope.orgId &&
                t.clientId === scope.clientId
              ) {
                return { ...t };
              }
            }
            return null;
          },
          async getById(id, scope) {
            const t = tasks.get(id);
            if (!t || t.orgId !== scope.orgId || t.clientId !== scope.clientId) {
              return null;
            }
            return { ...t };
          },
        },
        a2aAudit: {
          async append(row) {
            audits.push(row);
            return row;
          },
        },
      }),
      generateId: () => '01K0G2PAV8FPMVC9QHJG7JPN5Z',
      requireAudit: true,
    });

    const p = principal('client-a');
    await assert.rejects(
      () =>
        svc.sendMessage({
          principal: p,
          agentId: AGENT,
          params: {
            message: {
              messageId: 'stable-msg-pr14',
              parts: [{ kind: 'text', text: 'hi' }],
            },
          },
          traceId: TRACE,
          idempotencyKey: 'stable-msg-pr14',
        }),
      (e) => e instanceof A2aTaskError && e.code === 'A2A_MAPPING_FAILED',
    );
    assert.equal(cancelCalls, 1);
    assert.equal(runsCreated.length, 1);

    const task = await svc.sendMessage({
      principal: p,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'stable-msg-pr14',
          parts: [{ kind: 'text', text: 'hi' }],
        },
      },
      traceId: TRACE,
      idempotencyKey: 'stable-msg-pr14',
    });
    assert.equal(runsCreated.length, 1);
    assert.equal(task.id, deterministicA2aTaskId(ORG, 'client-a', RUN));
  });

  it('audit fail-closed prevents mutating send without audit row', async () => {
    const svc = new A2aTaskService({
      createRunService: {
        async execute() {
          return {
            runId: RUN,
            status: 'ACCEPTED',
            conversationId: CONV,
            replayed: false,
          };
        },
      },
      getRunService: { async execute() { return null; } },
      cancelRunService: { async execute() { return null; } },
      createRepositories: () => ({
        a2aTasks: {
          async insert(row) {
            return row;
          },
          async getByRunId() {
            return null;
          },
          async getById() {
            return null;
          },
        },
        a2aAudit: {
          async append() {
            throw new Error('audit store down');
          },
        },
      }),
      generateId: () => '01K0G2PAV8FPMVC9QHJG7JPN5Z',
      requireAudit: true,
    });

    await assert.rejects(
      () =>
        svc.sendMessage({
          principal: principal('c-audit'),
          agentId: AGENT,
          params: {
            message: {
              messageId: 'audit-msg',
              parts: [{ kind: 'text', text: 'x' }],
            },
          },
          traceId: TRACE,
          idempotencyKey: 'audit-msg',
        }),
      (e) => e instanceof A2aAuditError || e instanceof A2aTaskError,
    );
  });
});

describe('PR-14 A2A: client isolation + stream gap/resubscribe/disconnect', () => {
  it('client B cannot GetTask belonging to client A', async () => {
    const TASK = deterministicA2aTaskId(ORG, 'client-a', RUN);
    /** @type {Map<string, object>} */
    const tasks = new Map([
      [
        TASK,
        {
          a2aTaskId: TASK,
          orgId: ORG,
          clientId: 'client-a',
          runId: RUN,
          agentId: AGENT,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    ]);
    const runs = new Map([
      [
        RUN,
        {
          runId: RUN,
          status: 'RUNNING',
          conversationId: CONV,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    ]);

    const svc = new A2aTaskService({
      createRunService: { async execute() { throw new Error('unused'); } },
      getRunService: {
        async execute({ runId }) {
          return runs.get(runId);
        },
      },
      cancelRunService: { async execute() { return null; } },
      createRepositories: () => ({
        a2aTasks: {
          async getById(id, scope) {
            const t = tasks.get(id);
            if (!t || t.orgId !== scope.orgId || t.clientId !== scope.clientId) {
              return null;
            }
            return t;
          },
          async getByRunId() {
            return null;
          },
          async insert() {
            throw new Error('unused');
          },
        },
        a2aAudit: { async append(r) { return r; } },
      }),
      generateId: () => CRED,
      requireAudit: false,
    });

    await assert.rejects(
      () =>
        svc.getTask({
          principal: principal('client-b'),
          agentId: AGENT,
          taskId: TASK,
        }),
      (e) => e instanceof A2aTaskError && e.code === 'TASK_NOT_FOUND',
    );

    const ok = await svc.getTask({
      principal: principal('client-a'),
      agentId: AGENT,
      taskId: TASK,
    });
    assert.equal(ok.id, TASK);
  });

  it('stream gap: Redis skips seq → MySQL fills; resubscribe afterSequence skips earlier', async () => {
    const TASK = deterministicA2aTaskId(ORG, 'client-a', RUN);
    const mapping = {
      a2aTaskId: TASK,
      orgId: ORG,
      clientId: 'client-a',
      runId: RUN,
      agentId: AGENT,
    };
    const mysqlAll = [
      evt(1, 'run.accepted', 'ACCEPTED'),
      evt(2, 'run.started', 'RUNNING'),
      evt(3, 'run.succeeded', 'SUCCEEDED'),
    ];
    let phase = 'hist';

    const taskService = {
      async resolveOwnedTask(p, taskId) {
        assert.equal(p.clientId, 'client-a');
        assert.equal(taskId, TASK);
        return { ...mapping, contextId: CONV };
      },
      runAuthForPrincipal(p) {
        return {
          provider: 'a2a',
          externalOrgId: p.orgId,
          externalUserId: p.serviceUserId,
        };
      },
      async getTask() {
        return {
          id: TASK,
          status: { state: 'working' },
          contextId: CONV,
        };
      },
    };

    const eventQueryService = {
      async listEvents({ afterSequence = 0 }) {
        if (phase === 'hist') {
          if (afterSequence < 1) {
            return {
              events: [mysqlAll[0]],
              terminal: false,
              status: 'RUNNING',
            };
          }
          phase = 'live';
          return { events: [], terminal: false, status: 'RUNNING' };
        }
        const page = mysqlAll.filter((e) => e.sequence > afterSequence);
        return {
          events: page,
          terminal: afterSequence >= 3 || page.some((e) => e.sequence === 3),
          status: 'SUCCEEDED',
        };
      },
    };

    let redisN = 0;
    const runEventStream = {
      async readAfter() {
        redisN += 1;
        phase = 'live';
        if (redisN === 1) {
          return [
            {
              streamId: '1-0',
              eventId: mysqlAll[2].eventId,
              sequence: '3',
              type: 'run.succeeded',
              payload: JSON.stringify({ status: 'SUCCEEDED' }),
              createdAt: '2026-07-18T00:00:00.000Z',
            },
          ];
        }
        return [];
      },
    };

    const stream = new A2aStreamService({
      taskService,
      eventQueryService,
      getRunService: {
        async execute() {
          return {
            runId: RUN,
            status: redisN > 0 ? 'SUCCEEDED' : 'RUNNING',
            conversationId: CONV,
          };
        },
      },
      runEventStream,
      pollMs: 2,
      heartbeatMs: 60_000,
      mysqlCatchupMs: 1,
    });

    const frames = [];
    const result = await stream.openTaskStream(
      {
        principal: principal('client-a'),
        agentId: AGENT,
        taskId: TASK,
        rpcId: 1,
        afterSequence: 0,
        includeInitialTask: false,
      },
      {
        write: (c) => {
          frames.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );
    const joined = frames.join('');
    // Gap fill: metadata.sequence must be contiguous 1→2→3 (never skip 2)
    const metaSeqs = [...joined.matchAll(/"sequence"\s*:\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    const unique = [...new Set(metaSeqs)].sort((a, b) => a - b);
    assert.deepEqual(unique, [1, 2, 3]);
    assert.equal(result.lastSequence, 3);

    // Resubscribe afterSequence=2 must not re-emit earlier sequences
    const eventQuery2 = {
      async listEvents({ afterSequence = 0 }) {
        const page = mysqlAll.filter((e) => e.sequence > afterSequence);
        return {
          events: page,
          terminal: true,
          status: 'SUCCEEDED',
        };
      },
    };
    const stream2 = new A2aStreamService({
      taskService,
      eventQueryService: eventQuery2,
      getRunService: {
        async execute() {
          return { runId: RUN, status: 'SUCCEEDED', conversationId: CONV };
        },
      },
      runEventStream: null,
      pollMs: 2,
      heartbeatMs: 60_000,
    });
    const frames2 = [];
    await stream2.openTaskStream(
      {
        principal: principal('client-a'),
        agentId: AGENT,
        taskId: TASK,
        rpcId: 2,
        afterSequence: 2,
        includeInitialTask: false,
      },
      {
        write: (c) => {
          frames2.push(c);
          return true;
        },
        isClosed: () => false,
      },
    );
    const j2 = frames2.join('');
    const seqs2 = [...j2.matchAll(/"sequence"\s*:\s*(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    assert.ok(seqs2.every((s) => s > 2));
    assert.ok(seqs2.includes(3));
  });

  it('client disconnect aborts stream without cancelTask', async () => {
    const TASK = deterministicA2aTaskId(ORG, 'client-a', RUN);
    let cancelCalls = 0;
    const taskService = {
      async resolveOwnedTask() {
        return {
          a2aTaskId: TASK,
          orgId: ORG,
          clientId: 'client-a',
          runId: RUN,
          agentId: AGENT,
        };
      },
      runAuthForPrincipal(p) {
        return {
          provider: 'a2a',
          externalOrgId: p.orgId,
          externalUserId: p.serviceUserId,
        };
      },
      async getTask() {
        return { id: TASK, status: { state: 'working' } };
      },
      async cancelTask() {
        cancelCalls += 1;
      },
    };
    const ac = new AbortController();
    const stream = new A2aStreamService({
      taskService,
      eventQueryService: {
        async listEvents() {
          return { events: [], terminal: false, status: 'RUNNING' };
        },
      },
      getRunService: {
        async execute() {
          return { runId: RUN, status: 'RUNNING', conversationId: CONV };
        },
      },
      pollMs: 5,
      heartbeatMs: 60_000,
      sleep: async (_ms, signal) => {
        ac.abort();
        if (signal?.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        }
      },
    });
    await stream.openTaskStream(
      {
        principal: principal('client-a'),
        agentId: AGENT,
        taskId: TASK,
        rpcId: 9,
        afterSequence: 0,
        includeInitialTask: false,
      },
      {
        write: () => true,
        isClosed: () => false,
        signal: ac.signal,
      },
    );
    assert.equal(cancelCalls, 0);
  });

  it('A2A heartbeat is SSE comment only (not data: JSON-RPC)', () => {
    const hb = formatA2aSseHeartbeatComment('2026-07-18T00:00:00.000Z');
    assert.match(hb, /^: ping /);
    assert.doesNotMatch(hb, /^data:/m);
  });
});

describe('PR-14 A2A: credential expiry + rotation', () => {
  function makeStore() {
    /** @type {Map<string, object>} */
    const byId = new Map();
    /** @type {Map<string, object>} */
    const byKey = new Map();
    return {
      byId,
      byKey,
      createRepositories() {
        return {
          a2aCredentials: {
            async insert(input) {
              if (byKey.has(input.keyId)) {
                const err = new Error('dup');
                err.code = 'ER_DUP_ENTRY';
                throw err;
              }
              const row = {
                credentialId: input.credentialId,
                orgId: input.orgId,
                agentId: input.agentId,
                serviceUserId: input.serviceUserId,
                clientId: input.clientId,
                keyId: input.keyId,
                secretHash: input.secretHash,
                scopes: input.scopes,
                status: input.status,
                expiresAt: input.expiresAt
                  ? new Date(input.expiresAt).toISOString()
                  : null,
                rotatedFromId: input.rotatedFromId ?? null,
                lastUsedAt: null,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              };
              byId.set(row.credentialId, row);
              byKey.set(row.keyId, row);
              return row;
            },
            async getById(id) {
              return byId.get(id) || null;
            },
            async getByKeyId(keyId) {
              return byKey.get(keyId.toLowerCase()) || null;
            },
            async updateStatus(id, status, opts = {}) {
              const row = byId.get(id);
              if (!row) {
                throw Object.assign(new Error('nf'), { name: 'NotFoundError' });
              }
              if (opts.expectedStatus) {
                const exp = Array.isArray(opts.expectedStatus)
                  ? opts.expectedStatus
                  : [opts.expectedStatus];
                if (!exp.includes(row.status)) {
                  throw Object.assign(new Error('cas'), { name: 'NotFoundError' });
                }
              }
              row.status = status;
              return row;
            },
            async touchLastUsed() {},
          },
        };
      },
    };
  }

  it('past expiresAt rejected; expired stored credential fails auth', async () => {
    assert.throws(
      () => normalizeFutureExpiresAt('2020-01-01T00:00:00.000Z'),
      /future/,
    );
    assert.equal(evaluateStoredExpiry('2020-01-01T00:00:00.000Z'), 'expired');

    const store = makeStore();
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => CRED,
      now: () => new Date('2026-07-18T00:00:00.000Z'),
    });

    const issued = await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'rot-c',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    assert.ok(issued.token);
    assert.equal(issued.credential?.secretHash, undefined);

    // Force expiry on stored row
    store.byId.get(CRED).expiresAt = '2020-01-01T00:00:00.000Z';

    await assert.rejects(
      () => svc.authenticate(`Bearer ${issued.token}`, { agentId: AGENT }),
      (e) => e instanceof A2aAuthError,
    );
  });

  it('rotation CAS: old token dead after successful rotate', async () => {
    let n = 0;
    const store = makeStore();
    const ids = [
      '01K0G2PAV8FPMVC9QHJG7JPN5C',
      '01K0G2PAV8FPMVC9QHJG7JPN5D',
    ];
    const svc = new A2aCredentialService({
      createRepositories: store.createRepositories,
      generateId: () => ids[n++] || ids[ids.length - 1],
      now: () => new Date('2026-07-18T00:00:00.000Z'),
      transactionManager: {
        async run(fn) {
          return fn(null);
        },
      },
    });
    const issued = await svc.issue({
      orgId: ORG,
      agentId: AGENT,
      serviceUserId: USER,
      clientId: 'rot-2',
      expiresAt: '2026-12-01T00:00:00.000Z',
    });
    const rotated = await svc.rotate({
      credentialId: CRED,
      orgId: ORG,
    });
    assert.notEqual(rotated.token, issued.token);
    await assert.rejects(
      () => svc.authenticate(`Bearer ${issued.token}`, { agentId: AGENT }),
      A2aAuthError,
    );
    const ok = await svc.authenticate(`Bearer ${rotated.token}`, {
      agentId: AGENT,
    });
    assert.equal(ok.clientId, 'rot-2');
    assert.equal(store.byId.get(CRED).status, A2A_CREDENTIAL_STATUS.ROTATED);
  });
});
