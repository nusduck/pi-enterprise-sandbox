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
  listAgents,
  listAgentVersions,
  setAgentActiveVersion,
} from '../src/shared/api/agents.ts';
import { ApiError } from '../src/shared/api/client.ts';
import {
  activeVersionOf,
  formatAgentConfig,
  isConfigDraftChanged,
  parseAgentConfigDraft,
  sortAgentsForDisplay,
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
});

describe('agents page helpers', () => {
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
