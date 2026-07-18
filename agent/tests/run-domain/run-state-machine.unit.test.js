/**
 * RunStateMachine + legacy mapping unit tests (plan §10, PR-04 T1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RunStateMachine,
  runStateMachine,
  RUN_STATUS,
  RUN_TRANSITIONS,
  ALL_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_RUN_STATUS_SET,
  NON_TERMINAL_RUN_STATUSES,
  mapLegacyRuntimeOutcome,
  LEGACY_RUNTIME_OUTCOME_MAP,
  InvalidRunTransitionError,
  InvalidRunStatusError,
  UnknownLegacyOutcomeError,
} from '../../src/domain/run/index.js';

describe('RunStateMachine plan §10 vocabulary', () => {
  it('exposes uppercase statuses and terminal set', () => {
    for (const s of ALL_RUN_STATUSES) {
      assert.equal(s, s.toUpperCase());
    }
    assert.deepEqual(
      [...TERMINAL_RUN_STATUSES].sort(),
      ['CANCELLED', 'FAILED', 'SUCCEEDED'],
    );
    for (const t of TERMINAL_RUN_STATUSES) {
      assert.equal(TERMINAL_RUN_STATUS_SET.has(t), true);
      assert.equal(runStateMachine.isTerminal(t), true);
    }
    for (const s of NON_TERMINAL_RUN_STATUSES) {
      assert.equal(runStateMachine.isTerminal(s), false);
    }
  });

  it('transition matrix matches plan §10 exactly', () => {
    /** @type {Array<[string, string]>} */
    const allowed = [
      ['ACCEPTED', 'QUEUED'],
      ['QUEUED', 'STARTING'],
      ['QUEUED', 'CANCELLING'],
      ['STARTING', 'RUNNING'],
      ['STARTING', 'RETRYING'],
      ['STARTING', 'FAILED'],
      ['RUNNING', 'SUCCEEDED'],
      ['RUNNING', 'WAITING_APPROVAL'],
      ['RUNNING', 'WAITING_INPUT'],
      ['RUNNING', 'CANCELLING'],
      ['RUNNING', 'RETRYING'],
      ['RUNNING', 'FAILED'],
      ['WAITING_APPROVAL', 'RUNNING'],
      ['WAITING_INPUT', 'RUNNING'],
      ['CANCELLING', 'CANCELLED'],
      ['RETRYING', 'QUEUED'],
      ['RETRYING', 'FAILED'],
    ];

    const allowedSet = new Set(allowed.map(([a, b]) => `${a}->${b}`));

    // Every matrix edge is allowed
    for (const [from, targets] of Object.entries(RUN_TRANSITIONS)) {
      for (const to of targets) {
        assert.ok(
          allowedSet.has(`${from}->${to}`),
          `unexpected edge ${from}->${to}`,
        );
        assert.equal(runStateMachine.canTransition(from, to), true);
        assert.equal(runStateMachine.transition(from, to), to);
      }
    }

    // Every plan edge is in the matrix
    for (const [from, to] of allowed) {
      assert.ok(
        RUN_TRANSITIONS[from].includes(to),
        `missing edge ${from}->${to}`,
      );
    }

    // Terminals have no outgoing edges
    for (const t of TERMINAL_RUN_STATUSES) {
      assert.deepEqual(RUN_TRANSITIONS[t], []);
    }
  });

  it('invalid transitions throw typed InvalidRunTransitionError', () => {
    assert.throws(
      () => runStateMachine.transition(RUN_STATUS.ACCEPTED, RUN_STATUS.RUNNING),
      (err) => {
        assert.ok(err instanceof InvalidRunTransitionError);
        assert.equal(err.code, 'INVALID_RUN_TRANSITION');
        assert.equal(err.from, 'ACCEPTED');
        assert.equal(err.to, 'RUNNING');
        return true;
      },
    );
    assert.throws(
      () => runStateMachine.transition(RUN_STATUS.SUCCEEDED, RUN_STATUS.RUNNING),
      InvalidRunTransitionError,
    );
    assert.throws(
      () => runStateMachine.transition(RUN_STATUS.FAILED, RUN_STATUS.QUEUED),
      InvalidRunTransitionError,
    );
  });

  it('rejects unknown statuses with InvalidRunStatusError', () => {
    assert.throws(
      () => runStateMachine.transition('completed', 'SUCCEEDED'),
      InvalidRunStatusError,
    );
    assert.throws(
      () => runStateMachine.assertStatus('queued'),
      InvalidRunStatusError,
    );
  });

  it('does not write storage (pure function surface)', () => {
    const sm = new RunStateMachine();
    // No db / storage properties
    assert.equal('db' in sm, false);
    assert.equal(typeof sm.transition, 'function');
    assert.equal(typeof sm.canTransition, 'function');
  });
});

describe('legacy runtime outcome mapping', () => {
  it('maps completed/failed/budget_exceeded/rejected/cancelled/waiting_*', () => {
    assert.equal(mapLegacyRuntimeOutcome('completed'), 'SUCCEEDED');
    assert.equal(mapLegacyRuntimeOutcome('failed'), 'FAILED');
    assert.equal(mapLegacyRuntimeOutcome('budget_exceeded'), 'FAILED');
    assert.equal(mapLegacyRuntimeOutcome('rejected'), 'FAILED');
    assert.equal(mapLegacyRuntimeOutcome('cancelled'), 'CANCELLED');
    assert.equal(mapLegacyRuntimeOutcome('waiting_approval'), 'WAITING_APPROVAL');
    assert.equal(mapLegacyRuntimeOutcome('waiting_input'), 'WAITING_INPUT');
    assert.equal(mapLegacyRuntimeOutcome('waiting_custom'), 'WAITING_CUSTOM');
  });

  it('is only applied through the explicit mapper / SM helper', () => {
    assert.equal(
      runStateMachine.mapLegacyOutcome('completed'),
      RUN_STATUS.SUCCEEDED,
    );
    assert.ok(Object.keys(LEGACY_RUNTIME_OUTCOME_MAP).length >= 5);
  });

  it('throws on unknown legacy outcomes', () => {
    assert.throws(() => mapLegacyRuntimeOutcome('bogus'), UnknownLegacyOutcomeError);
    assert.throws(() => mapLegacyRuntimeOutcome(''), UnknownLegacyOutcomeError);
    assert.throws(() => mapLegacyRuntimeOutcome(null), UnknownLegacyOutcomeError);
  });
});
