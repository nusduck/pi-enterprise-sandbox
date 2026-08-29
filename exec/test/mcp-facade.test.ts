/**
 * MCP facade 单测——移植自 `tests/test_mcp_facade_service.py`、
 * `tests/test_mcp_sandbox_client_errors.py`、`tests/test_mcp_streamable_http.py`
 * 三份 Python 用例，覆盖一条不减。
 *
 * 三块重点：
 *   1. 桥错误映射表是**封闭**的——上游异常文本永不透出给模型/客户端
 *   2. 同一个 context_id 只开通一次（分布式锁 + 复读）
 *   3. 下载 URL 的签名绑 artifact_id 且会过期
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SandboxBridgeClient, safeBridgeError } from '../src/mcp/bridge-client.js';
import { ContextStore, type RedisLike } from '../src/mcp/context-store.js';
import { McpFacadeService } from '../src/mcp/service.js';
import { loadMcpSettings, validateRuntime, type McpSettings } from '../src/mcp/settings.js';
import { createMcpApp, transportSecurity } from '../src/mcp/server.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('mcp: bridge error mapping stays closed', () => {
  test('FILE_NOT_FOUND 的文案要教会模型复用 context_id 与相对 source_path', async () => {
    const err = await safeBridgeError(
      response(404, { detail: { code: 'FILE_NOT_FOUND', message: 'file not found' } }),
    );
    assert.equal(err.code, 'FILE_NOT_FOUND');
    assert.match(err.message, /context_id/);
    assert.match(err.message, /source_path/);
  });

  test('TOO_LARGE', async () => {
    const err = await safeBridgeError(
      response(413, { detail: { code: 'TOO_LARGE', message: 'file exceeds max size' } }),
    );
    assert.equal(err.code, 'TOO_LARGE');
    assert.match(err.message, /max size/);
  });

  test('未知码：保留码，但绝不转发上游文本（那里可能是物理路径）', async () => {
    const err = await safeBridgeError(
      response(500, { detail: { code: 'OPEN_FAILED', message: '/var/sandbox/secret/path' } }),
    );
    assert.equal(err.code, 'OPEN_FAILED');
    assert.ok(!err.message.includes('/var/sandbox'));
    assert.equal(err.message, 'Sandbox rejected the request');
  });

  test('503 → UNAVAILABLE', async () => {
    const err = await safeBridgeError(response(503, { detail: 'down' }));
    assert.equal(err.code, 'UNAVAILABLE');
    assert.match(err.message, /temporarily unavailable/);
  });

  test('post 把 404 映射成 FILE_NOT_FOUND 而不是抛原始 HTTP 错误', async () => {
    const settings = testSettings();
    const client = new SandboxBridgeClient(settings, async () =>
      response(404, { detail: { code: 'FILE_NOT_FOUND', message: 'nope' } }),
    );
    client.start();
    await assert.rejects(() => client.post('/internal/mcp/v1/files/read', {}), (err: unknown) => {
      assert.match((err as Error).message, /context_id/);
      return true;
    });
  });
});

/** 够用的 Redis 替身：只实现 ContextStore 用到的那几个方法。 */
class FakeRedis implements RedisLike {
  readonly hashes = new Map<string, Record<string, string>>();
  readonly strings = new Map<string, string>();

