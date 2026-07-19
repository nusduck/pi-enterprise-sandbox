/**
 * TraceQueryService shipped path — owner-scoped listForRun / listByTrace.
 * Offline fakes only; drives real TraceQueryService + TraceSpanRepository.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TraceQueryService } from '../../src/application/trace-query-service.js';
import {
  TraceSpanRepository,
  deriveSpanId,
  runRootSpanId,
} from '../../src/infrastructure/mysql/repositories/trace-span-repository.js';
import { RunRepository } from '../../src/infrastructure/mysql/repositories/run-repository.js';
import { OrganizationRepository } from '../../src/infrastructure/mysql/repositories/organization-repository.js';
import { ExternalReferenceRepository } from '../../src/infrastructure/mysql/repositories/external-reference-repository.js';
import { formatUserExternalSubject } from '../../src/infrastructure/mysql/repositories/organization-repository.js';
import { OwnerScopedNotFoundError, ValidationError } from '../../src/application/errors.js';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const TOOL_EXEC = '01K0G2PAV8FPMVC9QHJG7JPN54';
const AGENT_VER = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const MSG = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'a'.repeat(32);
const AUTH = {
  provider: 'bff',
  externalOrgId: '550e8400-e29b-41d4-a716-446655440000',
  externalUserId: '660e8400-e29b-41d4-a716-446655440001',
};

/**
 * Seed owner mapping + one Run with durable facts that materialize into spans.
 * @param {ReturnType<typeof createFakeState>} state
 * @param {ReturnType<typeof createFakeKnex>} knex
 */
async function seedOwnedRun(state, knex) {
  const orgs = new OrganizationRepository(knex, {
    now: () => new Date('2026-07-19T00:00:00.000Z'),
  });
  const refs = new ExternalReferenceRepository(knex, {
    now: () => new Date('2026-07-19T00:00:00.000Z'),
  });

  state.tables.organizations = [
    {
      org_id: ORG,
      name: 'Test Org',
      status: 'active',
      created_at: '2026-07-19 00:00:00.000',
      updated_at: '2026-07-19 00:00:00.000',
    },
  ];
  await refs.createOrganizationRef({
    provider: AUTH.provider,
    externalSubject: AUTH.externalOrgId,
    orgId: ORG,
  });
  await orgs.createUser({
    userId: USER,
    externalSubject: formatUserExternalSubject(
      AUTH.provider,
      AUTH.externalUserId,
    ),
    displayName: 'Test User',
    status: 'active',
  });
  await orgs.addMembership({
    orgId: ORG,
    userId: USER,
    role: 'member',
    status: 'active',
  });

  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESS,
      agent_version_id: AGENT_VER,
      triggering_message_id: MSG,
      source: 'web',
      status: 'SUCCEEDED',
      status_reason: null,
      queue_name: 'default',
      attempt: 1,
      trace_id: TRACE,
      trace_state: null,
      trace_flags: '01',
      trace_parent_span_id: null,
      next_event_sequence: 2,
      started_at: '2026-07-19 00:00:00.000',
      completed_at: '2026-07-19 00:00:04.000',
      created_at: '2026-07-19 00:00:00.000',
      updated_at: '2026-07-19 00:00:04.000',
      cancel_requested_at: null,
      cancel_reason: null,
      cancel_requested_by: null,
    },
  ];
  state.tables.run_events = [
    {
      event_id: '01K0G2PAV8FPMVC9QHJG7JPN58',
      run_id: RUN,
      org_id: ORG,
      sequence_no: 1,
      event_type: 'run.started',
      event_version: 1,
      payload_json: JSON.stringify({ status: 'STARTING' }),
      trace_id: TRACE,
      span_id: null,
      created_at: '2026-07-19 00:00:00.000',
    },
    {
      event_id: '01K0G2PAV8FPMVC9QHJG7JPN59',
      run_id: RUN,
      org_id: ORG,
      sequence_no: 2,
      event_type: 'tool.execution.completed',
      event_version: 1,
      payload_json: JSON.stringify({
        data: {
          toolCallId: 'call-1',
          toolExecutionId: TOOL_EXEC,
          toolName: 'bash',
        },
      }),
      trace_id: TRACE,
      span_id: null,
      created_at: '2026-07-19 00:00:02.000',
    },
  ];
  state.tables.tool_executions = [
    {
      tool_execution_id: TOOL_EXEC,
      tool_call_id: 'call-1',
      run_id: RUN,
      trace_id: TRACE,
      agent_session_id: SESS,
      tool_source: 'builtin',
      tool_name: 'bash',
      status: 'SUCCEEDED',
      risk_level: 'low',
      error_code: null,
      started_at: '2026-07-19 00:00:01.000',
      completed_at: '2026-07-19 00:00:02.000',
      created_at: '2026-07-19 00:00:01.000',
    },
  ];
  state.tables.sandbox_executions = [];
  state.tables.artifacts = [];
  state.tables.a2a_tasks = [];
  state.tables.trace_spans = [];
}

