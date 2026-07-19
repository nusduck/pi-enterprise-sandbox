/**
 * enterprise-policy fail-closed tool_call gate (PR-06 review).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnterprisePolicyExtension,
  validatePolicyDecision,
} from '../../src/extensions/enterprise-policy/index.js';

const RUN_CTX = {
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
};

function fullAllow(overrides = {}) {
  return {
    decision: 'allow',
    reasonCode: 'OK',
    reason: 'allowed by test',
    policyId: 'pol-test',
    riskLevel: 'low',
    ...overrides,
  };
}

async function runToolCall(
  factory,
  event = { toolCallId: 'tc-default-bash', toolName: 'bash', input: {} },
) {
  const handlers = new Map();
  const pi = {
    registerTool() {},
    on(ev, h) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(h);
    },
  };
  await factory(pi);
  assert.ok(handlers.has('tool_call'), 'tool_call must always be registered');
  const results = [];
  for (const h of handlers.get('tool_call')) {
    results.push(await h(event, {}));
  }
  return results[0];
}

describe('validatePolicyDecision', () => {
  it('requires full shape', () => {
    assert.equal(validatePolicyDecision(null), null);
    assert.equal(validatePolicyDecision({ decision: 'allow' }), null);
    assert.ok(validatePolicyDecision(fullAllow()));
    assert.equal(
      validatePolicyDecision(fullAllow({ riskLevel: 'extreme' })),
      null,
    );
  });
});

describe('enterprise-policy fail-closed', () => {
  it('blocks when policyEngine missing (POLICY_ENGINE_UNAVAILABLE)', async () => {
    const factory = createEnterprisePolicyExtension({ runContext: RUN_CTX });
    const r = await runToolCall(factory);
    assert.equal(r.block, true);
    assert.match(r.reason, /POLICY_ENGINE_UNAVAILABLE/);
  });

  it('blocks deny decisions', async () => {
    const factory = createEnterprisePolicyExtension({
      runContext: RUN_CTX,
      deps: {
        policyEngine: {
          evaluateToolCall: async () =>
            fullAllow({
              decision: 'deny',
              reasonCode: 'DENIED',
              reason: 'nope',
              riskLevel: 'high',
            }),
        },
      },
    });
    const r = await runToolCall(factory);
    assert.equal(r.block, true);
    assert.match(r.reason, /DENIED|nope/);
  });

  it('blocks require_approval without coordinator', async () => {
    const factory = createEnterprisePolicyExtension({
      runContext: RUN_CTX,
      deps: {
        policyEngine: {
          evaluateToolCall: async () =>
            fullAllow({
              decision: 'require_approval',
              reasonCode: 'NEEDS_APPROVAL',
              reason: 'external write',
              riskLevel: 'critical',
            }),
        },
      },
    });
    const r = await runToolCall(factory);
    assert.equal(r.block, true);
    assert.match(r.reason, /POLICY_APPROVAL_UNAVAILABLE/);
  });

  it('blocks require_approval when coordinator does not allow', async () => {
    const factory = createEnterprisePolicyExtension({
      runContext: RUN_CTX,
      deps: {
        policyEngine: {
          evaluateToolCall: async () =>
            fullAllow({
              decision: 'require_approval',
              reasonCode: 'NEEDS_APPROVAL',
              reason: 'external write',
              riskLevel: 'critical',
            }),
        },
        approvalCoordinator: {
          requestApproval: async () => ({ allowed: false, reason: 'pending' }),
        },
      },
    });
    const r = await runToolCall(factory);
    assert.equal(r.block, true);
    assert.match(r.reason, /POLICY_APPROVAL_REQUIRED|pending/);
  });

  it('allows only complete allow decision', async () => {
    const factory = createEnterprisePolicyExtension({
      runContext: RUN_CTX,
      deps: {
        policyEngine: {
          evaluateToolCall: async () => fullAllow(),
        },
      },
    });
    const r = await runToolCall(factory);
    assert.equal(r, undefined);
  });

  it('blocks incomplete PolicyDecision shape', async () => {
    const factory = createEnterprisePolicyExtension({
      runContext: RUN_CTX,
      deps: {
        policyEngine: {
          evaluateToolCall: async () => ({ decision: 'allow' }),
        },
      },
    });
    const r = await runToolCall(factory);
    assert.equal(r.block, true);
    assert.match(r.reason, /POLICY_DECISION_INVALID/);
  });
});
