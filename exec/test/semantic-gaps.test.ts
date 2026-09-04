/**
 * 语义合约测试——**当前预期为红**。
 *
 * 为什么存在：`http-public.test.ts` / `http-internal.test.ts` 断言的是**响应
 * 形状**，而搜索、产物、数据集三块目前是占位实现，形状恰好是对的，所以那些
 * 用例全绿。绿测试盖着假实现，是比没有测试更危险的状态——它让进度表把
 * Wave 3 标成 ✅。
 *
 * 本文件断言的是**语义**：
 *   - grep 断言匹配到的行内容，不是"返回了一个数组"
 *   - artifact 断言下载回来的字节与提交的字节一致，不是"返回了 sha256 字段"
 *   - dataset 断言写进去的字节能原样读回来，不是"返回了 201"
 *
 * 逐条缺口见 [docs/design/waves/gap-audit.md](../../docs/design/waves/gap-audit.md)。
 * 每补完一块实现，对应的 test 应当自然转绿，**不要靠放松断言让它变绿**。
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Hono } from 'hono';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createPublicRouter } from '../src/http/public/router.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { ArtifactService } from '../src/artifact/service.js';
import { DatasetService } from '../src/dataset/service.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { Context as CordisContext } from '@deepseek-ai/cordis';

describe('semantic gaps: search / artifact / dataset (expected red until implemented)', () => {
  let base: string;
  let workspaceManager: WorkspaceManager;
  let app: Hono;

  const acting = {
    'x-acting-organization-id': 'org_test',
    'x-acting-user-id': 'user_test',
  };
  const json = { ...acting, 'Content-Type': 'application/json' };

  before(async () => {
    const resolved = await realpath(tmpdir());
    base = await mkdtemp(path.join(resolved, 'pi-semantic-'));
    workspaceManager = new WorkspaceManager({
      workspacesBaseRoot: path.join(base, 'workspaces'),
      tempBaseRoot: path.join(base, 'tmp'),
    });
    await mkdir(path.join(base, 'skills'), { recursive: true });
    // 控制面根指到 scratch 下。生产默认是 /var/sandbox/artifacts，macOS 上不可写，
    // 而快照必须落在工作区**之外**才谈得上不可变（见 artifact/service.ts）。
    const artifactService = new ArtifactService(
      (ws) => new WorkspaceFileSystem(new CordisContext() as never, ws),
      undefined,
      {
        roots: {
          artifactsRoot: path.join(base, 'control', 'artifacts'),
          controlRoot: path.join(base, 'control', 'root'),
        },
      },
    );
    const datasetService = new DatasetService(
      (ws) => new WorkspaceFileSystem(new CordisContext() as never, ws),
      undefined,
      {
        roots: {
          artifactsRoot: path.join(base, 'control', 'artifacts'),
          controlRoot: path.join(base, 'control', 'root'),
        },
      },
    );
    app = createPublicRouter({
      apiToken: null,
      workspaceManager,
      systemSkillRoot: path.join(base, 'skills'),
      enabledSkillPackagesFor: () => [],
      jobRegistry: new MySqlJobRegistry(new InMemoryJobStore()),
      artifactService,
      datasetService,
    });
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  async function seed(id: string, files: Record<string, string>): Promise<string> {
    await workspaceManager.initWorkspace(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(ws, rel);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content);
    }
    return ws;
  }

  // ── 搜索 ────────────────────────────────────────────────────────────

  test('grep 必须返回匹配到的行，而不是目录清单', async () => {
    const id = 'sem_grep_1';
    await seed(id, {
      'a.txt': 'alpha\nNEEDLE here\ngamma\n',
      'b.txt': 'nothing to see\n',
      'sub/c.txt': 'another NEEDLE line\n',
    });

    const res = await app.request(`/sessions/${id}/files/grep`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ query: 'NEEDLE', path: '.' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { matches?: { path: string; line: number; text: string }[] };

    assert.ok(Array.isArray(body.matches), 'grep 必须返回 matches 数组');
    assert.equal(body.matches.length, 2, '两个文件各一处匹配');
    const texts = body.matches.map((m) => m.text.trim()).sort();
    assert.deepEqual(texts, ['NEEDLE here', 'another NEEDLE line']);
    // 不匹配的文件绝不能出现在结果里——占位实现返回 listDir，b.txt 会混进来。
    assert.ok(
      !body.matches.some((m) => m.path.includes('b.txt')),
      'b.txt 不含 NEEDLE，不该出现在 grep 结果里',
    );
  });

  test('grep 必须跳过二进制文件，不把乱码灌进模型上下文', async () => {
    const id = 'sem_grep_2';
    await workspaceManager.initWorkspace(id);
    const ws = workspaceManager.physicalWorkspacePath(id);
    // 含 NUL 的字节序列：Python `_is_binary_bytes` 据此判定二进制。
    await writeFile(path.join(ws, 'blob.bin'), Buffer.from([0x4e, 0x00, 0x45, 0x45, 0x44]));
    await writeFile(path.join(ws, 'ok.txt'), 'NEED\n');

    const res = await app.request(`/sessions/${id}/files/grep`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ query: 'NEED', path: '.' }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { matches?: { path: string }[] };
    assert.ok(Array.isArray(body.matches));
    // 先断言"该匹配的匹配到了"。只写"二进制不在结果里"会被空数组白白满足——
    // 占位实现恒返回 matches: []，那样这条用例是假绿。
    assert.ok(
      body.matches.some((m) => m.path.includes('ok.txt')),
      'ok.txt 含 NEED，必须匹配到',
    );
    assert.ok(
      !body.matches.some((m) => m.path.includes('blob.bin')),
      '二进制文件必须被跳过',
    );
  });

  test('find 必须按 pattern 过滤，而不是回一个空列表', async () => {
    const id = 'sem_find_1';
    await seed(id, {
      'keep.md': '# doc\n',
      'skip.txt': 'text\n',
      'nested/also.md': '# nested\n',
    });

    const res = await app.request(`/sessions/${id}/files/find`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ pattern: '*.md', path: '.' }),
    });
    assert.equal(res.status, 200);
    // Python `FindRequest` → `FileSearchResponse`：是 `items`，不是 `files`。
    const body = (await res.json()) as {
      items: { path: string }[];
      stats: { matched: number };
    };

    assert.equal(body.stats.matched, 2, '两个 .md 文件');
    const found = body.items.map((f) => f.path).sort();
    assert.deepEqual(found, ['keep.md', 'nested/also.md']);
  });

  // ── 产物 ────────────────────────────────────────────────────────────

  test('artifact submit 必须返回真实字节的 sha256 与 size', async () => {
    const id = 'sem_art_1';
    const content = 'artifact payload\n';
    await seed(id, { 'out/report.md': content });
    const expected = createHash('sha256').update(content).digest('hex');

    const res = await app.request(`/sessions/${id}/artifacts/submit`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ path: 'out/report.md', name: 'report.md' }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { sha256: string; size: number; artifact_id: string };

    assert.equal(body.sha256, expected, 'sha256 必须是真实字节的摘要');
    assert.equal(body.size, Buffer.byteLength(content), 'size 必须是真实字节数');
    assert.notEqual(body.sha256, '0'.repeat(64), 'sha256 不能是占位值');
  });

  test('artifact submit → download 必须原样取回同一份字节', async () => {
    const id = 'sem_art_2';
    const content = 'round trip bytes ✅\n';
    await seed(id, { 'out/data.bin': content });

    const submitted = await app.request(`/sessions/${id}/artifacts/submit`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ path: 'out/data.bin', name: 'data.bin' }),
    });
    assert.equal(submitted.status, 201);
    const { artifact_id: artifactId } = (await submitted.json()) as { artifact_id: string };

    const got = await app.request(`/sessions/${id}/artifacts/${artifactId}/download`, {
      headers: acting,
    });
    assert.equal(got.status, 200, 'download 必须找得到刚提交的产物');
    assert.equal(await got.text(), content);
  });

  test('提交过的产物必须出现在列表里', async () => {
    const id = 'sem_art_3';
    await seed(id, { 'out/one.txt': 'one\n' });
    await app.request(`/sessions/${id}/artifacts/submit`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ path: 'out/one.txt', name: 'one.txt' }),
    });

    const res = await app.request(`/sessions/${id}/artifacts`, { headers: acting });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { artifacts: { name: string }[]; total: number };
    assert.equal(body.total, 1);
    assert.equal(body.artifacts[0]?.name, 'one.txt');
  });

  test('产物下载必须把 html/svg 降级成 octet-stream（防存储型 XSS）', async () => {
    const id = 'sem_art_4';
    await seed(id, { 'out/x.html': '<script>alert(1)</script>' });

    const submitted = await app.request(`/sessions/${id}/artifacts/submit`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ path: 'out/x.html', name: 'x.html', mime_type: 'text/html' }),
    });
    const { artifact_id: artifactId } = (await submitted.json()) as { artifact_id: string };

    const got = await app.request(`/sessions/${id}/artifacts/${artifactId}/download`, {
      headers: acting,
    });
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  });

  // ── 数据集 ──────────────────────────────────────────────────────────

  test('dataset 上传必须真的落盘，且能原样读回', async () => {
    const id = 'sem_ds_1';
    await workspaceManager.initWorkspace(id);
    const payload = 'col_a,col_b\n1,2\n';

    const up = await app.request(`/sessions/${id}/datasets?filename=t.csv`, {
      method: 'POST',
      headers: {
        ...acting,
        // Python `_ownership_from_request` 同样要求 conversation_id。
        'X-Conversation-Id': 'conv_sem_1',
        'Content-Type': 'text/csv',
        'Idempotency-Key': 'sem-ds-1-key',
        'Content-Length': String(Buffer.byteLength(payload)),
      },
      body: payload,
    });
    assert.equal(up.status, 201);
    const { dataset_id: datasetId } = (await up.json()) as { dataset_id: string };

    const got = await app.request(`/sessions/${id}/datasets/${datasetId}/content`, {
      headers: acting,
    });
    assert.equal(got.status, 200, '刚上传的数据集必须读得回来');
    assert.equal(await got.text(), payload);
  });

  test('同一个 Idempotency-Key 重复上传必须返回同一个 dataset_id', async () => {
    const id = 'sem_ds_2';
    await workspaceManager.initWorkspace(id);
    const payload = 'x\n';
    const headers = {
      ...acting,
      'X-Conversation-Id': 'conv_sem_2',
      'Content-Type': 'text/csv',
      'Idempotency-Key': 'sem-ds-2-key',
      'Content-Length': String(Buffer.byteLength(payload)),
    };

    const first = await app.request(`/sessions/${id}/datasets?filename=a.csv`, {
      method: 'POST',
      headers,
      body: payload,
    });
    const second = await app.request(`/sessions/${id}/datasets?filename=a.csv`, {
      method: 'POST',
      headers,
      body: payload,
    });

    const a = (await first.json()) as { dataset_id: string };
    const b = (await second.json()) as { dataset_id: string };
    assert.equal(a.dataset_id, b.dataset_id, '幂等键必须去重，而不是每次新建');

    // 光比 id 相等会被占位实现白白满足：它用 `ds_${Date.now()}`，同一毫秒内
    // 两次调用天然相等。再断言这个 id 真的指向已落盘的内容，空实现就过不去。
    const got = await app.request(`/sessions/${id}/datasets/${a.dataset_id}/content`, {
      headers: acting,
    });
    assert.equal(got.status, 200);
    assert.equal(await got.text(), payload);
  });
});
