/**
 * enterprise-policy layered classification + audit (PR-06 B1).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEnterpriseExtensionBundle,
  createPolicyEngine,
  classifyTool,
  SANDBOX_TOOL_NAMES,
} from '../../src/extensions/index.js';

const RUN = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: '01K0G2PAV8FPMVC9QHJG7JPN5F',
  traceId: 'b'.repeat(32),
  executionFenceToken: 3,
});

async function invokeToolCall(factory, toolName, args = {}) {
  const handlers = new Map();
  const pi = {
    registerTool() {},
    on(ev, h) {
      if (!handlers.has(ev)) handlers.set(ev, []);
      handlers.get(ev).push(h);
    },
  };
  await factory(pi);
  const hs = handlers.get('tool_call') || [];
  assert.ok(hs.length >= 1);
  return hs[0](
    {
      toolCallId: `tc-${toolName}-${Math.random().toString(16).slice(2, 10)}`,
      toolName,
      input: args,
    },
    {},
  );
}

describe('classifyTool', () => {
  it('classifies local 10 as local_low, mcp as external, unknown deny class', () => {
    for (const n of SANDBOX_TOOL_NAMES) {
      assert.equal(classifyTool(n).class, 'local_low');
    }
    assert.equal(
      classifyTool('mcp__risk_db__query', {
        mcpReadOnlyTools: ['mcp__risk_db__query'],
      }).class,
      'external_readonly',
    );
    assert.equal(classifyTool('mcp__risk_db__mutate').class, 'external_high');
    assert.equal(classifyTool('weird_tool').class, 'unknown');
  });
});

describe('policy engine layers + audit', () => {
  it('ordinary bash allows with 0 approval calls and complete audit', async () => {
    /** @type {object[]} */
    const audits = [];
    let approvals = 0;
    const engine = createPolicyEngine({
      auditSink: async (ev) => {
        audits.push(ev);
      },
    });
    const factories = createEnterpriseExtensionBundle(RUN, {
      policyEngine: engine,
      approvalCoordinator: {
        requestApproval: async () => {
          approvals += 1;
          return { allowed: true };
        },
      },
      sandboxTransport: null,
    });
    const r = await invokeToolCall(factories[1], 'bash', {
      command: 'echo hello',
    });
    assert.equal(r, undefined, 'bash should be allowed (no block)');
    assert.equal(approvals, 0);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].decision, 'allow');
    assert.equal(audits[0].toolName, 'bash');
    assert.ok(audits[0].context.runId);
    assert.ok(audits[0].reasonCode);
    assert.ok(audits[0].policyId);
    assert.ok(audits[0].riskLevel);
  });

  it('host escape / sensitive env denied (not approval)', async () => {
    const audits = [];
    let approvals = 0;
    const engine = createPolicyEngine({
      auditSink: async (ev) => audits.push(ev),
    });
    const factories = createEnterpriseExtensionBundle(RUN, {
      policyEngine: engine,
      approvalCoordinator: {
        requestApproval: async () => {
          approvals += 1;
          return { allowed: true };
        },
      },
    });
    const r1 = await invokeToolCall(factories[1], 'bash', {
      command: 'cat /etc/passwd',
    });
    assert.equal(r1.block, true);
    assert.match(r1.reason, /HOST_ESCAPE|denied/i);
    assert.equal(approvals, 0);

    const r2 = await invokeToolCall(factories[1], 'bash', {
      command: 'echo x',
      env: { AWS_SECRET_ACCESS_KEY: 'x' },
    });
    assert.equal(r2.block, true);
    assert.match(r2.reason, /ENV_SENSITIVE|denied/i);
    assert.equal(approvals, 0);
  });

  it('skill write / path traversal denied', async () => {
    const engine = createPolicyEngine({
      auditSink: async () => {},
    });
    const factories = createEnterpriseExtensionBundle(RUN, {
      policyEngine: engine,
    });
    const r = await invokeToolCall(factories[1], 'write', {
      path: '/home/sandbox/skill/hack.py',
      content: 'x',
    });
    assert.equal(r.block, true);
    assert.match(r.reason, /SKILL|PATH/i);

    const r2 = await invokeToolCall(factories[1], 'read', {
      path: '../../../etc/passwd',
    });
    assert.equal(r2.block, true);
  });

  it('audit failure blocks allow', async () => {
    const engine = createPolicyEngine({
      auditSink: async () => {
        throw new Error('audit down');
      },
    });
    const factories = createEnterpriseExtensionBundle(RUN, {
      policyEngine: engine,
    });
    const r = await invokeToolCall(factories[1], 'read', {
      path: 'data/a.txt',
    });
    assert.equal(r.block, true);
    assert.match(r.reason, /POLICY_AUDIT_FAILED/);
  });

  it('audit unavailable blocks allow', async () => {
    const engine = createPolicyEngine({
      // no auditSink
    });
    const d = await engine.evaluateToolCall({
      toolName: 'bash',
      args: { command: 'echo 1' },
      runContext: RUN,
    });
    assert.equal(d.decision, 'deny');
    assert.equal(d.reasonCode, 'POLICY_AUDIT_UNAVAILABLE');
  });

  it('external readonly allow + rate limit; high risk requires approval', async () => {
    /** @type {object[]} */
    const rateCalls = [];
    let approvals = 0;
    const engine = createPolicyEngine({
      auditSink: async () => {},
      mcpReadOnlyTools: ['mcp__risk_db__query'],
      rateLimitPort: {
        check: async (input) => {
          rateCalls.push(input);
          return { allowed: true };
        },
      },
      agentVersionToolPolicy: {
        'mcp__crm__delete': 'require_approval',
      },
    });
    const factories = createEnterpriseExtensionBundle(RUN, {
      policyEngine: engine,
      approvalCoordinator: {
        requestApproval: async () => {
          approvals += 1;
          return { allowed: false, reason: 'pending human' };
        },
      },
    });

    const rRead = await invokeToolCall(factories[1], 'mcp__risk_db__query', {
      sql: 'select 1',
    });
    assert.equal(rRead, undefined);
    assert.equal(rateCalls.length, 1);

    const rHigh = await invokeToolCall(factories[1], 'mcp__crm__delete', {
      id: '1',
    });
    assert.equal(rHigh.block, true);
    assert.match(rHigh.reason, /POLICY_APPROVAL_REQUIRED|pending/);
    assert.equal(approvals, 1);
  });

  it('unknown tool denied by default', async () => {
    const engine = createPolicyEngine({ auditSink: async () => {} });
    const factories = createEnterpriseExtensionBundle(RUN, {
      policyEngine: engine,
    });
    const r = await invokeToolCall(factories[1], 'internal_debug_tool', {});
    assert.equal(r.block, true);
    assert.match(r.reason, /UNKNOWN_TOOL/);
  });

  it('MCP tool call never hits sandbox transport', async () => {
    const transportCalls = [];
    const transport = new Proxy(
      {},
      {
        get() {
          return async () => {
            transportCalls.push(1);
            return {};
          };
        },
      },
    );
    const engine = createPolicyEngine({
      auditSink: async () => {},
      mcpReadOnlyTools: ['mcp__k__search'],
      rateLimitPort: { check: async () => ({ allowed: true }) },
    });
    const factories = createEnterpriseExtensionBundle(RUN, {
      sandboxTransport: transport,
      policyEngine: engine,
    });
    // policy allow for readonly mcp — transport not involved
    await invokeToolCall(factories[1], 'mcp__k__search', { q: 'x' });
    assert.equal(transportCalls.length, 0);
  });

  it('lower layer cannot relax higher deny', async () => {
    const engine = createPolicyEngine({
      auditSink: async () => {},
      layers: {
        platform: {
          evaluateToolCall: () => ({
            decision: 'deny',
            reasonCode: 'PLATFORM_DENY',
            reason: 'platform denies bash',
            policyId: 'platform:test',
            riskLevel: 'critical',
          }),
        },
        organization: {
          evaluateToolCall: () => ({
            decision: 'allow',
            reasonCode: 'ORG_ALLOW',
            reason: 'org wants allow',
            policyId: 'org:test',
            riskLevel: 'low',
          }),
        },
      },
    });
    const d = await engine.evaluateToolCall({
      toolName: 'bash',
      args: { command: 'echo 1' },
      runContext: RUN,
    });
    assert.equal(d.decision, 'deny');
    assert.equal(d.reasonCode, 'PLATFORM_DENY');
  });

  it('async platform deny defeats lower allow (awaited layer evaluators)', async () => {
    const engine = createPolicyEngine({
      auditSink: async () => {},
      layers: {
        platform: {
          evaluateToolCall: async () => {
            await new Promise((r) => setTimeout(r, 5));
            return {
              decision: 'deny',
              reasonCode: 'PLATFORM_ASYNC_DENY',
              reason: 'async platform deny',
              policyId: 'platform:async',
              riskLevel: 'critical',
            };
          },
        },
        organization: {
          evaluateToolCall: async () => ({
            decision: 'allow',
            reasonCode: 'ORG_ALLOW',
            reason: 'org allow',
            policyId: 'org:async',
            riskLevel: 'low',
          }),
        },
      },
    });
    const d = await engine.evaluateToolCall({
      toolName: 'bash',
      args: { command: 'echo 1' },
      runContext: RUN,
    });
    assert.equal(d.decision, 'deny');
    assert.equal(d.reasonCode, 'PLATFORM_ASYNC_DENY');
  });

  it('readonly MCP denies when rate limiter missing/malformed/throws', async () => {
    const cases = [
      {
        name: 'missing',
        rateLimitPort: null,
        code: 'RATE_LIMIT_REQUIRED',
      },
      {
        name: 'malformed',
        rateLimitPort: {
          check: async () => ({ allowed: 'yes' }),
        },
        code: 'RATE_LIMIT_MALFORMED',
      },
      {
        name: 'no-allowed-field',
        rateLimitPort: {
          check: async () => ({}),
        },
        code: 'RATE_LIMIT_MALFORMED',
      },
      {
        name: 'throws',
        rateLimitPort: {
          check: async () => {
            throw new Error('limiter boom');
          },
        },
        code: 'RATE_LIMIT_UNAVAILABLE',
      },
      {
        name: 'explicit-false',
        rateLimitPort: {
          check: async () => ({ allowed: false, reason: 'quota' }),
        },
        code: 'RATE_LIMITED',
      },
    ];

    for (const c of cases) {
      const engine = createPolicyEngine({
        auditSink: async () => {},
        mcpReadOnlyTools: ['mcp__risk_db__query'],
        rateLimitPort: c.rateLimitPort,
      });
      const d = await engine.evaluateToolCall({
        toolName: 'mcp__risk_db__query',
        args: { sql: 'select 1' },
        runContext: RUN,
      });
      assert.equal(d.decision, 'deny', c.name);
      assert.equal(d.reasonCode, c.code, c.name);
    }
  });
});
