/**
 * STATUS G6 — HTTP surface for durable interaction respond + rehydrate.
 * Drives createAgentHttpServer with the shipped InteractionResponseService.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { InteractionResponseService } from '../../src/application/interaction-response-service.js';
import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TRIGGER = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN56';
const INTERACTION = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'c'.repeat(32);
const NOW = '2026-07-19 01:02:03.004';
const TOKEN = 'test-internal-token-for-interaction-http';
const AUTH = {
  provider: 'bff',
  externalOrgId: 'org-ext-1',
  externalUserId: 'user-ext-1',
};

function makeIdGenerator() {
  return createUlidGenerator({ now: () => 1_721_278_800_000 });
}

function seed(state) {
  state.tables.organizations = [
    { org_id: ORG, name: 'Acme', status: 'active', created_at: NOW, updated_at: NOW },
  ];
  state.tables.users = [
    {
      user_id: USER,
      external_subject: 'bff:user-ext-1',
      display_name: 'Test',
      email: null,
      status: 'active',
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.organization_memberships = [
    { org_id: ORG, user_id: USER, role: 'member', status: 'active', created_at: NOW },
  ];
  state.tables.organization_external_refs = [
    { provider: 'bff', external_subject: 'org-ext-1', org_id: ORG, created_at: NOW },
  ];
  state.tables.user_external_refs = [
    { provider: 'bff', external_subject: 'user-ext-1', user_id: USER, created_at: NOW },
  ];
  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONV,
      agent_session_id: SESSION,
      agent_version_id: VERSION,
      triggering_message_id: TRIGGER,
      source: 'api',
      status: 'WAITING_INPUT',
      status_reason: 'user interaction pending',
      queue_name: 'runs',
      attempt: 1,
      trace_id: TRACE,
      next_event_sequence: 0,
      cancel_requested_at: null,
      cancel_reason: null,
      cancel_requested_by: null,
      started_at: NOW,
      completed_at: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
  state.tables.tool_executions = [
    {
      tool_execution_id: TOOL,
      run_id: RUN,
      agent_session_id: SESSION,
      tool_call_id: 'ask-user-1',
      tool_name: 'ask_user',
      tool_source: 'internal',
      risk_level: 'low',
      arguments_json: JSON.stringify({ interaction_type: 'select' }),
      result_json: null,
      status: 'RUNNING',
      error_code: null,
      trace_id: TRACE,
      request_hash: null,
      request_hash_version: null,
      execution_fence_token: null,
      started_at: NOW,
      completed_at: null,
      created_at: NOW,
    },
  ];
  state.tables.run_interactions = [
    {
      interaction_id: INTERACTION,
      org_id: ORG,
      user_id: USER,
      run_id: RUN,
      agent_session_id: SESSION,
      tool_execution_id: TOOL,
      tool_call_id: 'ask-user-1',
      interaction_type: 'select',
      request_json: JSON.stringify({
        title: 'Choose a region',
        message: 'Where should we deploy?',
        options: ['eu', 'us'],
      }),
      status: 'PENDING',
      response_json: null,
      response_hash: null,
      responded_by: null,
      resume_phase: 'NONE',
      resume_claimed_at: null,
      created_at: NOW,
      resolved_at: null,
    },
  ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function req(port, method, urlPath, { headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Token': TOKEN,
      'X-Acting-User-Id': AUTH.externalUserId,
      'X-Acting-Organization-Id': AUTH.externalOrgId,
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, text };
}

function stubServices() {
  return {
    createRunService: { async execute() { return { runId: RUN }; } },
    getRunService: { async execute() { return { runId: RUN, status: 'WAITING_INPUT' }; } },
    cancelRunService: { async execute() { return { ok: true }; } },
    eventQueryService: { async listEvents() { return { events: [] }; } },
  };
}

describe('interaction HTTP durable surface (G6)', () => {
  /** @type {http.Server} */
  let server;
  let port;
  let state;
  let queued;

  beforeEach(async () => {
    state = createFakeState();
    seed(state);
    const knex = createFakeKnex(state);
    const generateId = makeIdGenerator();
    queued = [];
    const interactionResponseService = new InteractionResponseService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
          generateId,
        }),
      runQueue: {
        async enqueue(ref) {
          queued.push(ref);
          return { id: ref.runId };
        },
      },
      generateId,
      now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
    });
    server = createAgentHttpServer({
      ...stubServices(),
      config: { AGENT_INTERNAL_TOKEN: TOKEN },
      interactionResponseService,
    });
    port = await listen(server);
  });

  afterEach(async () => {
    if (server) await new Promise((r) => server.close(r));
  });

  it('responds to a pending interaction and wakes the Run (not 501)', async () => {
    const res = await req(
      port,
      'POST',
      `/internal/agent-runs/${RUN}/interactions/${INTERACTION}/respond`,
      { body: { response: 'eu' } },
    );
    assert.notEqual(res.status, 501, `must not be NOT_IMPLEMENTED: ${res.text}`);
    assert.ok(
      res.status >= 200 && res.status < 300,
      `unexpected status ${res.status}: ${res.text}`,
    );
    assert.equal(state.tables.run_interactions[0].status, 'RESOLVED');
    assert.ok(queued.length >= 1, 'resolved interaction must enqueue a worker wake');
  });

  it('rehydrates waiting interactions for restart/refresh recovery', async () => {
    const res = await req(port, 'POST', '/internal/agent-runs/rehydrate-waiting', {
      body: { runId: RUN },
    });
    assert.notEqual(res.status, 501, `must not be NOT_IMPLEMENTED: ${res.text}`);
    assert.ok(
      res.status >= 200 && res.status < 300,
      `unexpected status ${res.status}: ${res.text}`,
    );
    assert.ok(res.json != null, 'rehydrate must return a JSON body');
  });
});
