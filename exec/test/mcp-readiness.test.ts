/**
 * MCP facade 就绪探针（design §9.2）：`/health` 只看进程活性，`/ready` 要求服务
 * Redis PING 与执行面 `/ready` 都在超时内成功；探针请求不携带桥 token。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SandboxBridgeClient } from '../src/mcp/bridge-client.js';
import { ContextStore, type RedisLike } from '../src/mcp/context-store.js';
import { McpFacadeService } from '../src/mcp/service.js';
import { loadMcpSettings } from '../src/mcp/settings.js';
import { createMcpApp } from '../src/mcp/server.js';

const settings = loadMcpSettings({
  SANDBOX_MCP_TOKEN: 'outer-token',
  SANDBOX_MCP_INTERNAL_TOKEN: 'inner-token',
  SANDBOX_MCP_DOWNLOAD_SECRET: 'download-secret',
  SANDBOX_MCP_REDIS_URL: 'redis://unit-test',
  SANDBOX_MCP_PUBLIC_BASE_URL: 'https://mcp.example.test',
  SANDBOX_MCP_SANDBOX_BASE_URL: 'http://sandbox.test:8081',
});

function fakeRedis(ping: () => Promise<string>): RedisLike {
  return {
    ping,
    hgetall: async () => ({}),
    hset: async () => 1,
    expire: async () => 1,
    set: async () => 'OK',
    get: async () => null,
    eval: async () => 1,
    quit: async () => 'OK',
  };
}

interface Seen {
  url: string;
  authorization: string | null;
}

function build(opts: {
  ping?: () => Promise<string>;
  sandbox?: (seen: Seen) => Promise<Response>;
}) {
  const seen: Seen[] = [];
  const bridge = new SandboxBridgeClient(settings, async (input, init) => {
    const entry = {
      url: typeof input === 'string' ? input : String(input),
      authorization: new Headers(init?.headers).get('authorization'),
    };
    seen.push(entry);
    return (opts.sandbox ?? (async () => new Response('{"status":"ok"}', { status: 200 })))(entry);
  });
  const store = new ContextStore(settings, fakeRedis(opts.ping ?? (async () => 'PONG')));
  const service = new McpFacadeService(settings, store, bridge);
  return { service, app: createMcpApp(settings, service), seen };
}

describe('mcp: readiness probe', () => {
  test('Redis 与执行面都可达才 200，且探针不带桥 token', async () => {
    const { service, app, seen } = build({});
    await service.start();
    const res = await app.request('/ready');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      status: 'ready',
      service: 'sandbox-mcp',
      redis: 'ok',
      sandbox: 'ok',
    });
    assert.equal(seen.length, 1);
    assert.equal(new URL(seen[0]!.url).pathname, '/ready');
    assert.equal(seen[0]!.authorization, null);
  });

  test('任一依赖失败或超时即 503，响应不含错误详情；liveness 不受影响', async () => {
    const cases: Array<[string, Parameters<typeof build>[0], Record<string, string>]> = [
      ['redis 抛错', { ping: async () => { throw new Error('redis://:secret@host'); } }, { redis: 'unavailable', sandbox: 'ok' }],
      ['redis 挂起', { ping: () => new Promise<string>(() => {}) }, { redis: 'unavailable', sandbox: 'ok' }],
      ['执行面 503', { sandbox: async () => new Response('{}', { status: 503 }) }, { redis: 'ok', sandbox: 'unavailable' }],
      ['执行面不可达', { sandbox: async () => { throw new TypeError('fetch failed secret'); } }, { redis: 'ok', sandbox: 'unavailable' }],
    ];
    for (const [name, opts, expected] of cases) {
      const { service, app } = build(opts);
      await service.start();
      const started = Date.now();
      const readiness = await service.readiness(50);
      assert.ok(Date.now() - started < 1000, name);
      assert.equal(readiness.ready, false, name);

      const res = await app.request('/ready');
      assert.equal(res.status, 503, name);
      const text = await res.text();
      assert.doesNotMatch(text, /secret/, name);
      assert.deepEqual(JSON.parse(text), { status: 'not_ready', service: 'sandbox-mcp', ...expected }, name);

      assert.equal((await app.request('/health')).status, 200, name);
    }
  });

  test('未启动或关停后不就绪，也不再访问依赖', async () => {
    const { service, app, seen } = build({});
    assert.equal((await app.request('/ready')).status, 503);
    assert.equal(seen.length, 0);

    await service.start();
    assert.equal((await app.request('/ready')).status, 200);
    await service.close();
    const res = await app.request('/ready');
    assert.equal(res.status, 503);
    assert.equal(seen.length, 1);
  });
});
