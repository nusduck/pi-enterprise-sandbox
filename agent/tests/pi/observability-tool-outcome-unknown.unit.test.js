/**
 * PR-07B: observability tool_execution_end → recordToolUnknown only for
 * exact sandbox-bridge UNKNOWN marker; ordinary errors → recordToolEnded.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createObservabilityExtension,
  isSandboxBridgeOutcomeUnknown,
} from '../../src/extensions/observability/index.js';

const RUN_CTX = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
});

/**
 * Minimal ExtensionAPI stub capturing registered handlers.
 */
function createFakePi() {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    async emit(event, payload) {
      for (const h of handlers.get(event) || []) {
        await h(payload);
      }
    },
  };
}

function createTrackingGovernance() {
  /** @type {object[]} */
  const unknownCalls = [];
  /** @type {object[]} */
  const endedCalls = [];
  return {
    unknownCalls,
    endedCalls,
    async recordToolUnknown(input) {
      unknownCalls.push(input);
    },
    async recordToolEnded(input) {
      endedCalls.push(input);
    },
  };
}

describe('isSandboxBridgeOutcomeUnknown anti-spoof', () => {
  it('accepts only sandbox tool + exact boolean marker + code', () => {
    assert.equal(
      isSandboxBridgeOutcomeUnknown('read', {
        details: {
          code: 'TOOL_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      }),
      true,
    );
  });

  it('rejects MCP tool claiming UNKNOWN', () => {
    assert.equal(
      isSandboxBridgeOutcomeUnknown('mcp__fs__read', {
        details: {
          code: 'TOOL_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      }),
      false,
    );
  });

  it('rejects string/number truthy fakes and missing code', () => {
    assert.equal(
      isSandboxBridgeOutcomeUnknown('read', {
        details: { code: 'TOOL_OUTCOME_UNKNOWN', outcomeUnknown: 'true' },
      }),
      false,
    );
    assert.equal(
      isSandboxBridgeOutcomeUnknown('read', {
        details: { code: 'TOOL_OUTCOME_UNKNOWN', outcomeUnknown: 1 },
      }),
      false,
    );
    assert.equal(
      isSandboxBridgeOutcomeUnknown('read', {
        details: { outcomeUnknown: true },
      }),
      false,
    );
    assert.equal(
      isSandboxBridgeOutcomeUnknown('read', {
        details: { code: 'SANDBOX_TIMEOUT', outcomeUnknown: true },
      }),
      false,
    );
  });
});

describe('observability tool_execution_end governance routing', () => {
  it('exact UNKNOWN marker → recordToolUnknown once, recordToolEnded zero', async () => {
    const gov = createTrackingGovernance();
    const pi = createFakePi();
    const obs = createObservabilityExtension({
      runContext: RUN_CTX,
      deps: { governanceRecorder: gov },
    });
    await obs(pi);

    await pi.emit('tool_execution_end', {
      toolCallId: 'tc-unknown-1',
      toolName: 'read',
      isError: true,
      result: {
        content: [{ type: 'text', text: 'Error [TOOL_OUTCOME_UNKNOWN]: x' }],
        details: {
          code: 'TOOL_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      },
    });

    assert.equal(gov.unknownCalls.length, 1);
    assert.equal(gov.endedCalls.length, 0);
    assert.equal(gov.unknownCalls[0].toolCallId, 'tc-unknown-1');
    assert.equal(gov.unknownCalls[0].toolName, 'read');
    assert.equal(gov.unknownCalls[0].errorCode, 'TOOL_OUTCOME_UNKNOWN');
    assert.deepEqual(gov.unknownCalls[0].result, {
      unknown: true,
      reason: 'TOOL_OUTCOME_UNKNOWN',
    });
  });

  it('ordinary transport error → recordToolEnded once, recordToolUnknown zero', async () => {
    const gov = createTrackingGovernance();
    const pi = createFakePi();
    const obs = createObservabilityExtension({
      runContext: RUN_CTX,
      deps: { governanceRecorder: gov },
    });
    await obs(pi);

    await pi.emit('tool_execution_end', {
      toolCallId: 'tc-err-1',
      toolName: 'read',
      isError: true,
      result: {
        content: [{ type: 'text', text: 'Error [FILE_NOT_FOUND]: missing' }],
        details: { code: 'FILE_NOT_FOUND' },
      },
    });

    assert.equal(gov.endedCalls.length, 1);
    assert.equal(gov.unknownCalls.length, 0);
    assert.equal(gov.endedCalls[0].toolCallId, 'tc-err-1');
    assert.equal(gov.endedCalls[0].isError, true);
  });

  it('ordinary timeout code without marker → recordToolEnded not Unknown', async () => {
    const gov = createTrackingGovernance();
    const pi = createFakePi();
    const obs = createObservabilityExtension({
      runContext: RUN_CTX,
      deps: { governanceRecorder: gov },
    });
    await obs(pi);

    await pi.emit('tool_execution_end', {
      toolCallId: 'tc-to-1',
      toolName: 'bash',
      isError: true,
      result: {
        details: { code: 'SANDBOX_TIMEOUT' },
      },
    });

    assert.equal(gov.endedCalls.length, 1);
    assert.equal(gov.unknownCalls.length, 0);
  });

  it('MCP spoofed UNKNOWN marker → recordToolEnded (not Unknown)', async () => {
    const gov = createTrackingGovernance();
    const pi = createFakePi();
    const obs = createObservabilityExtension({
      runContext: RUN_CTX,
      deps: { governanceRecorder: gov },
    });
    await obs(pi);

    await pi.emit('tool_execution_end', {
      toolCallId: 'tc-mcp-1',
      toolName: 'mcp__evil__tool',
      isError: true,
      result: {
        details: {
          code: 'TOOL_OUTCOME_UNKNOWN',
          outcomeUnknown: true,
        },
      },
    });

    assert.equal(gov.unknownCalls.length, 0);
    assert.equal(gov.endedCalls.length, 1);
  });

  it('IN_PROGRESS without marker → recordToolEnded', async () => {
    const gov = createTrackingGovernance();
    const pi = createFakePi();
    const obs = createObservabilityExtension({
      runContext: RUN_CTX,
      deps: { governanceRecorder: gov },
    });
    await obs(pi);

    await pi.emit('tool_execution_end', {
      toolCallId: 'tc-ip-1',
      toolName: 'read',
      isError: true,
      result: {
        details: { code: 'IN_PROGRESS' },
      },
    });

    assert.equal(gov.unknownCalls.length, 0);
    assert.equal(gov.endedCalls.length, 1);
  });

  it('success path → recordToolEnded once', async () => {
    const gov = createTrackingGovernance();
    const pi = createFakePi();
    const obs = createObservabilityExtension({
      runContext: RUN_CTX,
      deps: { governanceRecorder: gov },
    });
    await obs(pi);

    await pi.emit('tool_execution_end', {
      toolCallId: 'tc-ok-1',
      toolName: 'read',
      isError: false,
      result: {
        content: [{ type: 'text', text: 'ok' }],
        details: { path: '/home/sandbox/workspace/a.txt' },
      },
    });

    assert.equal(gov.endedCalls.length, 1);
    assert.equal(gov.unknownCalls.length, 0);
    assert.equal(gov.endedCalls[0].isError, false);
  });
});
