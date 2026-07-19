import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeKnex, createFakeState } from './fake-knex.js';
import { InteractionRepository } from '../../src/infrastructure/mysql/repositories/interaction-repository.js';
import {
  ConflictError,
  NotFoundError,
} from '../../src/infrastructure/mysql/errors.js';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const OTHER_USER = '01K0G2PAV8FPMVC9QHJG7JPN5A';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const TOOL = '01K0G2PAV8FPMVC9QHJG7JPN54';
const INTERACTION = '01K0G2PAV8FPMVC9QHJG7JPN55';
const OTHER_SESSION = '01K0G2PAV8FPMVC9QHJG7JPN5B';
const OTHER_TOOL = '01K0G2PAV8FPMVC9QHJG7JPN5C';

function request(overrides = {}) {
  return {
    interactionId: INTERACTION,
    orgId: ORG,
    userId: USER,
    runId: RUN,
    agentSessionId: SESSION,
    toolExecutionId: TOOL,
    toolCallId: 'ask-user-1',
    interactionType: 'select',
    requestJson: {
      title: 'Choose a region',
      options: ['eu', 'us'],
    },
    ...overrides,
  };
}

function toolExecution(toolExecutionId, agentSessionId = SESSION) {
  return {
    tool_execution_id: toolExecutionId,
    run_id: RUN,
    agent_session_id: agentSessionId,
    tool_call_id: 'ask-user-1',
    tool_name: 'ask_user',
    tool_source: 'internal',
    risk_level: 'low',
    arguments_json: JSON.stringify({}),
    result_json: null,
    status: 'RUNNING',
    error_code: null,
    trace_id: 'a'.repeat(32),
    created_at: '2026-07-19 01:02:03.004',
    started_at: '2026-07-19 01:02:03.004',
    completed_at: null,
  };
}

