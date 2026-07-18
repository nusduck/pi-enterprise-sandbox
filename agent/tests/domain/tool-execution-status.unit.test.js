/**
 * PR-07B batch 2A2: ToolExecution UNKNOWN status transitions + mapper claim fields.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_EXECUTION_STATUS,
  TOOL_EXECUTION_STATUSES,
  TOOL_EXECUTION_TRANSITIONS,
  canTransitionToolExecution,
  isTerminalToolExecutionStatus,
  isToolExecutionStatus,
} from '../../src/domain/tool/tool-execution-status.js';
import { mapToolExecution } from '../../src/infrastructure/mysql/row-mappers.js';

describe('TOOL_EXECUTION_STATUS.UNKNOWN', () => {
  it('is a registered terminal status with no outgoing edges', () => {
    assert.equal(TOOL_EXECUTION_STATUS.UNKNOWN, 'UNKNOWN');
    assert.ok(TOOL_EXECUTION_STATUSES.includes(TOOL_EXECUTION_STATUS.UNKNOWN));
    assert.equal(isToolExecutionStatus('UNKNOWN'), true);
    assert.equal(isTerminalToolExecutionStatus(TOOL_EXECUTION_STATUS.UNKNOWN), true);
    assert.deepEqual(TOOL_EXECUTION_TRANSITIONS[TOOL_EXECUTION_STATUS.UNKNOWN], []);
  });

  it('only RUNNING may transition to UNKNOWN', () => {
    assert.equal(
      canTransitionToolExecution(
        TOOL_EXECUTION_STATUS.RUNNING,
        TOOL_EXECUTION_STATUS.UNKNOWN,
      ),
      true,
    );
    for (const from of [
      TOOL_EXECUTION_STATUS.PROPOSED,
      TOOL_EXECUTION_STATUS.WAITING_APPROVAL,
      TOOL_EXECUTION_STATUS.SUCCEEDED,
      TOOL_EXECUTION_STATUS.FAILED,
      TOOL_EXECUTION_STATUS.CANCELLED,
      TOOL_EXECUTION_STATUS.UNKNOWN,
    ]) {
      assert.equal(
        canTransitionToolExecution(from, TOOL_EXECUTION_STATUS.UNKNOWN),
        false,
        `${from} → UNKNOWN must be illegal`,
      );
    }
  });

  it('UNKNOWN has no outgoing transitions (including to FAILED/SUCCEEDED)', () => {
    for (const to of TOOL_EXECUTION_STATUSES) {
      assert.equal(
        canTransitionToolExecution(TOOL_EXECUTION_STATUS.UNKNOWN, to),
        false,
        `UNKNOWN → ${to} must be illegal`,
      );
    }
  });
});

describe('mapToolExecution claim fields null-safe', () => {
  const base = {
    tool_execution_id: '01K0G2PAV8FPMVC9QHJG7JPN5A',
    run_id: '01K0G2PAV8FPMVC9QHJG7JPN5B',
    agent_session_id: '01K0G2PAV8FPMVC9QHJG7JPN5C',
    tool_call_id: 'tc-1',
    tool_name: 'bash',
    tool_source: 'sandbox',
    risk_level: 'low',
    arguments_json: '{}',
    result_json: null,
    status: 'RUNNING',
    error_code: null,
    trace_id: 'a'.repeat(32),
    started_at: null,
    completed_at: null,
    created_at: '2026-07-18 00:00:00.000',
  };

  it('maps null requestHash/requestHashVersion/executionFenceToken as null (never 0)', () => {
    const m = mapToolExecution({
      ...base,
      request_hash: null,
      request_hash_version: null,
      execution_fence_token: null,
    });
    assert.equal(m.requestHash, null);
    assert.equal(m.requestHashVersion, null);
    assert.equal(m.executionFenceToken, null);
    // Explicit: never coerce SQL NULL → 0
    assert.notEqual(m.requestHashVersion, 0);
    assert.notEqual(m.executionFenceToken, 0);
  });

  it('maps undefined claim columns as null (legacy rows)', () => {
    const m = mapToolExecution({ ...base });
    assert.equal(m.requestHash, null);
    assert.equal(m.requestHashVersion, null);
    assert.equal(m.executionFenceToken, null);
  });

  it('maps populated claim fields without coercion', () => {
    const m = mapToolExecution({
      ...base,
      request_hash: 'ab'.repeat(32),
      request_hash_version: 1,
      execution_fence_token: 7,
    });
    assert.equal(m.requestHash, 'ab'.repeat(32));
    assert.equal(m.requestHashVersion, 1);
    assert.equal(m.executionFenceToken, 7);
  });
});
