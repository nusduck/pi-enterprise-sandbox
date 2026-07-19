/**
 * Offline unit coverage for RunRecoveryService WAITING_INPUT / interaction
 * re-enqueue paths (STATUS A4 session-adjacent + G2 mid-waiting-input cell).
 *
 * Restart matrix (A4 multi-turn Session + G2 Agent Worker restart)
 * ----------------------------------------------------------------
 * Cell                         Offline unit                         Live release-gate (opt-in)
 * ---------------------------- ------------------------------------ ------------------------------------------
 * Graceful stop / drain        worker-main shutdown DI only         missing dedicated gate
 * SIGKILL mid-run (pre-tool)   execute-run.unit (lease-free replay) agent-worker-restart + pi-restart (evidence)
 * SIGKILL mid-tool             execute-run.unit (UNKNOWN manual)    agent-worker-restart + pi-restart (evidence)
 * Mid-waiting-input (PENDING)  this file                            pi-restart interaction case (not re-run here)
 * Mid-waiting-input (RESOLVED) this file                            pi-restart interaction case (not re-run here)
 * Session rehydrate            session-recovery.unit                pi-restart checkpoint assertions
 * Journal replay               session-recovery + pi-session-journal missing dedicated hard-kill journal live
 *
 * Pi-native only: recovery re-enqueues ref jobs; Session rebuild stays in
 * SessionRecoveryService / Pi JSONL — no second agent loop.
 */

import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from '../mysql/fake-knex.js';
import { createRepositoryBundle } from '../../src/bootstrap/container.js';
import { RunRecoveryService } from '../../src/application/run-recovery-service.js';
import { createUlidGenerator } from '../../src/domain/shared/ulid.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import {
  INTERACTION_RESUME_PHASE,
  INTERACTION_STATUS,
} from '../../src/domain/interaction/interaction-status.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONVERSATION = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VERSION = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TRIGGER = '01K0G2PAV8FPMVC9QHJG7JPN55';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN56';
const INTERACTION = '01K0G2PAV8FPMVC9QHJG7JPN57';
const TRACE = 'b'.repeat(32);
const NOW = '2026-07-19 01:02:03.004';

/**
 * @param {ReturnType<typeof createFakeState>} state
 * @param {{
 *   runStatus?: string,
 *   interactionStatus?: string | null,
 *   resumePhase?: string,
 *   toolStatus?: string,
 * }} [opts]
 */
function seed(state, opts = {}) {
  const runStatus = opts.runStatus ?? RUN_STATUS.WAITING_INPUT;
  const interactionStatus =
    opts.interactionStatus === undefined
      ? INTERACTION_STATUS.PENDING
      : opts.interactionStatus;
  const resumePhase = opts.resumePhase ?? INTERACTION_RESUME_PHASE.NONE;
  const toolStatus = opts.toolStatus ?? 'RUNNING';

  state.tables.runs = [
    {
      run_id: RUN,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONVERSATION,
      agent_session_id: SESSION,
      agent_version_id: VERSION,
      triggering_message_id: TRIGGER,
      source: 'api',
      status: runStatus,
      status_reason: 'user interaction pending',
      queue_name: 'runs',
      attempt: 1,
      trace_id: TRACE,
      trace_state: null,
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
      result_json:
        interactionStatus === INTERACTION_STATUS.RESOLVED
          ? JSON.stringify({ interactionId: INTERACTION, response: 'eu' })
          : null,
      status: toolStatus,
      error_code: null,
      trace_id: TRACE,
      request_hash: null,
      request_hash_version: null,
      execution_fence_token: null,
      started_at: NOW,
      completed_at:
        toolStatus === 'SUCCEEDED' || toolStatus === 'FAILED' ? NOW : null,
      created_at: NOW,
    },
  ];
  state.tables.run_interactions =
    interactionStatus == null
      ? []
      : [
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
            status: interactionStatus,
            response_json:
              interactionStatus === INTERACTION_STATUS.RESOLVED
                ? JSON.stringify('eu')
                : null,
            response_hash:
              interactionStatus === INTERACTION_STATUS.RESOLVED
                ? 'a'.repeat(64)
                : null,
            responded_by:
              interactionStatus === INTERACTION_STATUS.RESOLVED ? USER : null,
            resume_phase: resumePhase,
            resume_claimed_at:
              resumePhase === INTERACTION_RESUME_PHASE.CLAIMED ||
              resumePhase === INTERACTION_RESUME_PHASE.APPLIED
                ? NOW
                : null,
            resume_applied_at:
              resumePhase === INTERACTION_RESUME_PHASE.APPLIED ? NOW : null,
            cancelled_at: null,
            created_at: NOW,
            resolved_at:
              interactionStatus === INTERACTION_STATUS.RESOLVED ? NOW : null,
          },
        ];
  state.tables.run_events = [];
  state.tables.domain_outbox = [];
  state.tables.trace_spans = [];
  state.tables.agent_sessions = [
    {
      agent_session_id: SESSION,
      org_id: ORG,
      user_id: USER,
      conversation_id: CONVERSATION,
      agent_version_id: VERSION,
      workspace_id: '01K0G2PAV8FPMVC9QHJG7JPN5G',
      status: 'ACTIVE',
      execution_fence_token: 1,
      pi_session_version: 0,
      last_run_id: null,
      created_at: NOW,
      updated_at: NOW,
    },
  ];
}

