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
