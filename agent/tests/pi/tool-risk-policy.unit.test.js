/**
 * Configurable tool risk levels drive approval (no separate approval switch).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createPolicyEngine } from '../../src/extensions/enterprise-policy/policy-engine.js';
import {
  ToolRiskPolicyError,
  decisionForRiskLevel,
  defaultToolRiskPolicy,
  loadToolRiskPolicy,
  mergeToolRiskPolicies,
  resolveToolRiskLevel,
} from '../../src/extensions/enterprise-policy/tool-risk-policy.js';
import { buildAgentVersionToolRiskBindings } from '../../src/application/tool-risk-bindings.js';
import { buildMcpPolicyBindings } from '../../src/infrastructure/mcp/pi-mcp-adapter-factory.js';

const RUN_CONTEXT = Object.freeze({
  orgId: 'org',
  userId: 'user',
  conversationId: 'conv',
  agentSessionId: 'sess',
  runId: 'run',
  sandboxSessionId: 'sbx',
  traceId: 'trace',
});

function engine(overrides = {}) {
  return createPolicyEngine({
    auditSink: async () => {},
    rateLimitPort: { check: () => ({ allowed: true }) },
    ...overrides,
  });
}

describe('loadToolRiskPolicy', () => {
  test('defaults reproduce the pre-configuration behaviour', () => {
    const policy = defaultToolRiskPolicy();
    assert.equal(decisionForRiskLevel('low', policy), 'allow');
    assert.equal(decisionForRiskLevel('medium', policy), 'allow');
    assert.equal(decisionForRiskLevel('high', policy), 'require_approval');
    assert.equal(decisionForRiskLevel('critical', policy), 'deny');
  });

  test('accepts bare levels, object entries, and _-prefixed comments', () => {
    const policy = loadToolRiskPolicy({
      _comment: 'ignored',
      tools: { bash: 'high', write: { riskLevel: 'critical' } },
      mcpServers: { github: 'medium' },
    });
    assert.equal(policy.tools.bash, 'high');
    assert.equal(policy.tools.write, 'critical');
    assert.equal(policy.mcpServers.github.riskLevel, 'medium');
  });

  test('rejects unknown fields, bad levels, and multi-star patterns', () => {
    assert.throws(() => loadToolRiskPolicy({ nope: {} }), ToolRiskPolicyError);
    assert.throws(
      () => loadToolRiskPolicy({ tools: { bash: 'extreme' } }),
      ToolRiskPolicyError,
    );
    assert.throws(
      () => loadToolRiskPolicy({ tools: { 'mcp__*__x': 'high' } }),
      ToolRiskPolicyError,
    );
    assert.throws(
      () => loadToolRiskPolicy({ classRiskLevels: { made_up: 'high' } }),
      ToolRiskPolicyError,
    );
  });

  test('resolution order: exact > server::tool > pattern > server > class', () => {
    const policy = loadToolRiskPolicy({
      tools: {
        'mcp__github__delete_repo': 'critical',
        'github::merge_pr': 'high',
        'mcp__github__read_*': 'low',
        'mcp__github__*': 'medium',
      },
      mcpServers: { jira: { riskLevel: 'high', tools: { search: 'low' } } },
    });
    const gh = (tool) => ({ class: 'external_high', serverId: 'github', tool });

    assert.equal(
      resolveToolRiskLevel('mcp__github__delete_repo', gh('delete_repo'), policy)
        .riskLevel,
      'critical',
    );
    assert.equal(
      resolveToolRiskLevel('mcp__github__merge_pr', gh('merge_pr'), policy).riskLevel,
      'high',
    );
    // Longest prefix wins over the broader server-wide pattern.
    assert.equal(
      resolveToolRiskLevel('mcp__github__read_file', gh('read_file'), policy)
        .riskLevel,
      'low',
    );
    assert.equal(
      resolveToolRiskLevel('mcp__github__anything', gh('anything'), policy).riskLevel,
      'medium',
    );
    assert.equal(
      resolveToolRiskLevel(
        'mcp__jira__search',
        { class: 'external_high', serverId: 'jira', tool: 'search' },
        policy,
      ).riskLevel,
      'low',
    );
    assert.equal(
      resolveToolRiskLevel(
        'mcp__jira__create',
        { class: 'external_high', serverId: 'jira', tool: 'create' },
        policy,
      ).riskLevel,
      'high',
    );
    assert.equal(
      resolveToolRiskLevel('read', { class: 'local_low' }, policy).riskLevel,
      'low',
    );
  });
});

describe('mergeToolRiskPolicies (lower layer may only tighten)', () => {
  test('override raises risk but cannot lower it', () => {
    const base = loadToolRiskPolicy({ tools: { bash: 'high', read: 'low' } });
    const override = loadToolRiskPolicy({
      tools: { bash: 'low', read: 'critical' },
    });
    const merged = mergeToolRiskPolicies(base, override);
    assert.equal(merged.tools.bash, 'high', 'attempted downgrade ignored');
    assert.equal(merged.tools.read, 'critical', 'upgrade honored');
  });

  test('override may tighten a risk level price but not relax it', () => {
    const base = loadToolRiskPolicy({ riskApproval: { high: 'require_approval' } });
    const merged = mergeToolRiskPolicies(
      base,
      loadToolRiskPolicy({ riskApproval: { high: 'allow', medium: 'deny' } }),
    );
    assert.equal(merged.riskApproval.high, 'require_approval');
    assert.equal(merged.riskApproval.medium, 'deny');
  });

  test('merges per-server risk without losing either side', () => {
    const merged = mergeToolRiskPolicies(
      loadToolRiskPolicy({ mcpServers: { github: { tools: { a: 'low' } } } }),
      loadToolRiskPolicy({
        mcpServers: { github: { riskLevel: 'high', tools: { b: 'critical' } } },
      }),
    );
    assert.equal(merged.mcpServers.github.riskLevel, 'high');
    assert.equal(merged.mcpServers.github.tools.a, 'low');
    assert.equal(merged.mcpServers.github.tools.b, 'critical');
  });
});

describe('policy engine honours configured risk', () => {
  test('raising a local tool to high turns an allow into require_approval', async () => {
    const decision = await engine({
      toolRiskPolicy: { tools: { bash: 'high' } },
    }).evaluateToolCall({
      toolName: 'bash',
      args: { command: 'ls' },
      runContext: RUN_CONTEXT,
    });
    assert.equal(decision.decision, 'require_approval');
    assert.equal(decision.riskLevel, 'high');
    assert.equal(decision.reasonCode, 'TOOL_RISK_POLICY');
  });

  test('raising a local tool to critical denies it', async () => {
    const decision = await engine({
      toolRiskPolicy: { tools: { write: 'critical' } },
    }).evaluateToolCall({
      toolName: 'write',
      args: { path: 'a.txt', content: 'x' },
      runContext: RUN_CONTEXT,
    });
    assert.equal(decision.decision, 'deny');
    assert.equal(decision.riskLevel, 'critical');
  });

  test('lowering an MCP tool to low drops the approval gate', async () => {
    const decision = await engine({
      toolRiskPolicy: { mcpServers: { github: { tools: { search: 'low' } } } },
    }).evaluateToolCall({
      toolName: 'mcp__github__search',
      args: { q: 'x' },
      runContext: RUN_CONTEXT,
    });
    assert.equal(decision.decision, 'allow');
    assert.equal(decision.riskLevel, 'low');
  });

  test('per-server risk applies to every tool on that server', async () => {
    const e = engine({
      toolRiskPolicy: { mcpServers: { billing: { riskLevel: 'critical' } } },
    });
    for (const tool of ['charge', 'refund']) {
      const decision = await e.evaluateToolCall({
        toolName: `mcp__billing__${tool}`,
        args: {},
        runContext: RUN_CONTEXT,
      });
      assert.equal(decision.decision, 'deny', tool);
      assert.equal(decision.riskLevel, 'critical', tool);
    }
  });

  test('riskApproval remaps what a level costs for every tool at that level', async () => {
    const decision = await engine({
      toolRiskPolicy: { riskApproval: { low: 'require_approval' } },
    }).evaluateToolCall({
      toolName: 'read',
      args: { path: 'a.txt' },
      runContext: RUN_CONTEXT,
    });
    assert.equal(decision.decision, 'require_approval');
  });

  test('read-only MCP risk is configurable and still rate-limit gated', async () => {
    const opts = {
      mcpReadOnlyTools: ['mcp__docs__search'],
      toolRiskPolicy: { tools: { 'mcp__docs__search': 'high' } },
    };
    const gated = await engine(opts).evaluateToolCall({
      toolName: 'mcp__docs__search',
      args: {},
      runContext: RUN_CONTEXT,
    });
    assert.equal(gated.decision, 'require_approval');

    // A missing limiter still denies fail-closed regardless of configured risk.
    const noLimiter = await createPolicyEngine({
      auditSink: async () => {},
      rateLimitPort: null,
      mcpReadOnlyTools: ['mcp__docs__search'],
      toolRiskPolicy: { tools: { 'mcp__docs__search': 'low' } },
    }).evaluateToolCall({
      toolName: 'mcp__docs__search',
      args: {},
      runContext: RUN_CONTEXT,
    });
    assert.equal(noLimiter.decision, 'deny');
  });

  test('arg guards still deny however low the configured risk', async () => {
    const decision = await engine({
      toolRiskPolicy: { tools: { bash: 'low' } },
    }).evaluateToolCall({
      toolName: 'bash',
      args: { command: 'cat /home/sandbox/skill/x/SKILL.md > /etc/passwd' },
      runContext: RUN_CONTEXT,
    });
    assert.equal(decision.decision, 'deny');
  });

  test('an unknown tool cannot be unlocked by assigning it low risk', async () => {
    const decision = await engine({
      toolRiskPolicy: { tools: { totally_made_up: 'low' } },
    }).evaluateToolCall({
      toolName: 'totally_made_up',
      args: {},
      runContext: RUN_CONTEXT,
    });
    assert.equal(decision.decision, 'deny');
    assert.equal(decision.reasonCode, 'UNKNOWN_TOOL_DENIED');
  });

  test('explicit tool decision wins but still reports the resolved risk', async () => {
    const decision = await engine({
      agentVersionToolPolicy: { 'mcp__github__search': 'allow' },
      toolRiskPolicy: { tools: { 'mcp__github__search': 'critical' } },
    }).evaluateToolCall({
      toolName: 'mcp__github__search',
      args: {},
      runContext: RUN_CONTEXT,
    });
    assert.equal(decision.decision, 'allow');
    assert.equal(decision.riskLevel, 'critical');
  });

  test('audit record names the risk source so the config line is findable', async () => {
    const audits = [];
    await createPolicyEngine({
      auditSink: async (ev) => audits.push(ev),
      toolRiskPolicy: { tools: { 'bash': 'high' } },
    }).evaluateToolCall({
      toolName: 'bash',
      args: { command: 'ls' },
      runContext: RUN_CONTEXT,
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].riskLevel, 'high');
    assert.equal(audits[0].riskSource, 'tool:bash');
    assert.equal(audits[0].toolClass, 'local_low');
  });

  test('invalid risk config fails at engine construction', () => {
    assert.throws(
      () => createPolicyEngine({ toolRiskPolicy: { tools: { bash: 'nope' } } }),
      ToolRiskPolicyError,
    );
  });
});

describe('AgentVersion risk bindings', () => {
  test('splits explicit decisions from the risk table', () => {
    const { agentVersionToolPolicy, agentVersionToolRiskPolicy } =
      buildAgentVersionToolRiskBindings({
        configJson: {
          toolPolicy: {
            tools: { 'mcp__github__merge': 'deny' },
            riskLevels: { bash: 'high' },
            riskApproval: { medium: 'require_approval' },
          },
        },
      });
    assert.deepEqual(agentVersionToolPolicy, { 'mcp__github__merge': 'deny' });
    assert.equal(agentVersionToolRiskPolicy.tools.bash, 'high');
    assert.equal(agentVersionToolRiskPolicy.riskApproval.medium, 'require_approval');
  });

  test('MCP server toolPolicy risk reaches the risk table', () => {
    const agentVersion = {
      configJson: {
        mcpServers: [
          {
            serverId: 'github',
            toolPolicy: {
              default: 'require_approval',
              riskLevel: 'high',
              toolRiskLevels: { search: 'low' },
            },
          },
        ],
      },
    };
    const { mcpToolRiskPolicy } = buildMcpPolicyBindings(agentVersion);
    assert.equal(mcpToolRiskPolicy.mcpServers.github.riskLevel, 'high');
    assert.equal(mcpToolRiskPolicy.mcpServers.github.tools.search, 'low');

    const { agentVersionToolRiskPolicy } = buildAgentVersionToolRiskBindings(
      agentVersion,
      { mcpToolRiskPolicy },
    );
    assert.equal(agentVersionToolRiskPolicy.mcpServers.github.riskLevel, 'high');
    assert.equal(agentVersionToolRiskPolicy.mcpServers.github.tools.search, 'low');
  });

  test('empty toolPolicy yields no bindings', () => {
    const bindings = buildAgentVersionToolRiskBindings({ configJson: {} });
    assert.equal(bindings.agentVersionToolPolicy, undefined);
    assert.equal(bindings.agentVersionToolRiskPolicy, undefined);
  });
});
