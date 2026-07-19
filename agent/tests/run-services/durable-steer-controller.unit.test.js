import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DurableSteerController,
  steerTextFromMessage,
} from '../../src/application/durable-steer-controller.js';
import {
  STEER_DELIVERED_EVENT,
  STEER_REQUESTED_EVENT,
} from '../../src/application/steer-run-service.js';

const IDS = {
  runId: '01J3A0M6S00000000000000001',
  conversationId: '01J3A0M6S00000000000000002',
  agentSessionId: '01J3A0M6S00000000000000003',
  orgId: '01J3A0M6S00000000000000004',
  userId: '01J3A0M6S00000000000000005',
  steerId: '01J3A0M6S00000000000000006',
  messageId: '01J3A0M6S00000000000000007',
};

function buildWorld({ includeDelivered = false } = {}) {
  const events = [
    {
      eventId: IDS.steerId,
      runId: IDS.runId,
      sequenceNo: 1,
      eventType: STEER_REQUESTED_EVENT,
      payloadJson: { steerId: IDS.steerId, messageId: IDS.messageId },
    },
  ];
  if (includeDelivered) {
    events.push({
      eventId: '01J3A0M6S00000000000000008',
      runId: IDS.runId,
      sequenceNo: 2,
      eventType: STEER_DELIVERED_EVENT,
      payloadJson: { data: { steerId: IDS.steerId, messageId: IDS.messageId } },
    });
  }
  const message = {
    messageId: IDS.messageId,
    runId: IDS.runId,
    conversationId: IDS.conversationId,
    agentSessionId: IDS.agentSessionId,
    messageType: 'steer_instruction',
    contentJson: { text: 'change direction' },
  };
  const steered = [];
  const recorded = [];
  const createRepositories = () => ({
    runEvents: {
      async listByRun(_runId, _scope, opts) {
        return events.filter((event) => event.sequenceNo > opts.afterSequence);
      },
    },
    messages: {
      async getById(id) {
        return id === message.messageId ? message : null;
      },
    },
  });
  const controller = new DurableSteerController({
    transactionManager: { run: (fn) => fn({}) },
    createRepositories,
    runtimeSession: {
      async steer(text) {
        steered.push(text);
      },
    },
    eventRecorder: {
      async record(input) {
        recorded.push(input);
        events.push({
          eventId: '01J3A0M6S00000000000000009',
          runId: IDS.runId,
          sequenceNo: events.length + 1,
          eventType: input.type,
          payloadJson: { data: input.data },
        });
      },
    },
    ...IDS,
    scope: { orgId: IDS.orgId, userId: IDS.userId },
  });
  return { controller, events, message, steered, recorded };
}

describe('DurableSteerController', () => {
  it('delivers a requested instruction once and records acknowledgement', async () => {
    const world = buildWorld();
    await world.controller.pollOnce();
    await world.controller.pollOnce();

    assert.deepEqual(world.steered, ['change direction']);
    assert.equal(world.recorded.length, 1);
    assert.equal(world.recorded[0].type, STEER_DELIVERED_EVENT);
    assert.equal(world.recorded[0].data.steerId, IDS.steerId);
  });

  it('rebuilds delivered state from MySQL events after Worker restart', async () => {
    const world = buildWorld({ includeDelivered: true });
    await world.controller.pollOnce();
    assert.deepEqual(world.steered, []);
    assert.deepEqual(world.recorded, []);
  });

  it('fails closed on a message binding mismatch', () => {
    const world = buildWorld();
    assert.throws(
      () =>
        steerTextFromMessage(
          { ...world.message, runId: '01J3A0M6S0000000000000000A' },
          {
            messageId: IDS.messageId,
            runId: IDS.runId,
            conversationId: IDS.conversationId,
            agentSessionId: IDS.agentSessionId,
          },
        ),
      /binding mismatch/i,
    );
  });
});

