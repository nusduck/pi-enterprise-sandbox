import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CreateRunService } from '../../src/application/create-run-service.js';
import { FollowUpService } from '../../src/application/follow-up-service.js';
import {
  STEER_REQUESTED_EVENT,
  SteerRunService,
} from '../../src/application/steer-run-service.js';
import {
  IdempotencyConflictError,
  OwnerScopedNotFoundError,
} from '../../src/application/errors.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';
import {
  createFakeRunWorld,
  FIXED_AUTH,
  TRACE,
} from './helpers/fake-run-world.js';

const NOW = () => new Date('2026-07-18T06:00:00.000Z');

function build(world) {
  const createRunService = new CreateRunService({
    transactionManager: world.transactionManager,
    createRepositories: world.createRepositories,
    generateId: world.generateId,
    now: NOW,
    runQueue: world.runQueue,
  });
  return {
    createRunService,
    steer: new SteerRunService({
      transactionManager: world.transactionManager,
      createRepositories: world.createRepositories,
      generateId: world.generateId,
      now: NOW,
    }),
    followUp: new FollowUpService({ createRunService }),
  };
}

describe('durable steer and separate follow-up Run', () => {
  let world;
  let services;
  let first;

  beforeEach(async () => {
    world = createFakeRunWorld();
    services = build(world);
    first = await services.createRunService.execute({
      messages: [{ role: 'user', content: 'start' }],
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'create-first',
    });
    world.tables.runs[0].status = RUN_STATUS.RUNNING;
  });

  it('atomically persists instruction, requested event, Outbox and response', async () => {
    const response = await services.steer.execute({
      runId: first.runId,
      text: 'focus on the second column',
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'steer-1',
    });

    assert.equal(response.status, 'ACCEPTED');
    assert.equal(response.runId, first.runId);
    const message = world.tables.messages.find(
      (row) => row.message_id === response.messageId,
    );
    assert.equal(message.message_type, 'steer_instruction');
    assert.deepEqual(JSON.parse(message.content_json), {
      text: 'focus on the second column',
    });
    const event = world.tables.run_events.find(
      (row) => row.event_id === response.steerId,
    );
    assert.equal(event.event_type, STEER_REQUESTED_EVENT);
    assert.equal(JSON.parse(event.payload_json).messageId, response.messageId);
    assert.ok(
      world.tables.domain_outbox.some(
        (row) =>
          row.aggregate_id === first.runId &&
          row.event_type === STEER_REQUESTED_EVENT,
      ),
    );
    const idempotency = world.tables.idempotency_records.find(
      (row) => row.operation === 'steer_run',
    );
    assert.equal(idempotency.resource_id, response.steerId);
    assert.equal(idempotency.response_status, 202);
  });

  it('replays same request and conflicts on key reuse with different text', async () => {
    const input = {
      runId: first.runId,
      text: 'new direction',
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'steer-replay',
    };
    const firstResponse = await services.steer.execute(input);
    const counts = {
      messages: world.tables.messages.length,
      events: world.tables.run_events.length,
      outbox: world.tables.domain_outbox.length,
    };
    const replay = await services.steer.execute(input);
    assert.equal(replay.steerId, firstResponse.steerId);
    assert.equal(replay.replayed, true);
    assert.deepEqual(
      {
        messages: world.tables.messages.length,
        events: world.tables.run_events.length,
        outbox: world.tables.domain_outbox.length,
      },
      counts,
    );

    await assert.rejects(
      services.steer.execute({ ...input, text: 'different direction' }),
      IdempotencyConflictError,
    );
  });

  it('rejects non-running and foreign-owner admission without writes', async () => {
    const counts = {
      messages: world.tables.messages.length,
      events: world.tables.run_events.length,
    };
    world.tables.runs[0].status = RUN_STATUS.SUCCEEDED;
    await assert.rejects(
      services.steer.execute({
        runId: first.runId,
        text: 'too late',
        auth: FIXED_AUTH,
        traceId: TRACE,
        idempotencyKey: 'late',
      }),
      /not accepting steer/i,
    );

    world.tables.runs[0].status = RUN_STATUS.RUNNING;
    await assert.rejects(
      services.steer.execute({
        runId: first.runId,
        text: 'foreign',
        auth: { ...FIXED_AUTH, externalUserId: 'foreign-user' },
        traceId: TRACE,
        idempotencyKey: 'foreign',
      }),
      OwnerScopedNotFoundError,
    );
    assert.equal(world.tables.messages.length, counts.messages);
    assert.equal(world.tables.run_events.length, counts.events);
  });

  it('creates follow-up as a new Run on the same Conversation and Session', async () => {
    const result = await services.followUp.execute({
      conversationId: first.conversationId,
      text: 'now summarize the findings',
      auth: FIXED_AUTH,
      traceId: TRACE,
      idempotencyKey: 'follow-up-1',
    });

    assert.notEqual(result.runId, first.runId);
    assert.equal(result.conversationId, first.conversationId);
    assert.equal(result.agentSessionId, first.agentSessionId);
    assert.equal(world.tables.runs.length, 2);
    assert.equal(world.tables.agent_sessions.length, 1);
    const followRun = world.tables.runs.find((row) => row.run_id === result.runId);
    const trigger = world.tables.messages.find(
      (row) => row.message_id === followRun.triggering_message_id,
    );
    assert.equal(trigger.run_id, result.runId);
    assert.equal(world.enqueuedJobs.at(-1).runId, result.runId);
  });
});