function buildService(state, knex) {
  return new TraceQueryService({
    db: knex,
    createRepositories: () => ({
      organizations: new OrganizationRepository(knex, {
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      }),
      externalRefs: new ExternalReferenceRepository(knex, {
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      }),
      runs: new RunRepository(knex, {
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      }),
      traceSpans: new TraceSpanRepository(knex, {
        now: () => new Date('2026-07-19T00:00:00.000Z'),
      }),
    }),
    defaultProvider: 'bff',
  });
}

describe('TraceQueryService listForRun (shipped durable path)', () => {
  it('materializes owner-scoped span tree for a Run and returns dual-key contract', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    await seedOwnedRun(state, knex);
    const svc = buildService(state, knex);

    const page = await svc.listForRun({ runId: RUN, auth: AUTH, limit: 500 });

    assert.equal(page.traceId, TRACE);
    assert.equal(page.trace_id, TRACE);
    assert.equal(page.runId, RUN);
    assert.equal(page.run_id, RUN);
    assert.equal(page.truncated, false);
    assert.equal(page.nextCursor, null);

    const kinds = page.spans.map((s) => s.kind).sort();
    assert.ok(kinds.includes('run'));
    assert.ok(kinds.includes('tool'));

    const root = page.spans.find((s) => s.kind === 'run');
    const tool = page.spans.find((s) => s.kind === 'tool');
    assert.ok(root);
    assert.ok(tool);
    assert.equal(root.spanId, runRootSpanId(TRACE, RUN));
    assert.equal(root.orgId, ORG);
    assert.equal(root.userId, USER);
    assert.equal(root.status, 'ok');
    assert.equal(tool.spanId, deriveSpanId(TRACE, 'tool', 'call-1'));
    assert.equal(tool.parentSpanId, root.spanId);
    assert.equal(tool.name, 'bash');
    assert.equal(tool.status, 'ok');
    // Public projection must not leak the private watermark.
    assert.equal(root.attributes.projectedSequence, undefined);
  });

  it('listByTrace resolves the owned Run then returns the same tree', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    await seedOwnedRun(state, knex);
    const svc = buildService(state, knex);

    const page = await svc.listByTrace({ traceId: TRACE, auth: AUTH });
    assert.equal(page.runId, RUN);
    assert.equal(page.traceId, TRACE);
    assert.ok(page.spans.some((s) => s.kind === 'tool'));
  });

  it('foreign owner cannot list spans for another subject Run', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    await seedOwnedRun(state, knex);
    const svc = buildService(state, knex);

    await assert.rejects(
      () =>
        svc.listForRun({
          runId: RUN,
          auth: {
            ...AUTH,
            externalUserId: '770e8400-e29b-41d4-a716-446655440099',
          },
        }),
      (err) => err instanceof OwnerScopedNotFoundError,
    );
  });

  it('rejects invalid cursor and missing auth with ValidationError', async () => {
    const state = createFakeState();
    const knex = createFakeKnex(state);
    await seedOwnedRun(state, knex);
    const svc = buildService(state, knex);

    await assert.rejects(
      () => svc.listForRun({ runId: RUN, auth: AUTH, cursor: 'not-a-span-id' }),
      (err) => err instanceof ValidationError,
    );
    await assert.rejects(
      () => svc.listForRun({ runId: RUN, auth: null }),
      (err) => err instanceof ValidationError,
    );
  });
});