describe('InteractionRepository', () => {
  let state;
  let knex;
  let repository;

  beforeEach(() => {
    state = createFakeState();
    knex = createFakeKnex(state);
    state.tables.runs = [
      {
        run_id: RUN,
        org_id: ORG,
        user_id: USER,
        agent_session_id: SESSION,
        status: 'RUNNING',
      },
    ];
    state.tables.tool_executions = [toolExecution(TOOL)];
    state.tables.run_interactions = [];
    repository = new InteractionRepository(knex, {
      now: () => new Date('2026-07-19T01:02:03.004Z'),
    });
  });

  it('creates once and adopts a canonical-equivalent retry', async () => {
    const first = await repository.getOrCreatePending(request());
    const retry = await repository.getOrCreatePending(
      request({
        interactionId: '01K0G2PAV8FPMVC9QHJG7JPN56',
        requestJson: {
          options: ['eu', 'us'],
          title: 'Choose a region',
        },
      }),
    );

    assert.equal(first.created, true);
    assert.equal(retry.created, false);
    assert.equal(retry.interaction.interactionId, INTERACTION);
    assert.equal(retry.interaction.toolExecutionId, TOOL);
    assert.equal(state.tables.run_interactions.length, 1);
    assert.ok(
      state.lockCalls.some(
        (call) => call.table === 'runs' && call.mode === 'update',
      ),
      'the owned Run is locked before interaction creation',
    );
  });

  it('rejects a replay whose durable request differs', async () => {
    await repository.getOrCreatePending(request());

    await assert.rejects(
      () =>
        repository.getOrCreatePending(
          request({
            interactionId: '01K0G2PAV8FPMVC9QHJG7JPN56',
            requestJson: {
              title: 'Choose a different region',
              options: ['apac', 'us'],
            },
          }),
        ),
      ConflictError,
    );
    assert.equal(state.tables.run_interactions.length, 1);
  });

  it('adopts a concurrent duplicate only when every durable binding matches', async () => {
    const calls = await Promise.all([
      repository.getOrCreatePending(request()),
      repository.getOrCreatePending(
        request({ interactionId: '01K0G2PAV8FPMVC9QHJG7JPN56' }),
      ),
    ]);

    assert.equal(state.tables.run_interactions.length, 1);
    assert.deepEqual(
      calls.map((result) => result.created).sort(),
      [false, true],
    );
    assert.ok(calls.every((result) => result.interaction.interactionId === INTERACTION));
  });

  for (const [label, overrides] of [
    [
      'request',
      {
        requestJson: {
          title: 'Choose a different region',
          options: ['apac', 'us'],
        },
      },
    ],
    ['agent session', { agentSessionId: OTHER_SESSION }],
    ['interaction type', { interactionType: 'confirm' }],
    ['tool execution', { toolExecutionId: OTHER_TOOL }],
  ]) {
    it(`fails closed when a concurrent duplicate has a different ${label} binding`, async () => {
      if (
        overrides.toolExecutionId === OTHER_TOOL ||
        overrides.agentSessionId === OTHER_SESSION
      ) {
        state.tables.tool_executions.push(
          toolExecution(
            OTHER_TOOL,
            overrides.agentSessionId === OTHER_SESSION
              ? OTHER_SESSION
              : SESSION,
          ),
        );
      }
      const settled = await Promise.allSettled([
        repository.getOrCreatePending(request()),
        repository.getOrCreatePending(
          request({
            interactionId: '01K0G2PAV8FPMVC9QHJG7JPN56',
            ...overrides,
            ...(overrides.agentSessionId === OTHER_SESSION
              ? { toolExecutionId: OTHER_TOOL }
              : {}),
          }),
        ),
      ]);

      assert.equal(state.tables.run_interactions.length, 1);
      assert.equal(
        settled.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const rejected = settled.find((result) => result.status === 'rejected');
      assert.ok(rejected);
      assert.ok(rejected.reason instanceof ConflictError);
    });
  }

  it('resolves with CAS and makes only the same answer idempotent', async () => {
    await repository.getOrCreatePending(request());

    const first = await repository.resolveIfPending({
      interactionId: INTERACTION,
      orgId: ORG,
      userId: USER,
      responseJson: 'eu',
      respondedBy: USER,
    });
    const retry = await repository.resolveIfPending({
      interactionId: INTERACTION,
      orgId: ORG,
      userId: USER,
      responseJson: 'eu',
      respondedBy: USER,
    });

    assert.equal(first.changed, true);
    assert.equal(retry.changed, false);
    assert.equal(first.interaction.status, 'RESOLVED');
    assert.match(first.interaction.responseHash, /^[0-9a-f]{64}$/);
    assert.equal(first.interaction.responseJson, 'eu');
    await assert.rejects(
      () =>
        repository.resolveIfPending({
          interactionId: INTERACTION,
          orgId: ORG,
          userId: USER,
          responseJson: 'us',
          respondedBy: USER,
        }),
      ConflictError,
    );
  });

  it('claims a legacy resolved NONE phase exactly once', async () => {
    await repository.getOrCreatePending(request());
    Object.assign(state.tables.run_interactions[0], {
      status: 'RESOLVED',
      response_json: JSON.stringify('eu'),
      response_hash: 'a'.repeat(64),
      responded_by: USER,
      resume_phase: 'NONE',
      resolved_at: '2026-07-19 01:02:03.004',
    });

    const first = await repository.claimResumeIfReady(INTERACTION, {
      orgId: ORG,
      userId: USER,
    });
    const replay = await repository.claimResumeIfReady(INTERACTION, {
      orgId: ORG,
      userId: USER,
    });

    assert.equal(first.changed, true);
    assert.equal(first.interaction.resumePhase, 'CLAIMED');
    assert.equal(replay.changed, false);
    assert.equal(replay.interaction.resumePhase, 'CLAIMED');
  });

  it('validates response shape against the durable interaction request', async () => {
    await repository.getOrCreatePending(request());
    await assert.rejects(
      () => repository.resolveIfPending({
        interactionId: INTERACTION,
        orgId: ORG,
        userId: USER,
        responseJson: 'apac',
        respondedBy: USER,
      }),
      /one of the requested options/,
    );

    state.tables.run_interactions = [];
    state.tables.runs[0].status = 'RUNNING';
    await repository.getOrCreatePending(request({
      interactionType: 'confirm',
      requestJson: { title: 'Deploy?' },
    }));
    await assert.rejects(
      () => repository.resolveIfPending({
        interactionId: INTERACTION,
        orgId: ORG,
        userId: USER,
        responseJson: 'yes',
        respondedBy: USER,
      }),
      /must be a boolean/,
    );
  });

  it('hashes and stores the complete untruncated response', async () => {
    state.tables.runs[0].status = 'RUNNING';
    await repository.getOrCreatePending(request({
      interactionType: 'input',
      requestJson: { title: 'Provide context' },
    }));
    const prefix = 'x'.repeat(512);
    const first = await repository.resolveIfPending({
      interactionId: INTERACTION,
      orgId: ORG,
      userId: USER,
      responseJson: `${prefix}-one`,
      respondedBy: USER,
    });

    assert.equal(first.interaction.responseJson, `${prefix}-one`);
    await assert.rejects(
      () => repository.resolveIfPending({
        interactionId: INTERACTION,
        orgId: ORG,
        userId: USER,
        responseJson: `${prefix}-two`,
        respondedBy: USER,
      }),
      ConflictError,
    );
  });

  it('hides interactions from a different owner', async () => {
    await repository.getOrCreatePending(request());
    await assert.rejects(
      () => repository.getById(INTERACTION, { orgId: ORG, userId: OTHER_USER }),
      NotFoundError,
    );
  });

  it('rolls back a created interaction with its surrounding transaction', async () => {
    await assert.rejects(
      () =>
        knex.transaction(async (trx) => {
          const transactional = new InteractionRepository(trx);
          await transactional.getOrCreatePending(request());
          throw new Error('force rollback');
        }),
      /force rollback/,
    );

    assert.deepEqual(state.tables.run_interactions, []);
  });
});
