/**
 * MCP facade hardening（A1 配置项 + A3/A4 错误表 + B1–B3 facade 侧）。
 *
 * 桥用可注入的 fetch 桩，不起真实执行面；工具注册走 SDK 的
 * InMemoryTransport 真查一遍工具名与 schema。
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SandboxBridgeClient, safeBridgeError } from '../src/mcp/bridge-client.js';
import { ContextStore, type RedisLike } from '../src/mcp/context-store.js';
import { McpFacadeService } from '../src/mcp/service.js';
import { loadMcpSettings, type McpSettings } from '../src/mcp/settings.js';
import { registerMcpTools } from '../src/mcp/tools.js';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

interface CapturedCall {
  pathname: string;
  body: Record<string, unknown>;
}

/** 记录每次桥调用的路径与请求体，原样回 200。 */
function capturingBridge(
  settings: McpSettings,
  calls: CapturedCall[],
  reply: Record<string, unknown> = { ok: true },
): SandboxBridgeClient {
  const client = new SandboxBridgeClient(settings, (async (input: unknown, init?: unknown) => {
    const url = typeof input === 'string' ? input : String(input);
    const raw = (init as { body?: unknown } | undefined)?.body;
    calls.push({
      pathname: new URL(url).pathname,
      body: JSON.parse(String(raw)) as Record<string, unknown>,
    });
    return response(200, reply);
  }) as typeof fetch);
  client.start();
  return client;
}

function serviceWith(
  settings: McpSettings,
  calls: CapturedCall[],
  reply: Record<string, unknown> = { ok: true },
): McpFacadeService {
  const service = new McpFacadeService(
    settings,
    new ContextStore(settings, new FakeRedis()),
    capturingBridge(settings, calls, reply),
  );
  return service;
}

describe('mcp facade hardening: settings', () => {
  test('SANDBOX_MCP_MAX_READ_BYTES 默认 256 KiB，显式值与非法值', () => {
    assert.equal(loadMcpSettings({}).maxReadBytes, 256 * 1024);
    assert.equal(loadMcpSettings({ SANDBOX_MCP_MAX_READ_BYTES: '524288' }).maxReadBytes, 524288);
    assert.throws(() => loadMcpSettings({ SANDBOX_MCP_MAX_READ_BYTES: '0' }), /positive integer/);
    assert.throws(() => loadMcpSettings({ SANDBOX_MCP_MAX_READ_BYTES: 'abc' }), /positive integer/);
  });
});

describe('mcp facade hardening: bridge error table', () => {
  test('PATH_NOT_FOUND 指引模型用相对路径与相同的 context_id', async () => {
    const err = await safeBridgeError(
      response(404, { detail: { code: 'PATH_NOT_FOUND', message: 'path not found' } }),
    );
    assert.equal(err.code, 'PATH_NOT_FOUND');
    assert.match(err.message, /not found/i);
    assert.match(err.message, /relative path/);
    assert.match(err.message, /context_id/);
  });

  test('FILE_NOT_FOUND 仍是 artifact submit 专用文案（保持不变）', async () => {
    const err = await safeBridgeError(
      response(404, { detail: { code: 'FILE_NOT_FOUND', message: 'file not found' } }),
    );
    assert.equal(err.code, 'FILE_NOT_FOUND');
    assert.match(err.message, /artifact submit/);
  });

  test('BINARY_FILE 提示用 sandbox_artifact_submit 交付或用 python 处理', async () => {
    const err = await safeBridgeError(
      response(400, { detail: { code: 'BINARY_FILE', message: 'binary' } }),
    );
    assert.equal(err.code, 'BINARY_FILE');
    assert.match(err.message, /sandbox_artifact_submit/);
  });

  test('PATH_INVALID 文案通用（删除/搜索/读写都会用到），不再写成 artifact 专用', async () => {
    const err = await safeBridgeError(response(400, { detail: { code: 'PATH_INVALID', message: 'x' } }));
    assert.equal(err.code, 'PATH_INVALID');
    assert.doesNotMatch(err.message, /artifact/i);
    assert.match(err.message, /relative path/);
  });

  test('IS_DIRECTORY 提示删除目录要 recursive=true', async () => {
    const err = await safeBridgeError(response(400, { detail: { code: 'IS_DIRECTORY', message: 'x' } }));
    assert.match(err.message, /recursive=true/);
  });

  test('INVALID_INPUT 精确文案：NUL 字节', async () => {
    const err = await safeBridgeError(
      response(400, { detail: { code: 'INVALID_INPUT', message: 'nul' } }),
    );
    assert.equal(err.code, 'INVALID_INPUT');
    assert.equal(err.message, 'Invalid request: input contains NUL bytes');
  });

  test('新工具的拒绝码保留码且有可执行文案：IS_DIRECTORY / FILE_EXISTS / INVALID_BASE64', async () => {
    for (const code of ['IS_DIRECTORY', 'FILE_EXISTS', 'INVALID_BASE64']) {
      const err = await safeBridgeError(response(400, { detail: { code, message: 'x' } }));
      assert.equal(err.code, code, code);
      assert.notEqual(err.message, 'Sandbox rejected the request', `${code} 应有专用文案`);
    }
  });
});

