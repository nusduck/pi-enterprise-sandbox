/**
 * 多 Agent 选择的前端契约：`/api/agents` 的解析与失败处理。
 *
 * 前端只认 agentId，不认 agentVersionId——这条设计约束
 * （`docs/design/multi-agent-selection.md` D1）在这里被钉住：列表里没有任何
 * 需要前端自行追踪"哪个版本活跃"的输入。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAgent,
  getAgentConfigOptions,
  listAgents,
  listAgentVersions,
  setAgentActiveVersion,
  validateAgentConfig,
} from '../src/shared/api/agents.ts';
import { ApiError } from '../src/shared/api/client.ts';
import { catalogFromResult } from '../src/pages/settings/AgentsPage.tsx';
import {
  activeVersionOf,
  jsonSemanticallyEqual,
  formatAgentConfig,
  isConfigDraftChanged,
  mcpEnabledToolsOf,
  mcpEntriesOf,
  parseAgentConfigDraft,
  setMcpEnabledTools,
  setMcpServerSelected,
  setModelPolicyField,
  setToolDecision,
  sortAgentsForDisplay,
  structuredEditorIssues,
  toolDecisionsOf,
} from '../src/pages/settings/agentHelpers.ts';

type Call = { url: string; init?: RequestInit };

function stubFetch(status: number, body: unknown): { calls: Call[]; restore: () => void } {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe('agent catalog api', () => {
  it('parses the agent list', async (t) => {
    const { calls, restore } = stubFetch(200, {
      agents: [
        {
          agent_id: '01J0000000000000000000000A',
          name: 'default',
          status: 'active',
          active_version_id: '01J0000000000000000000000V',
          active_version_no: 1,
        },
      ],
    });
    t.after(restore);

    const agents = await listAgents();
    assert.equal(calls[0]?.url, '/api/agents');
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.name, 'default');
    assert.equal(agents[0]?.active_version_no, 1);
  });

  it('sends the create body and returns the agent with its v1', async (t) => {
    const { calls, restore } = stubFetch(201, {
      agent: {
        agent_id: '01J0000000000000000000000B',
        name: '数据分析助手',
        status: 'active',
        active_version_id: '01J0000000000000000000000W',
        active_version_no: 1,
      },
      version: {
        agent_version_id: '01J0000000000000000000000W',
        agent_id: '01J0000000000000000000000B',
        version_no: 1,
        config: { systemPrompt: 'sql' },
      },
    });
    t.after(restore);

    const created = await createAgent({
      name: '数据分析助手',
      config: { systemPrompt: 'sql' },
    });
    assert.equal(calls[0]?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      name: '数据分析助手',
      config: { systemPrompt: 'sql' },
    });
    assert.equal(created.version.version_no, 1);
  });

  it('orders the version line newest first and keeps configs readable', async (t) => {
    const { restore } = stubFetch(200, {
      agent: { agent_id: 'A', name: 'x', status: 'active' },
      versions: [
        { agent_version_id: 'V2', agent_id: 'A', version_no: 2, config: { systemPrompt: 'v2' } },
        { agent_version_id: 'V1', agent_id: 'A', version_no: 1, config: { systemPrompt: 'v1' } },
      ],
    });
    t.after(restore);

    const { versions } = await listAgentVersions('A');
    assert.deepEqual(versions.map((v) => v.version_no), [2, 1]);
    assert.equal(versions[1]?.config?.systemPrompt, 'v1');
  });

  it('surfaces a cross-tenant 404 as an ApiError, not a parse crash', async (t) => {
    const { restore } = stubFetch(404, { error: 'Agent not found', code: 'NOT_FOUND' });
    t.after(restore);

    await assert.rejects(
      () => setAgentActiveVersion('FOREIGN', 'V1'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 404);
        assert.equal(err.code, 'NOT_FOUND');
        assert.equal(err.message, 'Agent not found');
        return true;
      },
    );
  });

  it('surfaces the admin gate as 403 so the UI can explain it', async (t) => {
    const { restore } = stubFetch(403, {
      error: 'Administrator role is required',
      code: 'ADMIN_REQUIRED',
    });
    t.after(restore);

    await assert.rejects(
      () => createAgent({ name: 'nope' }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.code, 'ADMIN_REQUIRED');
        return true;
      },
    );
  });

  it('parses the canonical config options DTO', async (t) => {
    const { calls, restore } = stubFetch(200, {
      schemaVersion: 1,
      fieldSupport: { systemPrompt: true, modelPolicy: true },
      platformConstraints: { maxOutputTokens: 4096 },
      capabilityRevision: 'cap-7',
    });
    t.after(restore);

    const options = await getAgentConfigOptions();
    assert.equal(calls[0]?.url, '/api/agents/config/options');
    assert.equal(options.schemaVersion, 1);
    assert.equal(options.capabilityRevision, 'cap-7');
  });

  it('rejects guessed snake_case config options instead of silently accepting a different DTO', async (t) => {
    const { restore } = stubFetch(200, {
      schema_version: 1,
      field_support: {},
      platform_constraints: {},
      capability_revision: 'cap-7',
    });
    t.after(restore);

    await assert.rejects(() => getAgentConfigOptions(), /agent config options/);
  });

  it('requires a non-empty capability revision in options and validation results', async (t) => {
    const invalidOptions = [null, ''];
    for (const capabilityRevision of invalidOptions) {
      const { restore } = stubFetch(200, {
        schemaVersion: 1,
        fieldSupport: {},
        platformConstraints: {},
        capabilityRevision,
      });
      t.after(restore);
      await assert.rejects(() => getAgentConfigOptions(), /agent config options/);
      restore();
    }

    for (const capabilityRevision of invalidOptions) {
      const { restore } = stubFetch(200, {
        valid: false,
        errors: [{ path: 'modelPolicy', code: 'INVALID', message: 'Invalid model' }],
        warnings: [],
        effectiveSummary: {},
        capabilityRevision,
      });
      t.after(restore);
      await assert.rejects(() => validateAgentConfig({ schemaVersion: 1 }), /agent config validation/);
      restore();
    }
  });

  it('requires a complete valid config validation result and sends the shared draft', async (t) => {
    const { calls, restore } = stubFetch(200, {
      valid: true,
      errors: [],
      warnings: [{ path: 'modelPolicy', code: 'INHERITED', message: 'Uses platform default' }],
      normalizedConfig: { schemaVersion: 1 },
      effectiveSummary: { model: 'platform-default', tools: [] },
      capabilityRevision: 'cap-7',
    });
    t.after(restore);

    const result = await validateAgentConfig(
      { schemaVersion: 1 },
      { agentId: 'A' },
    );
    assert.equal(calls[0]?.url, '/api/agents/config/validate');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      config: { schemaVersion: 1 },
      agent_id: 'A',
    });
    assert.equal(result.valid, true);
    assert.equal(result.warnings[0]?.code, 'INHERITED');
  });

  it('rejects a valid response that omits normalized/effective output or contains errors', async (t) => {
    const responses = [
      {
        valid: true,
        errors: [],
        warnings: [],
        effectiveSummary: {},
        capabilityRevision: 'cap-7',
      },
      {
        valid: true,
        errors: [{ path: 'modelPolicy', code: 'BAD', message: 'Invalid' }],
        warnings: [],
        normalizedConfig: {},
        effectiveSummary: {},
        capabilityRevision: 'cap-7',
      },
      {
        valid: true,
        errors: [],
        warnings: ['plain text warning'],
        normalizedConfig: {},
        effectiveSummary: {},
        capabilityRevision: 'cap-7',
      },
    ];
    for (const body of responses) {
      const { restore } = stubFetch(200, body);
      t.after(restore);
      await assert.rejects(() => validateAgentConfig({ schemaVersion: 1 }), /agent config validation/);
      restore();
    }
  });

  it('accepts an invalid validation result without normalized config', async (t) => {
    const { restore } = stubFetch(200, {
      valid: false,
      errors: [{ path: 'systemPrompt', code: 'BAD', message: 'Invalid' }],
      warnings: [],
      effectiveSummary: { model: 'unknown', tools: [] },
      capabilityRevision: 'cap-7',
    });
    t.after(restore);

    const result = await validateAgentConfig({ schemaVersion: 1 });
    assert.equal(result.valid, false);
    assert.equal(result.normalizedConfig, undefined);
    assert.equal(result.errors[0]?.code, 'BAD');
  });
});

describe('agents page helpers', () => {
  it('keeps a previously loaded catalog when a soft-fail reports HTTP 401/500', () => {
    const previous = {
      items: [{ id: 'known' }],
      available: true,
      loading: false,
      error: null,
    };
    for (const error of ['HTTP 401', 'HTTP 500']) {
      assert.deepEqual(
        catalogFromResult({ items: [], available: true, error }, previous),
        { ...previous, available: false, error },
      );
    }
  });

  it('treats empty config text as an empty object, not an error', () => {
    assert.deepEqual(parseAgentConfigDraft('   '), { ok: true, config: {} });
  });

  it('rejects arrays and scalars — AgentVersion config is an object', () => {
    for (const text of ['[1,2]', '"x"', '42', 'null']) {
      const parsed = parseAgentConfigDraft(text);
      assert.equal(parsed.ok, false, text);
    }
  });

  it('names the JSON error instead of failing silently', () => {
    const parsed = parseAgentConfigDraft('{');
    assert.equal(parsed.ok, false);
    assert.match((parsed as { error: string }).error, /valid JSON/);
  });

  it('does not call a reformat a change — otherwise every visit invites a no-op version', () => {
    const active = { systemPrompt: 'x', skills: [] };
    assert.equal(isConfigDraftChanged(formatAgentConfig(active), active), false);
    // 缩进与空白不算改动……
    assert.equal(isConfigDraftChanged('{"systemPrompt":"x","skills":[]}', active), false);
    // ……内容变了当然算。
    assert.equal(isConfigDraftChanged('{"systemPrompt":"y","skills":[]}', active), true);
    // 无法解析时按"改了"处理，让保存按钮可点、错误由解析器指出来。
    assert.equal(isConfigDraftChanged('{', active), true);
  });

  it('compares object semantics without treating key reordering as a version change', () => {
    assert.equal(
      jsonSemanticallyEqual(
        { schemaVersion: 1, modelPolicy: { modelId: 'm' }, mcpServers: ['a', 'b'] },
        { mcpServers: ['a', 'b'], modelPolicy: { modelId: 'm' }, schemaVersion: 1 },
      ),
      true,
    );
    assert.equal(jsonSemanticallyEqual({ tools: ['a', 'b'] }, { tools: ['b', 'a'] }), false);
    assert.equal(isConfigDraftChanged('{"b":2,"a":1}', { a: 1, b: 2 }), false);
  });

  it('keeps malformed legacy sections intact and pauses structured writes', () => {
    const malformed = {
      modelPolicy: ['legacy-model'],
      toolPolicy: { tools: ['legacy-tool'] },
      mcpServers: { legacy: true },
    };
    assert.deepEqual(structuredEditorIssues(malformed), [
      'modelPolicy must be an object',
      'toolPolicy.tools must be an object',
      'mcpServers must be an array',
    ]);
    assert.deepEqual(setModelPolicyField(malformed, 'modelId', 'new-model'), malformed);
    assert.deepEqual(setToolDecision(malformed, 'bash', 'deny'), malformed);
    assert.deepEqual(setMcpServerSelected(malformed, 'server', true), malformed);
    assert.deepEqual(setMcpEnabledTools(malformed, 'server', ['tool']), malformed);
  });

  it('projects nested and legacy flat tool decisions from the same draft', () => {
    const config = {
      toolPolicy: {
        tools: { bash: 'deny', todo_write: { decision: 'require_approval' } },
        read_file: 'allow',
      },
    };
    assert.deepEqual(toolDecisionsOf(config), {
      bash: 'deny',
      todo_write: 'require_approval',
      read_file: 'allow',
    });
    assert.deepEqual(
      toolDecisionsOf(setToolDecision(config, 'bash', 'inherit')),
      { todo_write: 'require_approval', read_file: 'allow' },
    );
  });

  it('uses explicit MCP server and bare enabled tool lists', () => {
    const config = { mcpServers: [{ serverId: 'github', enabledTools: ['issues', 'repos'] }] };
    assert.deepEqual(mcpEntriesOf(config)[0]?.enabledTools, ['issues', 'repos']);
    const withServer = setMcpServerSelected({}, 'github', true);
    assert.deepEqual(withServer, { mcpServers: [{ serverId: 'github', enabledTools: [] }] });
    const withTool = setMcpEnabledTools(withServer, 'github', ['repos', 'repos']);
    assert.deepEqual(mcpEnabledToolsOf(withTool, 'github'), ['repos']);
    assert.deepEqual(setMcpServerSelected(withTool, 'github', false), { mcpServers: [] });
  });

  it('resolves the active version and survives a dangling pointer', () => {
    const versions = [
      { agent_version_id: 'V2', agent_id: 'A', version_no: 2 },
      { agent_version_id: 'V1', agent_id: 'A', version_no: 1 },
    ];
    const agent = { agent_id: 'A', name: 'x', status: 'active', active_version_id: 'V2' };
    assert.equal(activeVersionOf(agent, versions)?.version_no, 2);
    assert.equal(activeVersionOf({ ...agent, active_version_id: 'GONE' }, versions), null);
    assert.equal(activeVersionOf(null, versions), null);
  });

  it('keeps the tenant default agent at the top of the list', () => {
    const rows = [
      { agent_id: '3', name: 'zeta', status: 'active' },
      { agent_id: '1', name: 'default', status: 'active' },
      { agent_id: '2', name: 'alpha', status: 'active' },
    ];
    assert.deepEqual(
      sortAgentsForDisplay(rows).map((a) => a.name),
      ['default', 'alpha', 'zeta'],
    );
  });
});

describe('optimistic activation and the config plane wire contract', () => {
  it('distinguishes "no expectation" from "expected no active version"', async (t) => {
    const omitted = stubFetch(200, { agent: { agent_id: 'A', name: 'x', status: 'active' }, version: { agent_version_id: 'V1', agent_id: 'A', version_no: 1 } });
    t.after(omitted.restore);
    await setAgentActiveVersion('A', 'V1');
    assert.deepEqual(JSON.parse(String(omitted.calls[0]?.init?.body)), {
      agent_version_id: 'V1',
    });

    const explicitNull = stubFetch(200, { agent: { agent_id: 'A', name: 'x', status: 'active' }, version: { agent_version_id: 'V1', agent_id: 'A', version_no: 1 } });
    t.after(explicitNull.restore);
    await setAgentActiveVersion('A', 'V1', null);
    assert.deepEqual(JSON.parse(String(explicitNull.calls[0]?.init?.body)), {
      agent_version_id: 'V1',
      expected_active_version_id: null,
    });
  });

  it('carries the server 409 pointer so the UI can show the difference', async (t) => {
    const { restore } = stubFetch(409, {
      error: 'Active version changed since it was read',
      code: 'ACTIVE_VERSION_CONFLICT',
      active_version_id: 'V2',
    });
    t.after(restore);

    await assert.rejects(
      () => setAgentActiveVersion('A', 'V1', 'V1'),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, 'ACTIVE_VERSION_CONFLICT');
        assert.equal(
          (err.detail as { active_version_id?: string } | undefined)?.active_version_id,
          'V2',
        );
        return true;
      },
    );
  });

  it('rejects a self-contradicting validation response instead of enabling save', async (t) => {
    // valid=true with no normalizedConfig would let the UI publish something
    // the server never normalized.
    const missing = stubFetch(200, {
      valid: true,
      errors: [],
      warnings: [],
      effectiveSummary: {},
      capabilityRevision: 'r1',
    });
    t.after(missing.restore);
    await assert.rejects(() => validateAgentConfig({ schemaVersion: 1 }));

    // And valid=false must not carry one either.
    const extra = stubFetch(200, {
      valid: false,
      errors: [{ path: 'modelPolicy.modelId', code: 'MODEL_NOT_FOUND', message: 'no' }],
      warnings: [],
      normalizedConfig: { schemaVersion: 1 },
      effectiveSummary: {},
      capabilityRevision: 'r1',
    });
    t.after(extra.restore);
    await assert.rejects(() => validateAgentConfig({ schemaVersion: 1 }));
  });

  it('sends agent_id only when one is supplied, and posts to the config plane', async (t) => {
    const { calls, restore } = stubFetch(200, {
      valid: false,
      errors: [{ path: 'mcpServers[0].enabledTools[1]', code: 'MCP_TOOL_UNAVAILABLE', message: 'gone' }],
      warnings: [],
      effectiveSummary: {},
      capabilityRevision: 'r1',
    });
    t.after(restore);

    const result = await validateAgentConfig({ schemaVersion: 1 }, { agentId: 'A' });
    assert.match(String(calls[0]?.url), /\/api\/agents\/config\/validate$/);
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      config: { schemaVersion: 1 },
      agent_id: 'A',
    });
    // The path is what anchors the error to a checkbox row in the editor.
    assert.equal(result.errors[0]?.path, 'mcpServers[0].enabledTools[1]');
  });
});
