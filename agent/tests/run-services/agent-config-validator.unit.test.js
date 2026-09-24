import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AgentConfigValidator } from '../../src/application/agent-config-validator.js';

const EMPTY_ENV = { MCP_SERVERS_JSON: '[]' };

function validator(options = {}) {
  return new AgentConfigValidator({
    env: EMPTY_ENV,
    platformToolNames: ['bash', 'read'],
    ...options,
  });
}

describe('AgentConfigValidator', () => {
  it('validates riskApproval decisions and known risk classes', () => {
    const result = validator().validate({
      schemaVersion: 1,
      toolPolicy: {
        riskApproval: { high: 'require_approval' },
        classRiskLevels: { local_low: 'medium' },
        riskLevels: { bash: 'high' },
      },
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('rejects an AgentVersion MCP reference when the deployment has no server', () => {
    const result = validator().validate({
      schemaVersion: 1,
      mcpServers: [{ serverId: 'absent', enabledTools: ['anything'] }],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === 'MCP_SERVER_UNAVAILABLE'));
    assert.ok(result.errors.some((error) => error.code === 'MCP_TOOL_UNAVAILABLE'));
  });

  it('does not upgrade an unmappable legacy model reference into a valid v1 config', () => {
    const result = validator().validate({
      modelPolicy: { modelRef: 'legacy-model' },
      skills: ['saved-skill'],
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.code === 'LEGACY_MODEL_UNMAPPABLE'));
    assert.equal(result.normalizedConfig, undefined);
  });

  it('exposes unknown MCP readiness instead of pretending an empty inventory is live', () => {
    const result = new AgentConfigValidator({
      env: EMPTY_ENV,
      mcpDiscovery: { ready: false, servers: [], error: 'not initialized' },
    }).options();
    const servers = result.platformConstraints.mcpServers;
    assert.ok(Array.isArray(servers));
    assert.equal(servers[0], undefined);
    assert.equal(result.platformConstraints.mcpReadiness.status, 'unknown');
  });
});

/**
 * Contrast cases for the rules above. A validator that only ever rejects
 * passes every rejection assertion, so each tightening here is paired with the
 * legitimate configuration it must still accept.
 */
describe('AgentConfigValidator accepted configurations', () => {
  const PLATFORM_MCP = [
    { serverId: 'probe', tools: ['echo', 'read_only'] },
  ];

  it('accepts a complete v1 config and returns a config that re-validates', () => {
    const subject = validator({ mcpServers: PLATFORM_MCP });
    const result = subject.validate({
      schemaVersion: 1,
      systemPrompt: 'You are a build assistant.',
      modelPolicy: { modelId: 'deepseek-flash', maxOutputTokens: 4096 },
      toolPolicy: {
        tools: { bash: 'require_approval', read: 'allow' },
        riskApproval: { high: 'deny' },
        classRiskLevels: { local_low: 'medium' },
        riskLevels: { 'mcp__probe__*': 'critical' },
      },
      mcpServers: [{ serverId: 'probe', enabledTools: ['echo'] }],
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
    assert.ok(result.normalizedConfig);

    // A form/JSON round trip must not lose or invent a field.
    const again = subject.validate(result.normalizedConfig);
    assert.deepEqual(again.errors, []);
    assert.equal(again.valid, true);
    assert.deepEqual(again.normalizedConfig, result.normalizedConfig);
  });

  it('upgrades a legacy model reference that maps onto the catalog', () => {
    const result = validator().validate({
      modelPolicy: { modelRef: 'deepseek-flash' },
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
    assert.equal(result.normalizedConfig?.modelPolicy?.modelId, 'deepseek-flash');
    assert.ok(result.warnings.some((warning) => warning.code === 'LEGACY_MODEL_MAPPED'));
  });

  it('blocks the upgrade of a legacy config whose fields v1 cannot execute', () => {
    const result = validator().validate({ skills: ['saved-skill'] });
    assert.equal(result.valid, false);
    assert.equal(result.normalizedConfig, undefined);
    const blocked = result.errors.filter((error) => error.code === 'LEGACY_FIELD_REQUIRES_MIGRATION');
    assert.deepEqual(blocked.map((error) => error.path), ['skills']);
    assert.deepEqual(result.effectiveSummary.migration.blockedPaths, ['skills']);
  });

  it('drops an empty legacy placeholder instead of blocking or re-emitting it', () => {
    const result = validator().validate({ skills: [], extensions: {} });
    assert.deepEqual(result.errors, []);
    assert.equal(result.valid, true);
    assert.equal(Object.hasOwn(result.normalizedConfig ?? {}, 'skills'), false);
    assert.equal(Object.hasOwn(result.normalizedConfig ?? {}, 'extensions'), false);
  });

  it('authorizes a referenced MCP tool and rejects only the unavailable one', () => {
    const result = validator({ mcpServers: PLATFORM_MCP }).validate({
      schemaVersion: 1,
      mcpServers: [{ serverId: 'probe', enabledTools: ['echo', 'not_registered'] }],
    });
    assert.equal(result.valid, false);
    const paths = result.errors.map((error) => `${error.path}:${error.code}`);
    assert.deepEqual(paths, ['mcpServers[0].enabledTools[1]:MCP_TOOL_UNAVAILABLE']);

    const accepted = validator({ mcpServers: PLATFORM_MCP }).validate({
      schemaVersion: 1,
      mcpServers: [{ serverId: 'probe', enabledTools: ['echo'] }],
    });
    assert.deepEqual(accepted.errors, []);
    assert.deepEqual(
      accepted.normalizedConfig?.mcpServers,
      [{ enabledTools: ['echo'], serverId: 'probe' }],
    );
  });

  it('separates an unreadable inventory from an authoritative empty one', () => {
    const unknown = new AgentConfigValidator({
      env: EMPTY_ENV,
      mcpDiscovery: { ready: false, servers: [], error: 'not initialized' },
    }).validate({ schemaVersion: 1, mcpServers: [{ serverId: 'probe', enabledTools: ['echo'] }] });
    assert.equal(unknown.valid, false);
    assert.ok(unknown.errors.every((error) => error.code === 'MCP_CATALOG_UNAVAILABLE'));

    // The same reference against a catalog we did read is a different fact.
    const known = validator().validate({
      schemaVersion: 1,
      mcpServers: [{ serverId: 'probe', enabledTools: ['echo'] }],
    });
    assert.equal(known.valid, false);
    assert.ok(known.errors.some((error) => error.code === 'MCP_SERVER_UNAVAILABLE'));
  });

  it('offers only the reasoning efforts the routed adapter accepts', () => {
    const subject = validator();
    const flash = subject.options().platformConstraints.models
      .find((model) => model.modelId === 'deepseek-flash');
    const qwen = subject.options().platformConstraints.models
      .find((model) => model.modelId === 'qwen3.8-27b');
    assert.deepEqual(flash?.thinkingLevels, []);
    assert.deepEqual(qwen?.thinkingLevels, []);

    // 非推理模型一个 effort 都不该提供，也不能靠 `off` 蒙混过关。
    const rejected = subject.validate({
      schemaVersion: 1,
      modelPolicy: { modelId: 'deepseek-flash', thinkingLevel: 'off' },
    });
    assert.equal(rejected.valid, false);
    assert.equal(rejected.errors[0].code, 'MODEL_THINKING_LEVEL_UNSUPPORTED');
  });

  it('rejects a riskApproval value that is a risk level rather than a decision', () => {
    const result = validator().validate({
      schemaVersion: 1,
      toolPolicy: { riskApproval: { high: 'critical' }, classRiskLevels: { made_up: 'high' } },
    });
    assert.equal(result.valid, false);
    assert.deepEqual(
      result.errors.map((error) => `${error.path}:${error.code}`).sort(),
      [
        'toolPolicy.classRiskLevels.made_up:TOOL_RISK_CLASS_UNKNOWN',
        'toolPolicy.riskApproval.high:TOOL_DECISION_INVALID',
      ],
    );
  });
});

describe('AgentConfigValidator delegation (agent-delegation.md D2)', () => {
  it('accepts a delegation allowlist and round-trips it', () => {
    const subject = validator();
    const result = subject.validate({
      schemaVersion: 1,
      delegation: { agents: [' data-analyst ', '代码审查助手'] },
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.normalizedConfig.delegation, { agents: ['data-analyst', '代码审查助手'] });
    assert.deepEqual(result.effectiveSummary.delegation, { agents: ['data-analyst', '代码审查助手'], remoteAgents: [] });
    const again = subject.validate(result.normalizedConfig);
    assert.deepEqual(again.normalizedConfig, result.normalizedConfig);
  });

  it('omits an empty allowlist instead of saving a no-op key', () => {
    const result = validator().validate({ schemaVersion: 1, delegation: { agents: [] } });
    assert.equal(result.valid, true);
    assert.equal('delegation' in result.normalizedConfig, false);
    assert.deepEqual(result.effectiveSummary.delegation, { agents: [], remoteAgents: [] });
  });

  it('reports each malformed entry at its own path', () => {
    const result = validator().validate({
      schemaVersion: 1,
      delegation: { agents: ['ok', '', 7, 'ok'], remote: [] },
    });
    assert.equal(result.valid, false);
    assert.equal(result.normalizedConfig, undefined);
    const byPath = Object.fromEntries(result.errors.map((e) => [e.path, e.code]));
    assert.equal(byPath['delegation.agents[1]'], 'DELEGATION_AGENT_INVALID');
    assert.equal(byPath['delegation.agents[2]'], 'DELEGATION_AGENT_INVALID');
    assert.equal(byPath['delegation.agents[3]'], 'DELEGATION_AGENT_DUPLICATE');
    assert.equal(byPath['delegation.remote'], 'CONFIG_UNKNOWN_FIELD');
  });

  it('rejects a non-object delegation and advertises the field as supported', () => {
    const subject = validator();
    const result = subject.validate({ schemaVersion: 1, delegation: ['data-analyst'] });
    assert.deepEqual(result.errors.map((e) => [e.path, e.code]), [['delegation', 'CONFIG_TYPE']]);
    assert.equal(subject.options().fieldSupport.delegation.supported, true);
  });
});

describe('AgentConfigValidator delegation.remoteAgents (a2a-remote-delegation.md D3)', () => {
  const REMOTE = [{ id: 'finance-bot', name: '财务助手', description: '报销' }];

  it('accepts a registered remote agent and exposes only display fields', () => {
    const subject = validator({ remoteAgents: REMOTE });
    const result = subject.validate({ schemaVersion: 1, delegation: { remoteAgents: ['finance-bot'] } });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.normalizedConfig.delegation, { remoteAgents: ['finance-bot'] });
    const constraints = subject.options().platformConstraints;
    assert.deepEqual(constraints.remoteAgents, REMOTE);
    assert.equal(JSON.stringify(constraints).includes('cardUrl'), false);
  });

  it('rejects an unregistered remote agent at its path', () => {
    const result = validator({ remoteAgents: REMOTE }).validate({
      schemaVersion: 1,
      delegation: { remoteAgents: ['finance-bot', 'ghost'] },
    });
    assert.equal(result.valid, false);
    assert.deepEqual(
      result.errors.map((e) => [e.path, e.code]),
      [['delegation.remoteAgents[1]', 'DELEGATION_REMOTE_AGENT_UNKNOWN']],
    );
  });

  it('treats an empty registry as authoritative: nothing is callable', () => {
    const result = validator().validate({ schemaVersion: 1, delegation: { remoteAgents: ['finance-bot'] } });
    assert.equal(result.valid, false);
  });
});
