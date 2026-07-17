import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isRunTerminalStatus,
  RUN_TERMINAL_STATUSES,
  type AgentSession,
  type Run,
  type RunStatus,
} from '../src/domain/index.ts';

const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const SESS = '01K0G2PAV8FPMVC9QHJG7JPN52';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const VER = '01K0G2PAV8FPMVC9QHJG7JPN54';
const TS = '2026-07-18T04:31:22.417Z';

describe('domain type shapes (§4, §10, §11)', () => {
  it('models Run with terminal status helper', () => {
    const run: Run = {
      runId: RUN,
      agentSessionId: SESS,
      orgId: ORG,
      userId: USER,
      conversationId: CONV,
      triggeringMessageId: null,
      agentVersionId: VER,
      status: 'RUNNING',
      startedAt: TS,
      completedAt: null,
      createdAt: TS,
      updatedAt: TS,
    };

    assert.equal(run.status, 'RUNNING');
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
      createdAt: TS,
      updatedAt: TS,
    };

    assert.equal(session.agentSessionId, SESS);
    assert.notEqual(session.agentSessionId, session.conversationId);
    assert.notEqual(session.agentSessionId, session.sandboxSessionId);
    assert.equal(session.status, 'ACTIVE');
  });
});
