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
import { ArtifactService } from '../src/artifact/service.js';
import { DatasetService } from '../src/dataset/service.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import type { WorkspaceContext } from '../src/types.js';

describe('public: byte-identical contract vs Python', () => {
  let base: string;
  let workspaceManager: WorkspaceManager;
  let jobRegistry: MySqlJobRegistry;
  let artifactService: ArtifactService;
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
    // 控制面根指到 scratch 下：产物快照与数据集暂存都落在这里，生产默认的
    // /var/sandbox/* 在 macOS 上不可写。
    const controlRoots = {
      artifactsRoot: path.join(base, 'control', 'artifacts'),
      controlRoot: path.join(base, 'control', 'root'),
    };
    const makeFs = (ws: WorkspaceContext) =>
      new WorkspaceFileSystem(new CordisContext() as never, ws);
    artifactService = new ArtifactService(makeFs, undefined, { roots: controlRoots });
    app = createPublicRouter({
      apiToken: null,
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      enabledSkillPackagesFor: () => [],
      jobRegistry,
      artifactService,
      datasetService: new DatasetService(makeFs, undefined, { roots: controlRoots }),
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

  test('POST /artifacts/imports — returns complete import response', async () => {
    const id = 'pub_art_import_1';
    await initSession(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.writeFile(path.join(ws, 'out.txt'), 'artifact-content');

    const reg = await app.request(`/sessions/${id}/artifacts/submit`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'out.txt' }),
    });
    assert.equal(reg.status, 201);
    const registered = (await reg.json()) as { artifact_id: string };

    const res = await app.request(`/sessions/${id}/artifacts/imports`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifact_id: registered.artifact_id, target_filename: 'imported.txt' }),
    });
    assert.equal(res.status, 201);
    const imported = (await res.json()) as {
      import_id: string;
      artifact_id: string;
      target_session_id: string;
      workspace_file: {
        name: string;
        path: string;
        mime_type: string;
        size: number;
      };
    };
    assert.ok(imported.import_id);
    assert.equal(imported.artifact_id, registered.artifact_id);
    assert.equal(imported.target_session_id, id);
    assert.equal(imported.workspace_file.name, 'imported.txt');
    assert.equal(imported.workspace_file.path, 'imported.txt');
    assert.equal(imported.workspace_file.size, 16);
  });

  test('GET /artifacts + download — session_id 与 workspace 不同的记录也必须可见', async () => {
    // `exec_artifacts.session_id` 不是稳定的列表键：内部面的 `submit_artifact`
    // 写的是 **sandbox session id**，MCP facade 写的是 **workspace id**。
    // 公共面的路径参数解析出来的是 workspace，所以列表/下载都必须按 workspace 判，
    // 否则总有一半写入方的产物在 UI 上凭空消失（2026-09-03 的"刷新后产物没了"）。
    const id = 'pub_art_ws_key';
    await initSession(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.writeFile(path.join(ws, 'from-internal.txt'), 'internal-plane-bytes');

    const record = await artifactService.submit({
      workspace: {
        orgId: 'org_test',
        userId: 'user_test',
        workspaceId: id,
        workspaceRoot: ws,
        tempRoot: workspaceManager.physicalTempPath(id),
        systemSkillRoot: path.join(base, 'skills'),
        enabledSkillPackages: [],
      },
      // 内部面传的是 sandbox session id，和 workspaceId 不是一个值。
      sessionId: '01SANDBOXSESSION0000000000',
      sourcePath: 'from-internal.txt',
      name: null,
      mimeType: null,
      expectedSha256: null,
      owner: { orgId: 'org_test', userId: 'user_test' },
    });
    assert.notEqual(record.sessionId, record.workspaceId);

    const listed = await app.request(`/sessions/${id}/artifacts`, { headers: acting });
    assert.equal(listed.status, 200);
    const body = (await listed.json()) as { artifacts: Array<{ artifact_id: string }> };
    assert.deepEqual(
      body.artifacts.map((a) => a.artifact_id),
      [record.artifactId],
    );

    const download = await app.request(
      `/sessions/${id}/artifacts/${record.artifactId}/download`,
      { headers: acting },
    );
    assert.equal(download.status, 200);
    assert.equal(await download.text(), 'internal-plane-bytes');

    // 跨租户仍然 404，不因为改判据而放松。
    const foreign = await app.request(
      `/sessions/${id}/artifacts/${record.artifactId}/download`,
      { headers: otherActing },
    );
    assert.equal(foreign.status, 404);
  });

  test('POST /artifacts/imports — 工作区未初始化时 404，不凭空建目录', async () => {
    // 以前这里有一条 `mkdir -p`，于是任何形状合法的 id 都能把工作区造出来，
    // 也把"路径参数传错了"这类 bug 一起盖住（2026-09-03：拿 session id 当
    // workspace 用，全靠这条 mkdir 撑着）。
    const host = 'pub_art_import_src';
    await initSession(host);
    const ws = workspaceManager.physicalWorkspacePath(host);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    await fs.writeFile(path.join(ws, 'src.txt'), 'bytes');
    const reg = await app.request(`/sessions/${host}/artifacts/submit`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'src.txt' }),
    });
    assert.equal(reg.status, 201);
    const registered = (await reg.json()) as { artifact_id: string };

    const uninitialized = 'pub_art_never_created';
    const res = await app.request(`/sessions/${uninitialized}/artifacts/imports`, {
      method: 'POST',
      headers: { ...acting, 'Content-Type': 'application/json' },
      body: JSON.stringify({ artifact_id: registered.artifact_id }),
    });
    assert.equal(res.status, 404);
    assert.equal(
      await fs
        .stat(workspaceManager.physicalWorkspacePath(uninitialized))
        .then(() => true)
        .catch(() => false),
      false,
      '失败的导入不得留下一个凭空创建的工作区目录',
    );
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

  test('GET /processes lists the exec-owned durable jobs for this session', async () => {
    const id = 'pub_proc_list_1';
    await initSession(id);
    let output = 'hello\n';
    const snap = await jobRegistry.start({
      kind: 'bash',
      label: 'printf hello',
      owner: {
        orgId: acting['x-acting-organization-id'],
        userId: acting['x-acting-user-id'],
        workspaceId: id,
        runId: 'run_1',
      },
      physicalRoots: [],
      run: () => ({
        pid: 0,
        cancel() {},
        done: new Promise(() => {}),
        readOutput() {
          const delta = output;
          output = '';
          return { delta, lossy: false };
        },
      }),
    });

    const listed = await app.request(`/sessions/${id}/processes`, { headers: acting });
    assert.equal(listed.status, 200);
    const listBody = await listed.json() as { processes: Array<Record<string, unknown>> };
    assert.equal(listBody.processes[0]?.process_id, snap.id);
    assert.equal(listBody.processes[0]?.session_id, id);
    assert.equal(listBody.processes[0]?.run_id, 'run_1');
    assert.equal(listBody.processes[0]?.command, 'printf hello');

    const logs = await app.request(
      `/sessions/${id}/processes/${snap.id}/logs?offset=0&limit=100`,
      { headers: acting },
    );
    assert.equal(logs.status, 200);
    const logBody = await logs.json() as Record<string, unknown>;
    assert.equal(logBody.stdout, 'hello\n');
    assert.equal(logBody.next_offset, 6);
  });

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
