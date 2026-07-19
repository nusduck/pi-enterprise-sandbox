/**
 * A2A audit correlation (F6) — org_id + client_id + trace_id on the shipped path.
 *
 * Drives A2aTaskService → A2aAuditRepository.append (real repo + fake knex)
 * and asserts durable rows carry the correlation triple.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { A2aTaskService } from '../../src/application/a2a/task-service.js';
import {
  A2aAuditRepository,
  mapA2aAuditEvent,
} from '../../src/infrastructure/mysql/repositories/a2a-audit-repository.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { OwnerScopedNotFoundError } from '../../src/application/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const AGENT = '01K0G2PAV8FPMVC9QHJG7JPN5D';
const CRED = '01K0G2PAV8FPMVC9QHJG7JPN5E';
const TRACE = 'b'.repeat(32);

function makeWorld() {
  const state = createFakeState();
  state.tables.a2a_audit_events = [];
  const knex = createFakeKnex(state);

  /** @type {Map<string, object>} */
  const tasks = new Map();
  /** @type {Map<string, object>} */
  const runs = new Map();
  let idSeq = 0;
  const gen = () => {
    const suffixes = 'EFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const s = suffixes[idSeq % suffixes.length];
    idSeq += 1;
    return `01K0G2PAV8FPMVC9QHJG7JPN6${s}`;
  };

  const principal = {
    orgId: ORG,
    agentId: AGENT,
    serviceUserId: USER,
    clientId: 'client-corr-a',
    credentialId: CRED,
    scopes: ['agent.invoke', 'agent.read', 'agent.cancel', 'artifact.read'],
  };

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
    },
    // Real durable audit repository (not a mock).
    a2aAudit: new A2aAuditRepository(knex, {
      now: () => new Date('2026-07-19T12:00:00.000Z'),
    }),
  });

  const createRunService = {
    async execute(input) {
      runs.set(RUN, {
        runId: RUN,
        status: 'ACCEPTED',
        conversationId: CONV,
        orgId: ORG,
        userId: USER,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        clientKey: input.auth.externalUserId,
      });
      return {
        runId: RUN,
        status: 'ACCEPTED',
        conversationId: CONV,
        eventsUrl: `/api/runs/${RUN}/events`,
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
      r.status = 'CANCELLING';
      r.cancelRequested = true;
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

  return { svc, principal, state, tasks, runs };
}

describe('A2A audit org/client/trace correlation (shipped path)', () => {
  it('SendMessage persists audit row with org_id, client_id, and trace_id', async () => {
    const { svc, principal, state } = makeWorld();

    const task = await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'corr-msg-1',
          role: 'user',
          parts: [{ kind: 'text', text: 'correlate me' }],
        },
      },
      traceId: TRACE,
      idempotencyKey: 'corr-msg-1',
    });

    assert.ok(task.id);
    assert.equal(state.tables.a2a_audit_events.length, 1);
    const raw = state.tables.a2a_audit_events[0];
    assert.equal(raw.org_id, ORG);
    assert.equal(raw.client_id, principal.clientId);
    assert.equal(raw.trace_id, TRACE);
    assert.equal(raw.run_id, RUN);
    assert.equal(raw.event_type, 'a2a.send_message');
    assert.equal(raw.agent_id, AGENT);
    assert.equal(raw.a2a_task_id, task.id);

    const mapped = mapA2aAuditEvent(raw);
    assert.equal(mapped.orgId, ORG);
    assert.equal(mapped.clientId, principal.clientId);
    assert.equal(mapped.traceId, TRACE);
    assert.equal(mapped.runId, RUN);
  });

  it('CancelTask and artifact download keep the same correlation triple', async () => {
    const { svc, principal, state } = makeWorld();

    const task = await svc.sendMessage({
      principal,
      agentId: AGENT,
      params: {
        message: {
          messageId: 'corr-cancel-1',
          parts: [{ kind: 'text', text: 'x' }],
        },
      },
      traceId: TRACE,
      idempotencyKey: 'corr-cancel-1',
    });

    await svc.cancelTask({
      principal,
      agentId: AGENT,
      taskId: task.id,
      traceId: TRACE,
    });

    await svc.auditArtifactDownload({
      principal,
      agentId: AGENT,
      taskId: task.id,
      runId: RUN,
      artifactId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
      traceId: TRACE,
    });

    const rows = state.tables.a2a_audit_events.map(mapA2aAuditEvent);
    const types = rows.map((r) => r.eventType);
    assert.ok(types.includes('a2a.send_message'));
    assert.ok(types.includes('a2a.cancel_task'));
    assert.ok(types.includes('a2a.artifact_download'));

    for (const row of rows) {
      assert.equal(row.orgId, ORG, `${row.eventType} missing orgId`);
      assert.equal(
        row.clientId,
        principal.clientId,
        `${row.eventType} missing clientId`,
      );
      assert.equal(row.traceId, TRACE, `${row.eventType} missing traceId`);
    }
  });

  it('repository rejects empty clientId and drops all-zero / invalid trace ids', async () => {
    const state = createFakeState();
    state.tables.a2a_audit_events = [];
    const knex = createFakeKnex(state);
    const repo = new A2aAuditRepository(knex, {
      now: () => new Date('2026-07-19T12:00:00.000Z'),
    });

    await assert.rejects(
      () =>
        repo.append({
          auditId: '01K0G2PAV8FPMVC9QHJG7JPN6A',
          orgId: ORG,
          clientId: '  ',
          eventType: 'a2a.test',
        }),
      /clientId is required/,
    );

    const accepted = await repo.append({
      auditId: '01K0G2PAV8FPMVC9QHJG7JPN6B',
      orgId: ORG,
      clientId: 'client-x',
      eventType: 'a2a.test',
      traceId: '0'.repeat(32),
    });
    assert.equal(accepted.traceId, null);
    assert.equal(state.tables.a2a_audit_events[0].trace_id, null);

    const valid = await repo.append({
      auditId: '01K0G2PAV8FPMVC9QHJG7JPN6C',
      orgId: ORG,
      clientId: 'client-x',
      eventType: 'a2a.test',
      traceId: TRACE.toUpperCase(),
    });
    assert.equal(valid.traceId, TRACE);
  });
});
