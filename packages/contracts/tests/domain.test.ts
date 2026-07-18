import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOutboxStatus,
  isRunTerminalStatus,
  OUTBOX_STATUSES,
  RUN_TERMINAL_STATUSES,
  type AgentSession,
  type DomainOutbox,
  type Message,
  type OutboxStatus,
  type Run,
  type RunEvent,
  type RunStatus,
} from '../src/domain/index.ts';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN54';
const MSG = '01K0G2PAV8FPMVC9QHJG7JPN57';
const EVT = '01K0G2PAV8FPMVC9QHJG7JPN58';
const TS = '2026-07-18T04:31:22.417Z';

describe('domain type shapes (§4, §8, §10, §11)', () => {
  it('models Run with plan §8.10 fields and terminal status helper', () => {
    const run: Run = {
      runId: RUN,
      agentSessionId: SESS,
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      triggeringMessageId: MSG,
      agentVersionId: VER,
      source: 'web',
      status: 'RUNNING',
      statusReason: null,
      queueName: 'runs',
      attempt: 0,
      traceId: 'a'.repeat(32),
      nextEventSequence: 0,
      startedAt: TS,
      completedAt: null,
      createdAt: TS,
      updatedAt: TS,
    };

    assert.equal(run.status, 'RUNNING');
    assert.equal(run.nextEventSequence, 0);
    assert.equal(run.queueName, 'runs');
    assert.equal(isRunTerminalStatus(run.status), false);
    assert.equal(isRunTerminalStatus('SUCCEEDED'), true);
    assert.deepEqual(RUN_TERMINAL_STATUSES, ['SUCCEEDED', 'FAILED', 'CANCELLED']);

    const statuses: RunStatus[] = [
      'ACCEPTED',
      'QUEUED',
      'STARTING',
      'RUNNING',
      'WAITING_APPROVAL',
      'WAITING_INPUT',
      'CANCELLING',
      'RETRYING',
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
    ];
    assert.equal(statuses.length, 11);
  });

  it('models append-only Message and RunEvent (no Conversation JSON blob)', () => {
    const message: Message = {
      messageId: MSG,
      conversationId: CONV,
      agentSessionId: SESS,
      runId: RUN,
      role: 'user',
      messageType: 'text',
      contentJson: { text: 'hello' },
      sequenceNo: 1,
      createdAt: TS,
    };
    const event: RunEvent = {
      eventId: EVT,
      runId: RUN,
      orgId: ORG,
      sequenceNo: 1,
      eventType: 'run.started',
      eventVersion: 1,
      payloadJson: {},
      traceId: 'b'.repeat(32),
      spanId: null,
      createdAt: TS,
    };
    assert.equal(message.sequenceNo, 1);
    assert.equal(event.sequenceNo, 1);
    assert.equal(message.role, 'user');
  });

  it('keeps Agent Session distinct from Conversation and Sandbox Session', () => {
    const session: AgentSession = {
      agentSessionId: SESS,
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      agentVersionId: VER,
      sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN55',
      workspaceId: '01K0G2PAV8FPMVC9QHJG7JPN56',
      status: 'ACTIVE',
      piSessionVersion: 0,
      lastRunId: null,
      createdAt: TS,
      updatedAt: TS,
      closedAt: null,
    };

    assert.equal(session.agentSessionId, SESS);
    assert.notEqual(session.agentSessionId, session.conversationId);
    assert.notEqual(session.agentSessionId, session.sandboxSessionId);
    assert.equal(session.status, 'ACTIVE');
    assert.equal(session.piSessionVersion, 0);
  });

  it('models DomainOutbox with claim/retry fields (plan §8.17 + PR-03 delivery)', () => {
    const statuses: OutboxStatus[] = [
      'PENDING',
      'PUBLISHING',
      'PUBLISHED',
      'FAILED',
    ];
    assert.deepEqual(OUTBOX_STATUSES, statuses);
    assert.equal(isOutboxStatus('PENDING'), true);
    assert.equal(isOutboxStatus('PUBLISHING'), true);
    assert.equal(isOutboxStatus('published'), false);

    const row: DomainOutbox = {
      outboxId: EVT,
      aggregateType: 'run',
      aggregateId: RUN,
      eventType: 'run.started',
      payloadJson: { eventId: EVT, sequence: 1, runId: RUN },
      status: 'PENDING',
      attempts: 0,
      claimToken: null,
      claimedAt: null,
      nextAttemptAt: null,
      lastError: null,
      createdAt: TS,
      publishedAt: null,
    };
    assert.equal(row.aggregateType, 'run');
    assert.equal(row.payloadJson.eventId, EVT);
    assert.equal(row.status, 'PENDING');
  });
});
