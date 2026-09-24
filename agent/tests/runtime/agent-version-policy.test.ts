/**
 * P0/P1 regressions for the AgentVersion -> runtime policy boundary.
 *
 * These cases intentionally exercise the installed hooks instead of checking
 * that a binding object exists.  Before the fix, all four expectations below
 * either allowed a call or selected the less restrictive risk layer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnterprisePolicy } from '../../src/runtime/policy/install.js';
import { InMemoryApprovalStore, evaluatePreExecute } from '../../src/runtime/policy/pre-execute.js';
import {
  buildRunPolicyResolver,
  buildRunRiskResolver,
} from '../../src/application/tool-risk-resolver.js';
import { buildAgentVersionToolRiskBindings } from '../../src/application/tool-risk-bindings.js';
import { bindAgentVersionConfig } from '../../src/infrastructure/dsh/agent-version-bindings.js';

type Listener = (...args: unknown[]) => unknown;

class PolicyCtx {
  readonly listeners = new Map<string, Listener[]>();
  readonly guards: Array<(exec: unknown) => string | undefined> = [];
  readonly restrictions: Array<{ allow?: readonly string[] }> = [];
  readonly tools = {
    guard: (fn: (exec: unknown) => string | undefined) => {
      this.guards.push(fn);
      return () => undefined;
    },
    restrict: (filter: { allow?: readonly string[] }) => {
      this.restrictions.push(filter);
      return () => undefined;
    },
  };
  on(name: string, fn: Listener) {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
    return () => {
      const current = this.listeners.get(name) ?? [];
      const i = current.indexOf(fn);
      if (i >= 0) current.splice(i, 1);
    };
  }
  inject(_names: readonly string[], apply: (scope: this) => void) {
    apply(this);
    return () => undefined;
  }
  async pre(exec: object) {
    const fn = this.listeners.get('tools/pre-execute')?.[0];
    assert.ok(fn);
    return await fn(exec, async () => ({ kind: 'allow' }));
  }
  guardReason(exec: object) {
    for (const guard of this.guards) {
      const reason = guard(exec);
      if (reason !== undefined) return reason;
    }
    return undefined;
  }
}

function install(ctx: PolicyCtx, options: Record<string, unknown>) {
  return installEnterprisePolicy(ctx as never, {
    approvalStore: new InMemoryApprovalStore(),
    ...options,
  } as never);
}

test('P1 AgentVersion explicit deny is an execution guard, not an unused binding', async () => {
  const ctx = new PolicyCtx();
  install(ctx, {
    authorization: {
      decisions: { bash: 'deny' },
      mcpServers: {},
      mcpConfigured: true,
    },
  });

  const result = await ctx.pre({ name: 'bash', arguments: { command: 'printf x' }, id: 'deny-1' });
  assert.equal((result as { kind: string }).kind, 'deny');
  assert.match(String(ctx.guardReason({ name: 'bash', arguments: {}, id: 'deny-1' })), /AGENT_VERSION|deny/i);
});

test('P1 MCP server and tool references are both required for authorization', async () => {
  const selectedCtx = new PolicyCtx();
  install(selectedCtx, {
    authorization: {
      decisions: {},
      mcpServers: {
        github: { enabledTools: ['issues_list'], decisions: {} },
      },
      mcpConfigured: true,
    },
  });

  const selected = await selectedCtx.pre({ name: 'mcp__github__issues_list', arguments: {}, id: 'mcp-1' });
  assert.equal((selected as { kind: string }).kind, 'ask', 'platform external_high still requires approval');

  // A selected high-risk call parks its own Run. Use a fresh scope for the
  // unselected case so the assertion proves the MCP allowlist reason rather
  // than the unrelated RUN_PARKED guard.
  const unselectedCtx = new PolicyCtx();
  install(unselectedCtx, {
    authorization: {
      decisions: {},
      mcpServers: {
        github: { enabledTools: ['issues_list'], decisions: {} },
      },
      mcpConfigured: true,
    },
  });
  const unselected = await unselectedCtx.pre({ name: 'mcp__github__issues_delete', arguments: {}, id: 'mcp-2' });
  assert.equal((unselected as { kind: string }).kind, 'deny');

  const noServer = new PolicyCtx();
  install(noServer, {
    authorization: { decisions: {}, mcpServers: {}, mcpConfigured: true },
  });
  const denied = await noServer.pre({ name: 'mcp__github__issues_list', arguments: {}, id: 'mcp-3' });
  assert.equal((denied as { kind: string }).kind, 'deny');
});

test('P1 empty visible/authorized lists are restrictive, never an omitted allowlist', async () => {
  const ctx = new PolicyCtx();
  install(ctx, {
    visibleTools: [],
    authorization: {
      decisions: {},
      mcpServers: {},
      mcpConfigured: true,
    },
  });
  assert.deepEqual(ctx.restrictions, [{ allow: [] }]);
  const result = await ctx.pre({ name: 'read', arguments: {}, id: 'empty-1' });
  assert.equal((result as { kind: string }).kind, 'allow', 'local read remains inherited when only MCP is absent');
  assert.equal((await ctx.pre({ name: 'mcp__x__tool', arguments: {}, id: 'empty-2' }) as { kind: string }).kind, 'deny');
});

test('P1 risk layers merge effective decisions across specificity', () => {
  const resolve = buildRunRiskResolver(
    { tools: { 'mcp__x__*': 'high' } },
    { agentVersionId: 'v1', configJson: { toolPolicy: { riskLevels: { 'mcp__x__tool': 'low' } } } },
  );
  assert.equal(resolve('mcp__x__tool'), 'high');
});

test('P1 an AgentVersion low cannot lower the unconfigured MCP high floor', () => {
  // Nothing on the platform classifies this call, so ADR 0009 D9 §2's
  // external-high floor stands. A tenant may only tighten — a version-level
  // `low` here would be the tenant granting itself an approval bypass.
  const tenantOnly = buildRunPolicyResolver(
    {},
    {
      agentVersionId: 'v-low',
      configJson: { toolPolicy: { riskLevels: { 'mcp__x__tool': 'low' } } },
    },
  );
  assert.equal(tenantOnly('mcp__x__tool').decision, 'require_approval');

  // The contrast: a deliberate platform classification of the same exact call
  // is a valid override and survives.
  const platformLow = buildRunPolicyResolver(
    { tools: { 'mcp__x__tool': 'low' } },
    { agentVersionId: 'v-none', configJson: {} },
  );
  assert.equal(platformLow('mcp__x__tool').decision, 'allow');

  // And a tenant tightening the same call still applies.
  const tenantStricter = buildRunPolicyResolver(
    { tools: { 'mcp__x__tool': 'low' } },
    {
      agentVersionId: 'v-high',
      configJson: { toolPolicy: { riskLevels: { 'mcp__x__tool': 'critical' } } },
    },
  );
  assert.equal(tenantStricter('mcp__x__tool').decision, 'deny');
});

test('P1 complete platform policy resolver is not replaced by the default risk table', async () => {
  const ctx = new PolicyCtx();
  const resolve = buildRunPolicyResolver(
    { tools: { todo_write: 'high' }, riskApproval: { high: 'allow' } },
    null,
  );
  install(ctx, {
    policyResolver: (toolName: string) => resolve(toolName),
  });
  const result = await ctx.pre({ name: 'todo_write', arguments: {}, id: 'policy-1' });
  assert.equal((result as { kind: string }).kind, 'allow');
});

test('P1 legacy flat decisions cannot loosen nested or aliased decisions', () => {
  const config = {
    schemaVersion: 0,
    toolPolicy: {
      tools: { bash: 'deny', glob: 'allow' },
      bash: 'allow',
      ls: 'deny',
    },
  };
  const authorization = bindAgentVersionConfig({
    agentVersionId: 'legacy-conflict',
    configJson: config,
  }).authorization;
  assert.equal(authorization.decisions.bash, 'deny');
  assert.equal(authorization.decisions.glob, 'deny');

  const projected = buildAgentVersionToolRiskBindings({ configJson: config })
    .agentVersionToolPolicy as Record<string, unknown>;
  assert.equal(projected.bash, 'deny');
  assert.equal(projected.glob, 'deny');
});

test('P1 approved durable replay without an args integrity fingerprint fails closed', async () => {
  let consumed = 0;
  const store = {
    async persistPending() {},
    async get() { return null; },
    async findResolvedByDigest() {
      return {
        id: 'durable-approval',
        toolName: 'bash',
        sourceDigest: 'a'.repeat(64),
        argsIntegrity: null,
        argsCanonical: '{}',
        status: 'APPROVED' as const,
        runStatusHint: 'WAITING_APPROVAL' as const,
      };
    },
    async consume() { consumed += 1; },
  };
  await assert.rejects(
    () => evaluatePreExecute({ toolName: 'bash', args: {}, callId: 'replay-1' }, store),
    /integrity|fingerprint|approved/i,
  );
  assert.equal(consumed, 0, 'missing durable integrity must not consume approval');

  let allowedConsumed = 0;
  const exactStore = {
    async persistPending() {},
    async get() { return null; },
    async findResolvedByDigest() {
      return {
        id: 'durable-approval-exact',
        toolName: 'bash',
        sourceDigest: 'a'.repeat(64),
        argsIntegrity: 'b'.repeat(64),
        argsCanonical: '{}',
        status: 'APPROVED' as const,
        runStatusHint: 'WAITING_APPROVAL' as const,
      };
    },
    async consume() { allowedConsumed += 1; },
  };
  const replay = await evaluatePreExecute(
    { toolName: 'bash', args: {}, callId: 'replay-exact' },
    exactStore,
  );
  assert.equal(replay.decision.reasonCode, 'APPROVAL_GRANTED_ONCE');
  assert.equal(allowedConsumed, 1, 'a matching durable fingerprint may be consumed once');
});