describe('RunRecoveryService WAITING_INPUT restart cells (offline)', () => {
  /** @type {ReturnType<typeof createFakeState>} */
  let state;
  /** @type {ReturnType<typeof createFakeKnex>} */
  let knex;
  /** @type {Array<{ ref: object, options?: object }>} */
  let enqueued;
  /** @type {RunRecoveryService} */
  let recovery;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    enqueued = [];
    const generateId = createUlidGenerator({ now: () => 1_721_278_800_000 });
    recovery = new RunRecoveryService({
      transactionManager: { run: (fn) => knex.transaction(fn) },
      createRepositories: (db) =>
        createRepositoryBundle(db, {
          now: () => new Date(NOW.replace(' ', 'T') + 'Z'),
          generateId,
        }),
      runQueue: {
        async enqueue(ref, options) {
          enqueued.push({ ref, options });
        },
      },
      generateId,
      leaseManager: {
        async getOwner() {
          return null;
        },
      },
    });
  });

  it('skips WAITING_INPUT while durable interaction is still PENDING (parked after kill)', async () => {
    seed(state, {
      interactionStatus: INTERACTION_STATUS.PENDING,
      resumePhase: INTERACTION_RESUME_PHASE.NONE,
      toolStatus: 'RUNNING',
    });
    const action = await recovery.recoverOneRef({ runId: RUN, orgId: ORG });
    assert.equal(action.action, 'skipped');
    assert.match(String(action.reason), /still PENDING/i);
    assert.equal(enqueued.length, 0);
    assert.equal(state.tables.runs[0].status, RUN_STATUS.WAITING_INPUT);
  });

  it('re-enqueues WAITING_INPUT when interaction is RESOLVED (resume job after worker loss)', async () => {
    seed(state, {
      interactionStatus: INTERACTION_STATUS.RESOLVED,
      resumePhase: INTERACTION_RESUME_PHASE.READY,
      toolStatus: 'SUCCEEDED',
    });
    const action = await recovery.recoverOneRef({ runId: RUN, orgId: ORG });
    assert.equal(action.action, 'enqueued', JSON.stringify(action));
    assert.match(String(action.reason), /RESOLVED/i);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].ref.runId, RUN);
    assert.equal(
      enqueued[0].options?.jobId,
      `${RUN}-interaction-${INTERACTION}`,
    );
    assert.equal(state.tables.runs[0].status, RUN_STATUS.WAITING_INPUT);
  });

  it('needs reconciliation when WAITING_INPUT has no durable interaction row', async () => {
    seed(state, { interactionStatus: null });
    const action = await recovery.recoverOneRef({ runId: RUN, orgId: ORG });
    assert.equal(action.action, 'needsReconciliation');
    assert.match(String(action.reason), /no durable interaction/i);
    assert.equal(enqueued.length, 0);
  });

  it('re-enqueues CLAIMED interaction continuation for lease-free RUNNING (resume after kill mid-apply)', async () => {
    seed(state, {
      runStatus: RUN_STATUS.RUNNING,
      interactionStatus: INTERACTION_STATUS.RESOLVED,
      resumePhase: INTERACTION_RESUME_PHASE.CLAIMED,
      toolStatus: 'SUCCEEDED',
    });
    const action = await recovery.recoverOneRef({ runId: RUN, orgId: ORG });
    assert.equal(action.action, 'enqueued', JSON.stringify(action));
    assert.match(String(action.reason), /claimed interaction continuation/i);
    assert.equal(enqueued.length, 1);
    assert.equal(
      enqueued[0].options?.jobId,
      `${RUN}-interaction-${INTERACTION}`,
    );
    assert.equal(state.tables.runs[0].status, RUN_STATUS.RUNNING);
  });
});
