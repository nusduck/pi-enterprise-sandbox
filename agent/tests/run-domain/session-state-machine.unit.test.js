/**
 * Agent Session state machine — exact plan §11 six statuses (PR-05).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_STATUS,
  SESSION_TRANSITIONS,
  ALL_SESSION_STATUSES,
  isSessionStatus,
  isTerminalSessionStatus,
  RECOVERY_REASON_CODE,
  SessionStateMachine,
  sessionStateMachine,
  InvalidSessionTransitionError,
  InvalidSessionStatusError,
} from '../../src/domain/session/index.js';

describe('SessionStateMachine exact plan §11', () => {
  it('exposes six formal statuses including CLOSING without RECOVERY_REQUIRED', () => {
    assert.deepEqual([...ALL_SESSION_STATUSES].sort(), [
      'ACTIVE',
      'CLOSED',
      'CLOSING',
      'CREATING',
      'FAILED',
      'SUSPENDED',
    ].sort());
    assert.equal(isSessionStatus('RECOVERY_REQUIRED'), false);
    assert.equal(SESSION_STATUS.CLOSING, 'CLOSING');
  });

  it('exact adjacent edges only', () => {
    assert.deepEqual([...SESSION_TRANSITIONS.CREATING].sort(), ['ACTIVE', 'FAILED'].sort());
    assert.deepEqual(
      [...SESSION_TRANSITIONS.ACTIVE].sort(),
      ['CLOSING', 'FAILED', 'SUSPENDED'].sort(),
    );
    assert.deepEqual(
      [...SESSION_TRANSITIONS.SUSPENDED].sort(),
      ['ACTIVE', 'FAILED'].sort(),
    );
    assert.deepEqual([...SESSION_TRANSITIONS.CLOSING], ['CLOSED']);
    assert.deepEqual([...SESSION_TRANSITIONS.CLOSED], []);
    assert.deepEqual([...SESSION_TRANSITIONS.FAILED], []);
  });

  it('rejects invented collapse/abandon transitions', () => {
    for (const [from, to] of [
      ['CREATING', 'CLOSED'],
      ['CREATING', 'SUSPENDED'],
      ['CREATING', 'CLOSING'],
      ['ACTIVE', 'CLOSED'],
      ['SUSPENDED', 'CLOSED'],
      ['SUSPENDED', 'CLOSING'],
      ['CLOSING', 'ACTIVE'],
    ]) {
      assert.equal(sessionStateMachine.canTransition(from, to), false, `${from}→${to}`);
      assert.throws(
        () => sessionStateMachine.transition(from, to),
        InvalidSessionTransitionError,
      );
    }
  });

  it('allows legal happy-path close ACTIVE→CLOSING→CLOSED', () => {
    assert.equal(sessionStateMachine.transition('ACTIVE', 'CLOSING'), 'CLOSING');
    assert.equal(sessionStateMachine.transition('CLOSING', 'CLOSED'), 'CLOSED');
  });

  it('terminal statuses', () => {
    assert.equal(isTerminalSessionStatus('CLOSED'), true);
    assert.equal(isTerminalSessionStatus('FAILED'), true);
    assert.equal(isTerminalSessionStatus('CLOSING'), false);
  });

  it('assertSuspendForRecovery only from ACTIVE or re-reason SUSPENDED', () => {
    const r = sessionStateMachine.assertSuspendForRecovery(
      'ACTIVE',
      RECOVERY_REASON_CODE.RECOVERY_REQUIRED,
    );
    assert.equal(r.status, 'SUSPENDED');
    assert.equal(r.recoveryReasonCode, 'RECOVERY_REQUIRED');

    const r2 = sessionStateMachine.assertSuspendForRecovery(
      'SUSPENDED',
      RECOVERY_REASON_CODE.SNAPSHOT_INVALID,
    );
    assert.equal(r2.status, 'SUSPENDED');
    assert.equal(r2.recoveryReasonCode, 'SNAPSHOT_INVALID');

    assert.throws(
      () => sessionStateMachine.assertSuspendForRecovery('CREATING'),
      InvalidSessionTransitionError,
    );
  });

  it('isLegalEdge allows SUSPENDED re-reason only as same-status', () => {
    assert.equal(sessionStateMachine.isLegalEdge('SUSPENDED', 'SUSPENDED'), true);
    assert.equal(sessionStateMachine.isLegalEdge('ACTIVE', 'ACTIVE'), false);
    assert.equal(sessionStateMachine.isLegalEdge('ACTIVE', 'SUSPENDED'), true);
  });

  it('throws typed errors for invalid status', () => {
    assert.throws(
      () => sessionStateMachine.assertStatus('running'),
      InvalidSessionStatusError,
    );
  });

  it('constructs independent machines for tests', () => {
    const sm = new SessionStateMachine();
    assert.equal(sm.canTransition('CREATING', 'ACTIVE'), true);
  });
});