  async ping(): Promise<string> {
    return 'PONG';
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return this.hashes.get(key) ?? {};
  }
  async hset(key: string, value: Record<string, string>): Promise<number> {
    this.hashes.set(key, { ...(this.hashes.get(key) ?? {}), ...value });
    return 1;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async set(key: string, value: string, _m: 'EX', _s: number, condition?: 'NX'): Promise<string | null> {
    if (condition === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async eval(_script: string, _n: number, key: string): Promise<unknown> {
    this.strings.delete(key);
    return 1;
  }
  async quit(): Promise<unknown> {
    return 'OK';
  }
}

function testSettings(overrides: Partial<McpSettings> = {}): McpSettings {
  return {
    ...loadMcpSettings({
      SANDBOX_MCP_TOKEN: 'outer-token',
      SANDBOX_MCP_INTERNAL_TOKEN: 'inner-token',
      SANDBOX_MCP_DOWNLOAD_SECRET: 'download-secret',
      SANDBOX_MCP_REDIS_URL: 'redis://unit-test',
      SANDBOX_MCP_PUBLIC_BASE_URL: 'https://mcp.example.test',
    }),
    ...overrides,
  };
}

function fakeBridge(calls: string[]): SandboxBridgeClient {
  const settings = testSettings();
  const client = new SandboxBridgeClient(settings, async (input) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push(new URL(url).pathname);
    return response(200, { size: 3, sha256: 'abc' });
  });
  client.start();
  return client;
}

describe('mcp: facade service', () => {
  test('同一个 context_id 只开通一次；下载 URL 绑 artifact_id 且可验签', async () => {
    const settings = testSettings();
    const calls: string[] = [];
    const store = new ContextStore(settings, new FakeRedis());
    const service = new McpFacadeService(settings, store, fakeBridge(calls));
    await service.start();

    const first = await service.executePython({ contextId: 'turn-42', code: "print('ok')" });
    const second = await service.executePython({ contextId: 'turn-42', code: "print('again')" });
    assert.equal(first['context_id'], 'turn-42');
    assert.equal(second['context_id'], 'turn-42');
    assert.equal(
      calls.filter((p) => p === '/internal/mcp/v1/context/ensure').length,
      1,
      'context/ensure 只该被调一次',
    );

    const artifact = await service.artifactSubmit({
      contextId: 'turn-42',
      sourcePath: 'out.csv',
      name: 'out.csv',
      mimeType: 'text/csv',
    });
    const url = String(artifact['download_url']);
    assert.ok(url.startsWith('https://mcp.example.test/artifacts/'));

    const token = url.split('token=')[1] as string;
    const artifactId = String(artifact['artifact_id']);
    assert.equal(service.verifyArtifactToken(artifactId, decodeURIComponent(token)), true);
    // 签名绑 id：拿同一个 token 去换别的产物必须失败。
    assert.equal(service.verifyArtifactToken('A'.repeat(26), decodeURIComponent(token)), false);

    const metadata = await service.getArtifact(artifactId, decodeURIComponent(token));
    assert.equal(metadata?.['name'], 'out.csv');
    assert.equal(metadata?.['mime_type'], 'text/csv');
    assert.equal(metadata?.['size'], 3);
    assert.equal(metadata?.['sha256'], 'abc');
    assert.equal(metadata?.['context_id'], 'turn-42');
    await service.close();
  });

  test('过期的签名验不过', async () => {
    const settings = testSettings({ artifactTtlSeconds: 1 });
    const service = new McpFacadeService(
      settings,
      new ContextStore(settings, new FakeRedis()),
      fakeBridge([]),
    );
    await service.start();
    const artifact = await service.artifactSubmit({ contextId: 'c1', sourcePath: 'a.txt' });
    const token = decodeURIComponent(String(artifact['download_url']).split('token=')[1] as string);
    assert.equal(service.verifyArtifactToken(String(artifact['artifact_id']), token), true);
    // 把时钟推过 TTL。
    const realNow = Date.now;
    Date.now = () => realNow() + 5_000;
    try {
      assert.equal(service.verifyArtifactToken(String(artifact['artifact_id']), token), false);
    } finally {
      Date.now = realNow;
    }
    await service.close();
  });

  test('上限在发桥之前判定：超长命令不消耗执行面时间', async () => {
    const settings = testSettings({ maxCommandLength: 8 });
    const calls: string[] = [];
    const service = new McpFacadeService(
      settings,
      new ContextStore(settings, new FakeRedis()),
      fakeBridge(calls),
    );
    await service.start();
    await assert.rejects(
      () => service.executeShell({ contextId: 'c1', command: 'x'.repeat(100) }),
      /size limit/,
    );
    assert.deepEqual(calls, [], '超限时不该发出任何桥调用');
    await service.close();
  });

  test('非法 context_id 被拒', async () => {
    const settings = testSettings();
    const service = new McpFacadeService(
      settings,
      new ContextStore(settings, new FakeRedis()),
      fakeBridge([]),
    );
    await service.start();
    await assert.rejects(
      () => service.executePython({ contextId: '../escape', code: 'x' }),
      /Invalid context_id/,
    );
    await service.close();
  });
});

describe('mcp: settings and transport', () => {
  test('四个必需密钥缺一即 fail-closed', () => {
    for (const missing of [
      'SANDBOX_MCP_TOKEN',
      'SANDBOX_MCP_INTERNAL_TOKEN',
      'SANDBOX_MCP_DOWNLOAD_SECRET',
      'SANDBOX_MCP_REDIS_URL',
    ]) {
      const env: Record<string, string> = {
        SANDBOX_MCP_TOKEN: 'a',
        SANDBOX_MCP_INTERNAL_TOKEN: 'b',
        SANDBOX_MCP_DOWNLOAD_SECRET: 'c',
        SANDBOX_MCP_REDIS_URL: 'd',
      };
      delete env[missing];
      assert.throws(() => validateRuntime(loadMcpSettings(env)), /not configured/, missing);
    }
  });

  test('正整数字段给了非法值就抛，不静默取默认值', () => {
    assert.throws(
      () => loadMcpSettings({ SANDBOX_MCP_MAX_TIMEOUT_SECONDS: '0' }),
      /positive integer/,
    );
    // 未给时取默认值是允许的。
    assert.equal(loadMcpSettings({}).maxTimeoutSeconds, 300);
  });

  test('DNS 重绑定允许列表含本机与配置的公开地址', () => {
    const sec = transportSecurity('https://mcp.example.test');
    assert.ok(sec.allowedHosts.includes('mcp.example.test'));
    assert.ok(sec.allowedOrigins.includes('https://mcp.example.test'));
    assert.ok(sec.allowedHosts.includes('127.0.0.1'));
    // 配错时只保留本机项，不抛。
    assert.ok(!transportSecurity('not-a-url').allowedHosts.includes('not-a-url'));
  });
});

describe('mcp: http app', () => {
  function app() {
    const settings = testSettings();
    const service = new McpFacadeService(
      settings,
      new ContextStore(settings, new FakeRedis()),
      fakeBridge([]),
    );
    return createMcpApp(settings, service);
  }

  test('/health 不需要鉴权', async () => {
    const res = await app().request('/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok', service: 'sandbox-mcp' });
  });

  test('服务根回 404 并指路到 /mcp（运维常指错）', async () => {
    const res = await app().request('/');
    assert.equal(res.status, 404);
    const body = (await res.json()) as { mcp: string };
    assert.equal(body.mcp, '/mcp');
  });

  test('/mcp 缺 bearer → 401', async () => {
    const res = await app().request('/mcp', { method: 'POST', body: '{}' });
    assert.equal(res.status, 401);
  });

  test('/mcp 带正确 bearer 不再是鉴权失败', async () => {
    const res = await app().request('/mcp', {
      method: 'POST',
      headers: {
        authorization: 'Bearer outer-token',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1' },
        },
      }),
    });
    assert.notEqual(res.status, 401);
    assert.notEqual(res.status, 503);
  });

  test('token 未配置时 /mcp 回 503，而不是拿空串比对', async () => {
    const settings = testSettings({ token: '' });
    const service = new McpFacadeService(
      settings,
      new ContextStore(settings, new FakeRedis()),
      fakeBridge([]),
    );
    const res = await createMcpApp(settings, service).request('/mcp', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 503);
  });
});
