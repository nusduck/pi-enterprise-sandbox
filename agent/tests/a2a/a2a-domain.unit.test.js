/**
 * PR-12: A2A domain status projection + scopes (offline).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  A2A_TASK_STATUS,
  projectRunStatusToA2a,
  isTerminalA2aTaskStatus,
  A2A_SCOPES,
  hasScope,
  normalizeScopes,
} from '../../src/domain/a2a/index.js';
import { RUN_STATUS } from '../../src/domain/run/run-status.js';

describe('A2A status projection (plan §20.4)', () => {
  it('maps Internal Run statuses to A2A Task states', () => {
    assert.equal(projectRunStatusToA2a(RUN_STATUS.ACCEPTED), A2A_TASK_STATUS.SUBMITTED);
    assert.equal(projectRunStatusToA2a(RUN_STATUS.QUEUED), A2A_TASK_STATUS.SUBMITTED);
    assert.equal(projectRunStatusToA2a(RUN_STATUS.STARTING), A2A_TASK_STATUS.WORKING);
    assert.equal(projectRunStatusToA2a(RUN_STATUS.RUNNING), A2A_TASK_STATUS.WORKING);
    assert.equal(
      projectRunStatusToA2a(RUN_STATUS.WAITING_INPUT),
      A2A_TASK_STATUS.INPUT_REQUIRED,
    );
    assert.equal(
      projectRunStatusToA2a(RUN_STATUS.WAITING_APPROVAL),
      A2A_TASK_STATUS.AUTH_REQUIRED,
    );
    assert.equal(projectRunStatusToA2a(RUN_STATUS.SUCCEEDED), A2A_TASK_STATUS.COMPLETED);
    assert.equal(projectRunStatusToA2a(RUN_STATUS.FAILED), A2A_TASK_STATUS.FAILED);
    assert.equal(projectRunStatusToA2a(RUN_STATUS.CANCELLED), A2A_TASK_STATUS.CANCELED);
    assert.equal(projectRunStatusToA2a(RUN_STATUS.CANCELLING), A2A_TASK_STATUS.WORKING);
    assert.equal(projectRunStatusToA2a(RUN_STATUS.RETRYING), A2A_TASK_STATUS.WORKING);
  });

  it('does not treat unknown strings as a second status source inventing states', () => {
    assert.equal(projectRunStatusToA2a('bogus'), A2A_TASK_STATUS.FAILED);
    assert.equal(projectRunStatusToA2a(null), A2A_TASK_STATUS.FAILED);
  });

  it('terminal set matches protocol terminal states', () => {
    assert.equal(isTerminalA2aTaskStatus('completed'), true);
    assert.equal(isTerminalA2aTaskStatus('failed'), true);
    assert.equal(isTerminalA2aTaskStatus('canceled'), true);
    assert.equal(isTerminalA2aTaskStatus('working'), false);
    assert.equal(isTerminalA2aTaskStatus('auth-required'), false);
  });
});

describe('A2A scopes (plan §20.7)', () => {
  it('normalizes known scopes and rejects unknown', () => {
    assert.deepEqual(normalizeScopes([A2A_SCOPES.INVOKE, A2A_SCOPES.READ]), [
      A2A_SCOPES.INVOKE,
      A2A_SCOPES.READ,
    ]);
    assert.throws(() => normalizeScopes(['agent.hack']), /unknown A2A scope/);
  });

  it('hasScope is exact membership', () => {
    assert.equal(hasScope([A2A_SCOPES.READ], A2A_SCOPES.READ), true);
    assert.equal(hasScope([A2A_SCOPES.READ], A2A_SCOPES.CANCEL), false);
    assert.equal(hasScope(null, A2A_SCOPES.READ), false);
  });
});
