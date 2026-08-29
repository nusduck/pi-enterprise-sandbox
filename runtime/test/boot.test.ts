/**
 * W4-D 组合层：叠在 dsh-base 上，deepseek-official 指向配置网关，本机执行族关闭。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import { bootEnterpriseRuntime, createRemoteProviders, createSessionBackend } from '../src/boot.js';
import { InMemorySessionStore } from '../src/providers/mysql-session-store.js';

const patchPath = join(dirname(fileURLToPath(import.meta.url)), '../bundle/cordis.patch.yml');

test('cordis.patch.yml：凭据只读 env，网关走 LLMIO_BASE_URL，本机执行族 disabled', () => {
  const yaml = readFileSync(patchPath, 'utf8');
  assert.match(yaml, /id: credentials/);
  assert.match(yaml, /env-credentials\.js/);
  assert.match(yaml, /id: llm-deepseek/);
  assert.match(yaml, /apiKeyEnv: LLMIO_API_KEY/);
  assert.match(yaml, /LLMIO_BASE_URL/);
  for (const id of [
    'sandbox',
    'sandbox-policy',
    'bash-sandbox',
    'pwsh-sandbox',
    'fs-sandbox',
    'subprocess',
    'jobs',
    'approval',
    'permission',
    'session-persistence-jsonl',
    'tool-fs-search',
    'tool-pwsh',
  ]) {
    const block = yaml.split(`- id: ${id}\n`)[1]?.slice(0, 80) ?? '';
    assert.match(block, /disabled:\s*true/, `expected ${id} disabled`);
  }
  assert.match(yaml, /id: remote-fs/);
  assert.match(yaml, /dist\/providers\/remote-fs\.js/);
  assert.match(yaml, /id: remote-shell/);
  assert.match(yaml, /dist\/providers\/remote-shell\.js/);
  assert.match(yaml, /id: remote-jobs/);
  assert.match(yaml, /dist\/providers\/remote-jobs\.js/);
  assert.equal(yaml.includes('id: tool-bash\n  disabled: true'), false);
  assert.equal(yaml.includes('id: tool-fs\n  disabled: true'), false);
  assert.match(yaml, /id: subagent-spawn-in-process/);
  assert.match(yaml, /durable-subagent\.js/);
});

test('createRemoteProviders 装配 RPC 代理且不碰本机路径', () => {
  const ctx = new Context();
  const providers = createRemoteProviders(ctx, {
    baseUrl: 'http://exec',
    keyring: { test: Buffer.from('0'.repeat(32)).toString('base64url') },
    activeKid: 'test',
    orgId: 'o',
    userId: 'u',
    workspaceId: 'w',
    fenceToken: 0,
    physicalRoots: ['/var/sandbox/workspaces/secret'],
    fetchImpl: (async () => new Response(JSON.stringify({ ok: true, data: {} }))) as typeof fetch,
  });
  assert.equal(providers.fs.sandboxMode, undefined);
  assert.equal(providers.shell.sandboxMode, undefined);
});

test('bootEnterpriseRuntime 是可调用的导出（全树 boot 留给真实链路）', () => {
  assert.equal(typeof bootEnterpriseRuntime, 'function');
});

test('createSessionBackend 缺 MySQL 配回退内存，不红', () => {
  const prev = {
    MYSQL_HOST: process.env['MYSQL_HOST'],
    DB_HOST: process.env['DB_HOST'],
    EXEC_DB_HOST: process.env['EXEC_DB_HOST'],
  };
  delete process.env['MYSQL_HOST'];
  delete process.env['DB_HOST'];
  delete process.env['EXEC_DB_HOST'];
  try {
    const store = createSessionBackend({ physicalRoots: [] });
    assert.equal(store instanceof InMemorySessionStore, true);
    assert.equal(store.name, 'mysql-memory');
  } finally {
    if (prev.MYSQL_HOST !== undefined) process.env['MYSQL_HOST'] = prev.MYSQL_HOST;
    if (prev.DB_HOST !== undefined) process.env['DB_HOST'] = prev.DB_HOST;
    if (prev.EXEC_DB_HOST !== undefined) process.env['EXEC_DB_HOST'] = prev.EXEC_DB_HOST;
  }
});
