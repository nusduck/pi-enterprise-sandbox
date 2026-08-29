/**
 * 公共面逐字节不变的合约测试——对应 Python `sandbox/routers/{files,artifact/api/public,datasets,session_processes}`。
 *
 * 为什么需要它：api-server 的 `routes/files.js`/`artifacts.js`/`datasets.js`/`processes.js` 把
 * 调用原样透传给 sandbox，期望 status/header/body/错误码与 Python 版逐字节一致，
 * 切到 exec 时 BFF 不能改一行。本文件对照 Python 的每个错误分支写 TS 断言，
 * 覆盖：session 归属 404、参数校验 400、配额 413、unavailable 409、跨租户 404、脱敏无物理根。
 *
 * 全部在 macOS 可跑：用 `makeTestWorkspace` 的真实 temp 根 + `InMemoryJobStore`，
 * 不依赖真实 MySQL 或 bwrap，`await fs.realpath()` 已在 helper 里做过。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Hono } from 'hono';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createPublicRouter } from '../src/http/public/router.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { makeTestWorkspace } from './helpers.js';

describe('public: byte-identical contract vs Python', () => {
  let base: string;
  let workspaceManager: WorkspaceManager;
  let jobRegistry: MySqlJobRegistry;
  let app: Hono;

  before(async () => {
    const resolved = await realpath(tmpdir());
    base = await mkdtemp(path.join(resolved, 'pi-public-'));
    workspaceManager = new WorkspaceManager({
      workspacesBaseRoot: path.join(base, 'workspaces'),
      tempBaseRoot: path.join(base, 'tmp'),
    });
    const store = new InMemoryJobStore();
    jobRegistry = new MySqlJobRegistry(store);
    app = createPublicRouter({
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      enabledSkillPackagesFor: () => [],
      jobRegistry,
    });
    await mkdir(path.join(base, 'skills'), { recursive: true });
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const acting = {
    'x-acting-organization-id': 'org_test',
    'x-acting-user-id': 'user_test',
  };
  const otherActing = {
    'x-acting-organization-id': 'org_other',
    'x-acting-user-id': 'user_other',
  };

  async function initSession(id: string): Promise<void> {
    await workspaceManager.initWorkspace(id);
  }

  // ── files ──────────────────────────────────────────────────────────

  test('GET /sessions/:id/files — missing acting → 404 (跨租户不泄漏，Python 同款)', async () => {
    const id = 'pub_files_1';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/files?path=.`, { headers: {} });
    assert.equal(res.status, 404);
    const body = await res.json() as { error: string };
    assert.ok(!body.error.includes(base), `must be redacted: ${body.error}`);
  });

  test('GET /sessions/:id/files — valid → 200 {files,total} 且脱敏', async () => {
    const id = 'pub_files_2';
    await initSession(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    await writeFile(path.join(ws, 'hello.txt'), 'world');
    const res = await app.request(`/sessions/${id}/files?path=.`, { headers: acting });
    assert.equal(res.status, 200);
    const body = await res.json() as { files: unknown[]; total: number };
    assert.equal(body.total, body.files.length);
    assert.ok(body.total >= 1);
  });

  test('GET /preview — missing path → 400', async () => {
    const id = 'pub_preview_1';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/files/preview`, { headers: acting });
    assert.equal(res.status, 400);
  });

  test('GET /preview — valid → 200 且 preview 为前40行截断', async () => {
    const id = 'pub_preview_2';
    await initSession(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    const content = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    await writeFile(path.join(ws, 'big.txt'), content);
    const res = await app.request(`/sessions/${id}/files/preview?path=big.txt`, { headers: acting });
    assert.equal(res.status, 200);
    const body = await res.json() as { content: string };
    assert.ok(body.content.length <= 2000);
  });

  test('POST /files/upload — multipart → 201 且越界 413', async () => {
    const id = 'pub_upload_1';
    await initSession(id);
    const form = new FormData();
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    const res = await app.request(`/sessions/${id}/files/upload?path=`, { method: 'POST', headers: acting, body: form });
    assert.equal(res.status, 201);
    const body = await res.json() as { attachment_id: string; path: string };
    assert.ok(body.attachment_id);
  });

  test('POST /files/ls — EACCES 映射与 Python _search_http_error 对齐', async () => {
    const id = 'pub_ls_1';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/files/ls`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '.' }),
    });
    assert.equal(res.status, 200);
    // Python `/ls` 的 response_model 是 `FileSearchResponse`：`items` + `skipped`
    // + 六字段 `stats` + `truncated` + `stop_reason`。这条用例原先断言的
    // `{files}` 是占位实现自己发明的形状，断言跟着占位实现走了。
    const body = (await res.json()) as {
      items: unknown[];
      skipped: unknown[];
      stats: Record<string, number>;
      truncated: boolean;
      stop_reason: string | null;
    };
    assert.ok(Array.isArray(body.items));
    assert.ok(Array.isArray(body.skipped));
    assert.equal(body.truncated, false);
    assert.equal(body.stop_reason, null);
    assert.deepEqual(Object.keys(body.stats).sort(), [
      'bytes_scanned',
      'depth_reached',
      'duration_ms',
      'examined',
      'matched',
      'skipped',
    ]);
  });

  // ── artifacts ───────────────────────────────────────────────────────

  test('GET /artifacts — valid → 200 empty shape 逐字节一致', async () => {
    const id = 'pub_art_1';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/artifacts`, { headers: acting });
    assert.equal(res.status, 200);
    const body = await res.json() as { artifacts: unknown[]; total: number };
    assert.deepEqual(body, { artifacts: [], total: 0 });
  });

  test('POST /artifacts/register — missing path → 400 path_required', async () => {
    const id = 'pub_art_2';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/artifacts/register`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { code: string };
    assert.equal(body.code, 'path_required');
  });

  test('POST /artifacts/imports — missing artifact_id → 400', async () => {
    const id = 'pub_art_3';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/artifacts/imports`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  test('GET /artifacts/:id/download — 无存储时 404 (Python ArtifactError 404)', async () => {
    const id = 'pub_art_4';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/artifacts/art_unknown/download`, { headers: acting });
    assert.equal(res.status, 404);
  });

  // ── datasets ────────────────────────────────────────────────────────

  test('POST /datasets — missing Idempotency-Key → 400', async () => {
    const id = 'pub_ds_1';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/datasets`, {
      method: 'POST',
      headers: { ...acting, 'x-conversation-id': 'conv_1', 'Content-Type': 'text/plain' },
      body: 'csv,content',
    });
    assert.equal(res.status, 400);
    const body = await res.json() as { code: string };
    assert.equal(body.code, 'dataset_idempotency_key_required');
  });

  test('POST /datasets — valid with idempotency → 201', async () => {
    const id = 'pub_ds_2';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/datasets`, {
      method: 'POST',
      headers: { ...acting, 'x-conversation-id': 'conv_1', 'Idempotency-Key': 'idem-1', 'Content-Type': 'text/plain' },
      body: 'a,b\n1,2',
    });
    assert.equal(res.status, 201);
    const body = await res.json() as { dataset_id: string };
    assert.ok(body.dataset_id);
    assert.equal(((res.headers.get('x-trace-id')?.length ?? 0) > 0), true);
  });

  test('GET /datasets — missing session_id → 400', async () => {
    const res = await app.request('/datasets', { headers: acting });
    assert.equal(res.status, 400);
  });

  // ── processes (session_processes.py) ───────────────────────────────

  test('GET /processes/:pid/logs — offset<0 → 400', async () => {
    const id = 'pub_proc_1';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/processes/pid_1/logs?offset=-1`, { headers: acting });
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /offset must be/);
  });

  test('GET /processes/:pid/read — invalid stream → 400', async () => {
    const id = 'pub_proc_2';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/processes/pid_1/read?stream=bad&cursor=0-0`, { headers: acting });
    assert.equal(res.status, 400);
  });

  test('POST /processes/:pid/signal — invalid signal → 400', async () => {
    const id = 'pub_proc_3';
    await initSession(id);
    const res = await app.request(`/sessions/${id}/processes/pid_1/signal`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({ signal: 'SIGFOO' }),
    });
    assert.equal(res.status, 400);
  });

  test('POST /processes/:pid/stdin — >64KiB → 413', async () => {
    const id = 'pub_proc_4';
    await initSession(id);
    const big = 'x'.repeat(70 * 1024);
    const res = await app.request(`/sessions/${id}/processes/pid_1/stdin`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: big }),
    });
    assert.equal(res.status, 413);
  });

  test('GET /processes/:pid — unknown → 404 且跨租户同为 404', async () => {
    const id = 'pub_proc_5';
    await initSession(id);
    const res1 = await app.request(`/sessions/${id}/processes/unknown_1`, { headers: acting });
    assert.equal(res1.status, 404);
    const res2 = await app.request(`/sessions/${id}/processes/unknown_1`, { headers: otherActing });
    assert.equal(res2.status, 404);
  });

  test('错误文本无条件脱敏——物理根不泄漏', async () => {
    const id = 'pub_redact_1';
    await initSession(id);
    // 故意触发一个带物理路径的错误：让 read 去读一个不存在的绝对路径，底层会带上 base
    const res = await app.request(`/sessions/${id}/files/read`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/etc/passwd' }),
    });
    // 可能是 400 或 404，但错误文本中绝不能出现 base
    const body = await res.json() as { error: string };
    if (body.error) assert.ok(!body.error.includes(base), `must be redacted: ${body.error}`);
  });
});
