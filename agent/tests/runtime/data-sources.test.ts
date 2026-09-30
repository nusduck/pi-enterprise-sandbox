/**
 * 数据源（docs/design/sandbox-data-sources.md）在 Agent 一侧的三道：
 * 1. `configJson.dataSources` 的解析——保存与 Run 启动共用，fail-closed；
 * 2. 配置面校验器：目录里没有的 id 报 DATA_SOURCE_UNKNOWN，目录进 options；
 * 3. Run 期：清单只随 shell run/start 的请求体下发给 exec，并进 body_sha256。
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';

import { parseDataSourceConfig, unknownDataSources } from '../../src/domain/agent/data-source-config.js';
import { bindAgentVersionConfig } from '../../src/infrastructure/dsh/agent-version-bindings.js';
import { buildExecRpcConfig } from '../../src/infrastructure/dsh/runtime-factory.js';
import { AgentConfigValidator } from '../../src/application/agent-config-validator.js';
import { ExecRpcClient } from '../../src/runtime/providers/exec-rpc.js';

const CATALOG_JSON = JSON.stringify([
  { id: 'employees', label: '员工库', description: 'HR', endpoint: 'db:3306', database: 'hr', dbpmDbName: 'hr', userName: 'reader' },
]);

describe('parseDataSourceConfig', () => {
  it('absent or empty means no data sources', () => {
    assert.deepEqual(parseDataSourceConfig(undefined), { ids: [], errors: [] });
    assert.deepEqual(parseDataSourceConfig([]), { ids: [], errors: [] });
  });

  it('keeps ids in order', () => {
    assert.deepEqual(parseDataSourceConfig([{ id: 'employees' }, { id: 'sales' }]).ids, ['employees', 'sales']);
  });

  it('rejects connection material, bad ids and duplicates with a path', () => {
    const cases: [unknown, string, string][] = [
      [{ id: 'employees' }, 'dataSources', 'CONFIG_TYPE'],
      [[{ id: 'employees', password: 'x' }], 'dataSources[0].password', 'CONFIG_UNKNOWN_FIELD'],
      [[{ id: 'employees', endpoint: 'db:3306' }], 'dataSources[0].endpoint', 'CONFIG_UNKNOWN_FIELD'],
      [['employees'], 'dataSources[0]', 'CONFIG_TYPE'],
      [[{ id: 'Employees' }], 'dataSources[0].id', 'CONFIG_TYPE'],
      [[{ id: 'a' }, { id: 'a' }], 'dataSources[1].id', 'CONFIG_DUPLICATE'],
    ];
    for (const [raw, path, code] of cases) {
      const parsed = parseDataSourceConfig(raw);
      assert.equal(parsed.ids, null, JSON.stringify(raw));
      assert.ok(parsed.errors.some((e) => e.path === path && e.code === code), `${JSON.stringify(raw)} → ${JSON.stringify(parsed.errors)}`);
    }
  });

  it('names ids that are not in the catalog', () => {
    assert.deepEqual(unknownDataSources(['employees', 'sales'], [{ id: 'employees' }]).map((e) => [e.path, e.code]), [
      ['dataSources[1].id', 'DATA_SOURCE_UNKNOWN'],
    ]);
  });
});

describe('bindAgentVersionConfig dataSources', () => {
  it('projects the list; absent means none', () => {
    const bound = bindAgentVersionConfig({ agentVersionId: 'v1', configJson: { dataSources: [{ id: 'employees' }] } });
    assert.deepEqual([...bound.dataSources], ['employees']);
    assert.deepEqual([...bindAgentVersionConfig({ agentVersionId: 'v2', configJson: {} }).dataSources], []);
  });

  it('refuses a malformed list instead of running with part of it', () => {
    assert.throws(
      () => bindAgentVersionConfig({ agentVersionId: 'v1', configJson: { dataSources: [{ id: 'ok' }, { id: 'ok', pwd: 'x' }] } }),
      (err: { code?: string }) => err.code === 'DSH_DATA_SOURCES_INVALID',
    );
  });
});

describe('AgentConfigValidator dataSources', () => {
  const validator = new AgentConfigValidator({
    env: { SANDBOX_DATA_SOURCES_JSON: CATALOG_JSON },
    mcpServers: [],
    remoteAgents: [],
  });
  const base = { schemaVersion: 1, systemPrompt: '', modelPolicy: {}, toolPolicy: {}, mcpServers: [] };

  it('lists the catalog projection in options without connection details', () => {
    const options = validator.options() as unknown as { platformConstraints: { dataSources: unknown[] } };
    assert.deepEqual(options.platformConstraints.dataSources, [
      { id: 'employees', label: '员工库', description: 'HR', engine: 'mysql' },
    ]);
    assert.equal(JSON.stringify(options).includes('db:3306'), false);
    assert.equal(JSON.stringify(options).includes('reader'), false);
  });

  it('accepts a registered id and normalizes it', () => {
    const result = validator.validate({ ...base, dataSources: [{ id: 'employees' }] });
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.deepEqual(result.normalizedConfig?.dataSources, [{ id: 'employees' }]);
  });

  it('rejects an id that is not in the catalog', () => {
    const result = validator.validate({ ...base, dataSources: [{ id: 'sales' }] });
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((e) => [e.path, e.code]), [['dataSources[0].id', 'DATA_SOURCE_UNKNOWN']]);
  });

  it('refuses to start with an unreadable catalog', () => {
    assert.throws(
      () => new AgentConfigValidator({ env: { SANDBOX_DATA_SOURCES_JSON: '[{"id":"x","password":"p"}]' }, mcpServers: [], remoteAgents: [] }),
      /must not embed credentials/,
    );
  });
});

describe('exec RPC carries the list only on shell spawns', () => {
  const env = {
    SANDBOX_INTERNAL_HMAC_KEYRING: JSON.stringify({ k1: Buffer.from('0'.repeat(32)).toString('base64url') }),
    SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'k1',
  };
  const input = { context: { orgId: 'org-1', userId: 'user-1', workspaceId: 'ws-1', runId: 'run-1', executionFenceToken: 3 }, cwd: '/ws' };

  it('buildExecRpcConfig takes the list from the bound version', () => {
    assert.deepEqual(buildExecRpcConfig(input, env, ['employees']).dataSources, ['employees']);
    assert.equal('dataSources' in buildExecRpcConfig(input, env), false);
  });

  it('shell/run and shell/start bodies include it (covered by body_sha256); fs does not', async () => {
    const bodies = new Map<string, { body: Record<string, unknown>; sha: string; auth: string }>();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const text = String(init.body);
      bodies.set(new URL(url).pathname, {
        body: JSON.parse(text) as Record<string, unknown>,
        sha: createHash('sha256').update(text).digest('hex'),
        auth: String((init.headers as Record<string, string>).authorization ?? ''),
      });
      return new Response(JSON.stringify({ ok: true, data: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new ExecRpcClient({ ...buildExecRpcConfig(input, env, ['employees']), fetchImpl });
    for (const htu of ['/internal/v1/shell/run', '/internal/v1/shell/start', '/internal/v1/fs/stat']) {
      await client.post(htu, { command: 'x' }, []);
    }
    assert.deepEqual(bodies.get('/internal/v1/shell/run')?.body.dataSources, ['employees']);
    assert.deepEqual(bodies.get('/internal/v1/shell/start')?.body.dataSources, ['employees']);
    assert.equal('dataSources' in (bodies.get('/internal/v1/fs/stat')?.body ?? {}), false);
    const run = bodies.get('/internal/v1/shell/run')!;
    const payload = JSON.parse(Buffer.from(run.auth.replace(/^Bearer /, '').split('.')[1]!, 'base64url').toString());
    assert.equal(payload.body_sha256, run.sha);
  });
});

describe('AgentConfigValidator 的 org 层是每调用维度，不是实例状态（跨租户）', () => {
  const DIGEST = 'a'.repeat(64);

  /**
   * 复现过的缺陷形状：`AgentConfigValidator` 由 `createHttpServices()` 在**启动时建一次**
   * 并复用，所以任何 org 维度的数据都不能存成它的实例字段。第一版把 org 层存进实例，
   * 两个 org 的并发请求会在 `await` 之间互相覆盖——A 的 `options()` 读到 B 的 org 技能
   * 列表，那是跨租户泄漏。
   *
   * 这条测试用**同一个实例**依次按两个 org 投影，第二次必须只看到自己的。
   */
  it('同一个校验器实例按 org 分别投影，不残留上一次的 org 层', async () => {
    const validator = new AgentConfigValidator({ env: {}, mcpServers: [], remoteAgents: [] });
    await validator.refreshSkills();

    const orgA = [{ name: 'a-weekly', contentDigest: DIGEST, status: 'active' as const }];
    const orgB = [{ name: 'b-weekly', contentDigest: DIGEST, status: 'active' as const }];

    const first = validator.options(orgA) as unknown as {
      platformConstraints: { skills: { org: Array<{ name: string }> } };
    };
    assert.deepEqual(first.platformConstraints.skills.org.map((o) => o.name), ['a-weekly']);

    // 同一个实例、另一个 org：绝不能还带着 A。
    const second = validator.options(orgB) as unknown as {
      platformConstraints: { skills: { org: Array<{ name: string }> } };
    };
    assert.deepEqual(second.platformConstraints.skills.org.map((o) => o.name), ['b-weekly']);

    // 不传 org 时是**空**，不是「上一次那个」。
    const none = validator.options() as unknown as {
      platformConstraints: { skills: { org: unknown[] } };
    };
    assert.deepEqual(none.platformConstraints.skills.org, []);
  });

  it('capabilityRevision 按本次的 org 层计算（它描述调用者此刻看到的能力集）', () => {
    const validator = new AgentConfigValidator({ env: {}, mcpServers: [], remoteAgents: [] });
    const a = validator.options([{ name: 'a', contentDigest: DIGEST, status: 'active' }]);
    const b = validator.options([{ name: 'b', contentDigest: DIGEST, status: 'active' }]);
    assert.notEqual(a.capabilityRevision, b.capabilityRevision);
  });
});