describe('mcp facade hardening: new tools (service)', () => {
  // 注意：每次调用先经过 context/ensure（同样走 bridge.post），所以按路径找工具调用。
  const toolCalls = (calls: CapturedCall[], pathname: string): CapturedCall[] =>
    calls.filter((call) => call.pathname === pathname);

  test('fileDelete 发到 /files/delete 并回显 context_id', async () => {
    const settings = testSettings();
    const calls: CapturedCall[] = [];
    const service = serviceWith(settings, calls, { path: 'a.txt', deleted: true });
    await service.start();
    try {
      const out = await service.fileDelete({ contextId: 'ctx-1', path: 'a.txt', recursive: true });
      assert.equal(out['context_id'], 'ctx-1');
      assert.equal(out['path'], 'a.txt');
      const tool = toolCalls(calls, '/internal/mcp/v1/files/delete');
      assert.equal(tool.length, 1);
      assert.equal(tool[0]?.body['path'], 'a.txt');
      assert.equal(tool[0]?.body['recursive'], true);
    } finally {
      await service.close();
    }
  });

  test('fileUpload: base64 粗判按 4/3 比例在发桥前拒绝超限（桥不被调用）', async () => {
    // 30 字节上限：30 字节原文（b64 长 40）通过，31 字节（b64 长 44）拒绝。
    const settings = testSettings({ maxFileSizeBytes: 30 });
    const calls: CapturedCall[] = [];
    const service = serviceWith(settings, calls, {
      path: 'f.bin',
      size: 30,
      sha256: 'x',
      mime_type: 'application/octet-stream',
    });
    await service.start();
    try {
      const okBytes = Buffer.alloc(30, 1);
      const out = await service.fileUpload({
        contextId: 'ctx-1',
        path: 'f.bin',
        contentBase64: okBytes.toString('base64'),
      });
      assert.equal(out['context_id'], 'ctx-1');
      const uploads = toolCalls(calls, '/internal/mcp/v1/files/upload');
      assert.equal(uploads.length, 1);
      // 请求体完整通过：桥侧按原始 base64 精判，不被 facade 截断。
      assert.equal(Buffer.from(String(uploads[0]?.body['content_base64']), 'base64').length, 30);
      const bigBytes = Buffer.alloc(31, 1);
      await assert.rejects(
        () =>
          service.fileUpload({
            contextId: 'ctx-1',
            path: 'f.bin',
            contentBase64: bigBytes.toString('base64'),
          }),
        /file size limit/,
      );
      assert.equal(
        toolCalls(calls, '/internal/mcp/v1/files/upload').length,
        1,
        '超限时不该发出桥调用',
      );
    } finally {
      await service.close();
    }
  });

  test('fileSearch: 发到 /files/search 并回显 context_id；缺参数与越界在发桥前拒绝', async () => {
    const settings = testSettings();
    const calls: CapturedCall[] = [];
    const service = serviceWith(settings, calls, { matches: [], truncated: false });
    await service.start();
    try {
      const out = await service.fileSearch({
        contextId: 'ctx-9',
        path: 'search',
        pattern: '**/*.py',
        query: null,
        maxResults: 50,
      });
      assert.equal(out['context_id'], 'ctx-9');
      const searches = toolCalls(calls, '/internal/mcp/v1/files/search');
      assert.equal(searches.length, 1);
      assert.equal(searches[0]?.body['max_results'], 50);
      await assert.rejects(
        () => service.fileSearch({ contextId: 'ctx-9', maxResults: 10 }),
        /pattern|query/,
      );
      await assert.rejects(
        () =>
          service.fileSearch({ contextId: 'ctx-9', query: 'x', maxResults: 501 }),
        /max_results/,
      );
      assert.equal(
        toolCalls(calls, '/internal/mcp/v1/files/search').length,
        1,
        '拒绝路径不该发出桥调用',
      );
    } finally {
      await service.close();
    }
  });
});

describe('mcp facade hardening: tool registration', () => {
  test('注册九个工具：新增 delete/upload/search 描述为英文且 schema 含关键参数', async () => {
    const settings = testSettings();
    const stub = {
      executePython: async () => ({ context_id: 'c' }),
      executeShell: async () => ({ context_id: 'c' }),
      fileWrite: async () => ({ context_id: 'c' }),
      fileRead: async () => ({ context_id: 'c' }),
      fileList: async () => ({ context_id: 'c' }),
      artifactSubmit: async () => ({ context_id: 'c' }),
      fileDelete: async () => ({ context_id: 'c' }),
      fileUpload: async () => ({ context_id: 'c' }),
      fileSearch: async () => ({ context_id: 'c' }),
    };
    const server = new McpServer({ name: 'test', version: '1' });
    registerMcpTools(server, stub as unknown as McpFacadeService);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      for (const expected of [
        'sandbox_python_execute',
        'sandbox_shell_execute',
        'sandbox_file_write',
        'sandbox_file_read',
        'sandbox_file_list',
        'sandbox_artifact_submit',
        'sandbox_file_delete',
        'sandbox_file_upload',
        'sandbox_file_search',
      ]) {
        assert.ok(names.includes(expected), `missing tool ${expected}`);
      }
      const byName = new Map(listed.tools.map((t) => [t.name, t]));
      const del = byName.get('sandbox_file_delete');
      assert.match(String(del?.description ?? ''), /[A-Za-z]/);
      assert.ok('path' in ((del?.inputSchema as Record<string, unknown>)['properties'] as object));
      const up = byName.get('sandbox_file_upload');
      assert.ok(
        'content_base64' in ((up?.inputSchema as Record<string, unknown>)['properties'] as object),
      );
      const search = byName.get('sandbox_file_search');
      const props = (search?.inputSchema as Record<string, unknown>)['properties'] as Record<
        string,
        unknown
      >;
      assert.ok('pattern' in props && 'query' in props && 'max_results' in props);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
