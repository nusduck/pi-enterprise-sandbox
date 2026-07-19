/**
 * STATUS G6 — GET Run attaches pending_input for WAITING_INPUT so refresh works.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { GetRunService } from '../../src/application/get-run-service.js';
import { presentGetRunResponse } from '../../src/bootstrap/create-http-server.js';
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
const TRACE = 'd'.repeat(32);
const NOW = '2026-07-19 01:02:03.004';
const AUTH = {
  provider: 'bff',
  externalOrgId: 'org-ext-1',
  externalUserId: 'user-ext-1',
};

function seed(state, status = 'WAITING_INPUT') {
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
      status,
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
      arguments_json: '{}',
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
}

describe('GetRunService pending_input projection (G6)', () => {
  let state;
  let service;

  beforeEach(() => {
    state = createFakeState();
    seed(state);
    const knex = createFakeKnex(state);
    const generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    service = new GetRunService({
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
          generateId,
        }),
      db: knex,
    });
  });

  it('attaches pending interaction fields when Run is WAITING_INPUT', async () => {
    const run = await service.execute({ runId: RUN, auth: AUTH });
    assert.equal(run.status, 'WAITING_INPUT');
    assert.ok(run.pendingInput, 'pendingInput must be attached');
    assert.equal(run.pendingInput.interactionId, INTERACTION);
    assert.equal(run.pendingInput.interactionType, 'select');
    assert.equal(run.pendingInput.title, 'Choose a region');
    assert.deepEqual(run.pendingInput.options, ['eu', 'us']);

    const body = presentGetRunResponse(run);
    assert.equal(body.pending_input.interaction_id, INTERACTION);
    assert.equal(body.pendingInput.interactionId, INTERACTION);
    assert.equal(body.pending_input.title, 'Choose a region');
  });

  it('omits pending_input when Run is not waiting', async () => {
    state.tables.runs[0].status = 'RUNNING';
    const run = await service.execute({ runId: RUN, auth: AUTH });
    assert.equal(run.pendingInput, undefined);
    const body = presentGetRunResponse(run);
    assert.equal(body.pending_input, null);
  });
});
