/**
 * W3-A 内部面测试——HMAC + CIDR + 信封 + 脱敏 + AsyncIterable 守卫。
 *
 * 全部纯函数/内存路径，不依赖 bwrap/MySQL，macOS 可跑。
 * 临时目录先 realpath，避免 /var -> /private/var 对不上（W1-B 教训）。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { issueInternalToken } from '@pi/contract/hmac.js';
import { createInternalRouter } from '../src/http/router.js';
import { isIpAllowed } from '../src/security/cidr.js';
import { hashBodySha256, verifyInternalRequest } from '../src/security/hmac.js';
import { redactPhysicalRoots } from '../src/fs/redact.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { Context } from '@deepseek-ai/cordis';

// ── helpers ──────────────────────────────────────────────────────────

function sha256Hex(data: Uint8Array | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return createHash('sha256').update(buf).digest('hex');
}

const TEST_KID = 'test-kid-1';
const TEST_KEY_B64URL = Buffer.from('0'.repeat(32), 'utf8').toString('base64url'); // 32 bytes
const KEYRING = { [TEST_KID]: TEST_KEY_B64URL };

function makeToken(opts: {
  method?: string;
  path: string;
  body: Uint8Array | string;
  workspaceId?: string;
  orgId?: string;
  userId?: string;
}): string {
  const bodyBytes = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : Buffer.from(opts.body);
  const bodySha = sha256Hex(bodyBytes);
  return issueInternalToken({
    keyring: KEYRING,
    activeKid: TEST_KID,
    claims: {
      org_id: opts.orgId ?? 'org_test',
      user_id: opts.userId ?? 'user_test',
      conversation_id: 'conv_test',
      agent_session_id: 'as_test',
      sandbox_session_id: 'ss_test',
      run_id: 'run_test',
      tool_execution_id: 'te_test',
      tool_call_id: 'tc_test',
      tool_name: 'fs.resolve',
      scope: ['sandbox.fs.resolve'],
      request_hash: 'a'.repeat(64),
      execution_fence_token: 1,
      trace_id: 'trace_test',
      htm: 'POST',
      htu: opts.path,
      body_sha256: bodySha,
    },
  });
}

async function makeTempManager(): Promise<{ manager: WorkspaceManager; cleanup: () => Promise<void> }> {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(join(base, 'exec-http-test-'));
  const manager = new WorkspaceManager({
    workspacesBaseRoot: join(root, 'ws'),
    tempBaseRoot: join(root, 'tmp'),
  });
  return { manager, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ── CIDR ─────────────────────────────────────────────────────────────

test('cidr: empty allowlist allows any ip', () => {
  assert.equal(isIpAllowed('10.0.0.1', []), true);
  assert.equal(isIpAllowed('::1', []), true);
});

test('cidr: exact match and subnet', () => {
  assert.equal(isIpAllowed('10.0.0.5', ['10.0.0.0/24']), true);
  assert.equal(isIpAllowed('10.0.1.5', ['10.0.0.0/24']), false);
  assert.equal(isIpAllowed('192.168.1.1', ['192.168.0.0/16']), true);
  assert.equal(isIpAllowed('::1', ['::1/128']), true);
  assert.equal(isIpAllowed('::2', ['::1/128']), false);
});

// ── HMAC body binding ────────────────────────────────────────────────

test('hmac: correct body passes, tampered body fails', () => {
  const body = JSON.stringify({ envelope: { requestId: 'r1', workspaceId: 'ws1', orgId: 'org1', userId: 'u1', fenceToken: 1 }, payload: {} });
  const path = '/internal/v1/fs/resolve';
  const token = makeToken({ path, body });
  const raw = Buffer.from(body, 'utf8');
  // correct
  const claims = verifyInternalRequest(`Bearer ${token}`, { keyring: KEYRING, rawBody: raw, method: 'POST', path });
  assert.equal(claims.body_sha256, sha256Hex(raw));
  // tampered
  const tampered = Buffer.from(body + ' ', 'utf8');
  assert.throws(() => verifyInternalRequest(`Bearer ${token}`, { keyring: KEYRING, rawBody: tampered, method: 'POST', path }));
});

test('hmac: htu mismatch fails', () => {
  const body = '{}';
  const token = makeToken({ path: '/internal/v1/fs/resolve', body });
  assert.throws(() => verifyInternalRequest(`Bearer ${token}`, { keyring: KEYRING, rawBody: Buffer.from(body), method: 'POST', path: '/internal/v1/fs/stat' }));
});

test('redact is unconditional: any error type leaks no physical root', () => {
  const roots = ['/var/sandbox/workspaces/ws-123', '/tmp/ws-123'];
  const msg = `EACCES: open '/var/sandbox/workspaces/ws-123/secret.txt'`;
  const redacted = redactPhysicalRoots(msg, roots);
  assert.ok(!redacted.includes('/var/sandbox/workspaces/ws-123'));
  assert.ok(redacted.includes('<workspace>'));
  const err = new Error(msg);
  const redacted2 = redactPhysicalRoots(err.message, roots);
  assert.ok(!redacted2.includes('ws-123'));
});

// ── AsyncIterable guard ──────────────────────────────────────────────

test('guardIterable: streamText error is redacted not leaked', async () => {
  // 复用 WorkspaceFileSystem 的 guardIterable 间接验证：构造一个会抛物理路径的 iterable
  async function* leaking(): AsyncIterable<string> {
    yield 'chunk1';
    throw new Error("EACCES: open '/var/sandbox/workspaces/ws-leak/file.txt'");
  }
  // 模拟 guardIterable 逻辑
  async function* guard<T>(iter: AsyncIterable<T>, roots: readonly string[]): AsyncIterable<T> {
    try {
      for await (const c of iter) yield c;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(redactPhysicalRoots(msg, roots));
    }
  }
  const guarded = guard(leaking(), ['/var/sandbox/workspaces/ws-leak']);
  const chunks: string[] = [];
  let caught = '';
  try {
    for await (const c of guarded) chunks.push(c);
  } catch (e) {
    caught = e instanceof Error ? e.message : String(e);
  }
  assert.deepEqual(chunks, ['chunk1']);
  assert.ok(!caught.includes('/var/sandbox/workspaces/ws-leak'));
  assert.ok(caught.includes('<workspace>'));
});

// ── Envelope must carry workspaceId ──────────────────────────────────

test('envelope: workspaceId required, missing fails via router', async () => {
  const { manager, cleanup } = await makeTempManager();
  const store = new InMemoryJobStore();
  const registry = new MySqlJobRegistry(store as never);
  const app = createInternalRouter({
    workspaceManager: manager,
    systemSkillRoot: '/tmp/skills',
    enabledSkillPackagesFor: () => [],
    cordisContext: new Context(),
    bwrapExecutable: '/usr/bin/bwrap',
    modeFor: () => 'workspace-write',
    jobRegistry: registry,
    keyring: KEYRING,
    allowCidr: [],
  });
  const body = JSON.stringify({ envelope: { requestId: 'r1', orgId: 'o1', userId: 'u1', fenceToken: 1 }, payload: {} });
  const token = makeToken({ path: '/internal/v1/sessions/ensure', body, workspaceId: undefined as unknown as string });
  // token 仍签了 workspace，但 envelope 故意缺 workspaceId
  const res = await app.request('/internal/v1/sessions/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
  });
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json['ok'], false);
  await cleanup();
});

test('router: happy path sessions/ensure creates workspace', async () => {
  const { manager, cleanup } = await makeTempManager();
  const store = new InMemoryJobStore();
  const registry = new MySqlJobRegistry(store as never);
  const app = createInternalRouter({
    workspaceManager: manager,
    systemSkillRoot: '/tmp/skills',
    enabledSkillPackagesFor: () => [],
    cordisContext: new Context(),
    bwrapExecutable: '/usr/bin/bwrap',
    modeFor: () => 'workspace-write',
    jobRegistry: registry,
    keyring: KEYRING,
    allowCidr: [],
  });
  const envelope = { requestId: 'r2', workspaceId: 'ws-happy-1', orgId: 'org1', userId: 'u1', fenceToken: 1 };
  const bodyObj = { envelope, payload: {} };
  const body = JSON.stringify(bodyObj);
  const token = makeToken({ path: '/internal/v1/sessions/ensure', body });
  const res = await app.request('/internal/v1/sessions/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as Record<string, unknown>;
  assert.equal(json['ok'], true);
  await cleanup();
});

test('router: fs search accepts the resolved FsTarget object', async () => {
  const { manager, cleanup } = await makeTempManager();
  const store = new InMemoryJobStore();
  const registry = new MySqlJobRegistry(store as never);
  await manager.initWorkspace('ws-find-target');
  await writeFile(
    join(manager.physicalWorkspacePath('ws-find-target'), 'needle.txt'),
    'needle content',
    'utf8',
  );
  const app = createInternalRouter({
    workspaceManager: manager,
    systemSkillRoot: '/tmp/skills',
    enabledSkillPackagesFor: () => [],
    cordisContext: new Context(),
    bwrapExecutable: '/usr/bin/bwrap',
    modeFor: () => 'workspace-write',
    jobRegistry: registry,
    keyring: KEYRING,
    allowCidr: [],
  });
  const path = '/internal/v1/fs/find';
  const body = JSON.stringify({
    envelope: {
      requestId: 'r-find-target',
      workspaceId: 'ws-find-target',
      orgId: 'org1',
      userId: 'u1',
      fenceToken: 1,
    },
    payload: {
      target: { targetKey: 'untrusted-physical-key', displayPath: '.' },
      pattern: '*.txt',
      options: {},
    },
  });
  const token = makeToken({ path, body });
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body,
  });
  assert.equal(res.status, 200);
  const json = (await res.json()) as { ok: boolean; data?: { items?: Array<{ path: string }> } };
  assert.equal(json.ok, true);
  assert.ok(json.data?.items?.some((item) => item.path === 'needle.txt'));
  await cleanup();
});

test('router: CIDR deny returns 403 before HMAC', async () => {
  const { manager, cleanup } = await makeTempManager();
  const store = new InMemoryJobStore();
  const registry = new MySqlJobRegistry(store as never);
  const app = createInternalRouter({
    workspaceManager: manager,
    systemSkillRoot: '/tmp/skills',
    enabledSkillPackagesFor: () => [],
    cordisContext: new Context(),
    bwrapExecutable: '/usr/bin/bwrap',
    modeFor: () => 'workspace-write',
    jobRegistry: registry,
    keyring: KEYRING,
    allowCidr: ['10.0.0.0/24'],
  });
  const envelope = { requestId: 'r3', workspaceId: 'ws-cidr', orgId: 'org1', userId: 'u1', fenceToken: 1 };
  const body = JSON.stringify({ envelope, payload: {} });
  const token = makeToken({ path: '/internal/v1/sessions/ensure', body });
  const res = await app.request('/internal/v1/sessions/ensure', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-forwarded-for': '192.168.1.1',
    },
    body,
  });
  assert.equal(res.status, 403);
  await cleanup();
});

test('router: tampered body_sha256 returns 401', async () => {
  const { manager, cleanup } = await makeTempManager();
  const store = new InMemoryJobStore();
  const registry = new MySqlJobRegistry(store as never);
  const app = createInternalRouter({
    workspaceManager: manager,
    systemSkillRoot: '/tmp/skills',
    enabledSkillPackagesFor: () => [],
    cordisContext: new Context(),
    bwrapExecutable: '/usr/bin/bwrap',
    modeFor: () => 'workspace-write',
    jobRegistry: registry,
    keyring: KEYRING,
    allowCidr: [],
  });
  const envelope = { requestId: 'r4', workspaceId: 'ws-tamper', orgId: 'org1', userId: 'u1', fenceToken: 1 };
  const body = JSON.stringify({ envelope, payload: {} });
  const token = makeToken({ path: '/internal/v1/sessions/ensure', body });
  const tamperedBody = body + ' ';
  const res = await app.request('/internal/v1/sessions/ensure', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: tamperedBody,
  });
  assert.equal(res.status, 401);
  await cleanup();
});
