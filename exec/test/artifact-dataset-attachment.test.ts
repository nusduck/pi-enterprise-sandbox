/**
 * W3-B：artifact / dataset / attachment —— 移植自 Python 版
 * `artifact_repository.py` / `dataset_manager.py` / `attachment_manager.py`
 * 的核心用例，改写为 TS 并满足 _shared.md 硬约束：
 * - 物理根无条件脱敏（construct 的 workspaceRoot/tempRoot 双形态）
 * - 文件经 WorkspaceFileSystem 围栏
 * - 产物经 quota 账本（内存替身，macOS 无 MySQL 可跑）
 * - 临时目录先 realpath
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test, before, after } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { WorkspaceContext } from '../src/types.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { ArtifactService, downloadMimeType } from '../src/artifact/service.js';
import { DatasetService, DatasetError, sanitizeDatasetFilename } from '../src/dataset/service.js';
import { AttachmentService } from '../src/attachment/service.js';
import { InMemoryArtifactStore } from '../src/db/repositories/artifacts.js';
import { InMemoryDatasetStore } from '../src/db/repositories/datasets.js';

async function makeWs(): Promise<{ root: string; ctx: WorkspaceContext; fs: WorkspaceFileSystem; cleanup: () => Promise<void> }> {
  const raw = await mkdtemp(path.join(await realpath(tmpdir()), 'pi-w3b-'));
  const root = await realpath(raw);
  const workspaceRoot = path.join(root, 'ws');
  const tempRoot = path.join(root, 'tmp');
  const systemSkillRoot = path.join(root, 'skills');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(workspaceRoot, { recursive: true });
  await mkdir(tempRoot, { recursive: true });
  await mkdir(systemSkillRoot, { recursive: true });
  const ctx: WorkspaceContext = {
    orgId: 'org_w3b',
    userId: 'user_w3b',
    workspaceId: `ws_${root.split('/').pop()}`,
    workspaceRoot,
    tempRoot,
    systemSkillRoot,
    enabledSkillPackages: [],
  };
  const cordis = new Context();
  const fs = new WorkspaceFileSystem(cordis, ctx);
  return { root, ctx, fs, cleanup: () => rm(root, { recursive: true, force: true }) };
}

describe('W3-B artifact', () => {
  /** 控制面根放在工作区之外的 scratch 目录里——快照的全部意义在于模型碰不到它。 */
  function svcFor(fs: WorkspaceFileSystem, root: string, store?: InMemoryArtifactStore) {
    return new ArtifactService(() => fs, store ?? new InMemoryArtifactStore(), {
      roots: {
        artifactsRoot: path.join(root, 'control', 'artifacts'),
        controlRoot: path.join(root, 'control', 'root'),
      },
    });
  }

  const owner = { orgId: 'org_w3b', userId: 'user_w3b' };

  test('submit → 快照落在控制面而不是工作区，字节与 sha256 都对得上', async () => {
    const { root, ctx, fs, cleanup } = await makeWs();
    const svc = svcFor(fs, root);
    const payload = 'hello artifact';
    await writeFile(path.join(ctx.workspaceRoot, 'out.txt'), payload);

    const rec = await svc.submit({
      workspace: ctx,
      sessionId: ctx.workspaceId,
      sourcePath: 'out.txt',
      name: '../evil.txt',
      owner,
    });

    assert.equal(rec.sha256, createHash('sha256').update(payload).digest('hex'));
    assert.equal(rec.sizeBytes, Buffer.byteLength(payload));

    const chunks: Buffer[] = [];
    for await (const chunk of svc.openSnapshot(rec)) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString('utf8'), payload);

    // 快照不在工作区里：模型删掉源文件也不影响已提交的产物。
    await rm(path.join(ctx.workspaceRoot, 'out.txt'));
    const again: Buffer[] = [];
    for await (const chunk of svc.openSnapshot(rec)) again.push(chunk);
    assert.equal(Buffer.concat(again).toString('utf8'), payload, '源文件删除后快照仍可读');

    await cleanup();
  });

  test('跨租户取产物返回 null（当作不存在），且不泄漏物理根', async () => {
    const a = await makeWs();
    const store = new InMemoryArtifactStore();
    const svcA = svcFor(a.fs, a.root, store);
    await writeFile(path.join(a.ctx.workspaceRoot, 'secret.txt'), 'secret');
    const rec = await svcA.submit({
      workspace: a.ctx,
      sessionId: a.ctx.workspaceId,
      sourcePath: 'secret.txt',
      owner,
    });

    // 同一个 store，换一个租户身份来取：必须是 null，而不是"找到了但拒绝"
    // ——后者会泄漏"这个 id 存在"。
    const got = await svcA.get(rec.artifactId, { orgId: 'org_other', userId: 'user_other' });
    assert.equal(got, null);

    await a.cleanup();
  });

  test('submit 的 sourcePath 经 WorkspaceFileSystem 围栏，越界即拒且脱敏', async () => {
    const { root, ctx, fs, cleanup } = await makeWs();
    const svc = svcFor(fs, root);
    await assert.rejects(
      () =>
        svc.submit({
          workspace: ctx,
          sessionId: ctx.workspaceId,
          sourcePath: '../../etc/passwd',
          owner,
        }),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.ok(!msg.includes(ctx.workspaceRoot), `leaked root: ${msg}`);
        return true;
      },
    );
    await cleanup();
  });

  test('expected_sha256 不匹配即拒，且不留下无主快照', async () => {
    const { root, ctx, fs, cleanup } = await makeWs();
    const svc = svcFor(fs, root);
    await writeFile(path.join(ctx.workspaceRoot, 'x.txt'), 'real');
    await assert.rejects(
      () =>
        svc.submit({
          workspace: ctx,
          sessionId: ctx.workspaceId,
          sourcePath: 'x.txt',
          expectedSha256: 'f'.repeat(64),
          owner,
        }),
      /sha256/,
    );
    assert.deepEqual(await svc.list(ctx.workspaceId, owner), [], '拒绝后不该留下记录');
    await cleanup();
  });

  test('importToWorkspace 把快照写回工作区，名字经 sanitize', async () => {
    const { root, ctx, fs, cleanup } = await makeWs();
    const svc = svcFor(fs, root);
    await writeFile(path.join(ctx.workspaceRoot, 'src.txt'), 'imported bytes');
    const rec = await svc.submit({
      workspace: ctx,
      sessionId: ctx.workspaceId,
      sourcePath: 'src.txt',
      owner,
    });

    const { path: written } = await svc.importToWorkspace({
      artifactId: rec.artifactId,
      workspace: ctx,
      owner,
      targetFilename: '../escape.txt',
    });
    assert.ok(!written.includes('..'), `sanitize 失效: ${written}`);
    assert.equal(await readFile(path.join(ctx.workspaceRoot, written), 'utf8'), 'imported bytes');
    await cleanup();
  });

  test('downloadMimeType 把可执行类型降级成 octet-stream', () => {
    for (const mime of ['text/html', 'image/svg+xml', 'application/xhtml+xml', 'TEXT/HTML']) {
      assert.equal(downloadMimeType(mime), 'application/octet-stream', mime);
    }
    assert.equal(downloadMimeType('text/plain'), 'text/plain');
    assert.equal(downloadMimeType(''), 'application/octet-stream');
  });
});

describe('W3-B dataset', () => {
  function svcFor(fs: WorkspaceFileSystem, root: string, store?: InMemoryDatasetStore) {
    return new DatasetService(() => fs, store ?? new InMemoryDatasetStore(), {
      roots: {
        artifactsRoot: path.join(root, 'control', 'artifacts'),
        controlRoot: path.join(root, 'control', 'root'),
      },
    });
  }

  const owner = { orgId: 'org_w3b', userId: 'user_w3b' };

  function begin(ctx: WorkspaceContext, filename: string, idem?: string) {
    return {
      workspace: ctx,
      sessionId: ctx.workspaceId,
      conversationId: 'conv_w3b',
      owner,
      originalFilename: filename,
      ...(idem !== undefined ? { idempotencyKey: idem } : {}),
    };
  }

  async function* bytes(...parts: string[]): AsyncGenerator<Uint8Array> {
    for (const part of parts) yield new TextEncoder().encode(part);
  }

  test('三段式流式上传 → 落到工作区 datasets/{id}/{name}，字节与 sha256 都对', async () => {
    const { root, ctx, fs, cleanup } = await makeWs();
    const svc = svcFor(fs, root);
    // 分两块喂，证明确实是流式而不是一次性 buffer。
    const rec = await svc.uploadStream(begin(ctx, 'my dataset.csv'), bytes('col_a,col_b\n', '1,2\n'));

    assert.equal(rec.status, 'ready');
    // Python 的 sanitize 不动空格，只处理分隔符/控制字符/`..`/首尾点。
    assert.equal(rec.storedRelativePath, `datasets/${rec.datasetId}/my dataset.csv`);
    assert.equal(rec.sizeBytes, Buffer.byteLength('col_a,col_b\n1,2\n'));
    assert.equal(rec.sha256, createHash('sha256').update('col_a,col_b\n1,2\n').digest('hex'));

    const physical = await svc.resolveContentPath(rec, ctx);
    assert.equal(await readFile(physical, 'utf8'), 'col_a,col_b\n1,2\n');
    // 落点必须在工作区内——数据集与产物相反，它就是要给模型读的。
    assert.ok(physical.startsWith(ctx.workspaceRoot), physical);
    await cleanup();
  });

  test('跨租户取数据集当作不存在，不泄漏物理根', async () => {
    const a = await makeWs();
    const store = new InMemoryDatasetStore();
    const svcA = svcFor(a.fs, a.root, store);
    const rec = await svcA.uploadStream(begin(a.ctx, 'secret.csv'), bytes('hi'));

    assert.equal(await svcA.get(rec.datasetId, { orgId: 'org_x', userId: 'user_x' }), null);
    assert.deepEqual(await svcA.list(a.ctx.workspaceId, { orgId: 'org_x', userId: 'user_x' }), []);
    await a.cleanup();
  });

  test('同一个幂等键第二次上传不新建，直接回首次的记录', async () => {
    const { root, ctx, fs, cleanup } = await makeWs();
    const store = new InMemoryDatasetStore();
    const svc = svcFor(fs, root, store);
    const first = await svc.uploadStream(begin(ctx, 'a.csv', 'idem-key-1'), bytes('x'));
    const second = await svc.uploadStream(begin(ctx, 'a.csv', 'idem-key-1'), bytes('x'));
    assert.equal(second.datasetId, first.datasetId);
    assert.equal((await svc.list(ctx.workspaceId, owner)).length, 1);
    await cleanup();
  });

  test('超过上限即 413，且不在工作区留下半个文件', async () => {
    const { root, ctx, fs, cleanup } = await makeWs();
    const svc = new DatasetService(() => fs, new InMemoryDatasetStore(), {
      roots: {
        artifactsRoot: path.join(root, 'control', 'artifacts'),
        controlRoot: path.join(root, 'control', 'root'),
      },
      maxBytes: 8,
    });
    await assert.rejects(
      () => svc.uploadStream(begin(ctx, 'big.bin'), bytes('0123456789')),
      (err: unknown) => {
        assert.equal((err as DatasetError).code, 'dataset_too_large');
        assert.equal((err as DatasetError).status, 413);
        return true;
      },
    );
    // 工作区里不该出现 datasets/ 目录——发布只在收完之后发生。
    await assert.rejects(() => readFile(path.join(ctx.workspaceRoot, 'datasets'), 'utf8'));
    await cleanup();
  });

  test('sanitizeDatasetFilename 逐条对齐 Python', () => {
    assert.equal(sanitizeDatasetFilename('../../etc/passwd'), 'passwd');
    assert.equal(sanitizeDatasetFilename('a/b/c.csv'), 'c.csv');
    assert.equal(sanitizeDatasetFilename(''), 'dataset');
    // '...' → replace('..','_') 得 '_.'，再 strip('.') 得 '_'（与 Python 逐字符一致，
    // 不是 'dataset'——只有结果为空或恰为 '.'/'..' 时才回落到 'dataset'）。
    assert.equal(sanitizeDatasetFilename('...'), '_');
    assert.equal(sanitizeDatasetFilename('.'), 'dataset');
    assert.throws(() => sanitizeDatasetFilename('/abs.csv'), DatasetError);
    assert.throws(() => sanitizeDatasetFilename('a\u0000b'), DatasetError);
    // 复合扩展名整体保留
    const long = `${'x'.repeat(300)}.tar.gz`;
    assert.ok(sanitizeDatasetFilename(long).endsWith('.tar.gz'));
    assert.ok(sanitizeDatasetFilename(long).length <= 200);
  });
});

describe('W3-B attachment', () => {
  test('upload sanitizes, checks extension, and stores via fence', async () => {
    const { ctx, fs, cleanup } = await makeWs();
    const svc = new AttachmentService(() => fs);
    const content = new TextEncoder().encode('png header');
    const rec = await svc.upload({ workspace: ctx, filename: 'photo.png', content });
    assert.equal(rec.filename, 'photo.png');
    assert.ok(rec.logicalPath.startsWith('uploads/'));
    // 物理文件确实落在 fence 内
    const target = await fs.resolve(rec.logicalPath);
    const { readFile } = await import('node:fs/promises');
    const onDisk = await readFile(target.targetKey);
    assert.deepEqual(new Uint8Array(onDisk), content);
    await cleanup();
  });

  test('bad extension rejected without leaking', async () => {
    const { ctx, fs, cleanup } = await makeWs();
    const svc = new AttachmentService(() => fs);
    await assert.rejects(
      () => svc.upload({ workspace: ctx, filename: 'evil.rar', content: new Uint8Array([1, 2]) }),
      (err: unknown) => {
        const e = err as Error & { code?: string };
        assert.equal((e as unknown as { code: string }).code, 'attachment_bad_extension');
        assert.ok(!e.message.includes(ctx.workspaceRoot));
        return true;
      },
    );
    await cleanup();
  });

  test('idempotency key returns same record without second file', async () => {
    const { ctx, fs, cleanup } = await makeWs();
    const svc = new AttachmentService(() => fs);
    const c1 = new TextEncoder().encode('first');
    const c2 = new TextEncoder().encode('second');
    const r1 = await svc.upload({ workspace: ctx, filename: 'a.txt', content: c1, idempotencyKey: 'k1' });
    const r2 = await svc.upload({ workspace: ctx, filename: 'a.txt', content: c2, idempotencyKey: 'k1' });
    assert.equal(r1.attachmentId, r2.attachmentId);
    assert.equal(r1.sizeBytes, c1.byteLength);
    await cleanup();
  });

  test('sanitizes path traversal in filename and caps length', async () => {
    const { ctx, fs, cleanup } = await makeWs();
    const svc = new AttachmentService(() => fs);
    const long = 'a'.repeat(300) + '.txt';
    const rec = await svc.upload({ workspace: ctx, filename: `../../${long}`, content: new Uint8Array([9]) });
    assert.ok(!rec.filename.includes('..'));
    assert.ok(!rec.filename.includes('/'));
    assert.ok(rec.filename.length <= 200);
    await cleanup();
  });

  test('attachment error redacts physical root even for quota failure', async () => {
    const { ctx, fs, cleanup } = await makeWs();
    // 配额极小，强制触发 quota exceeded
    const { InMemoryQuotaStore } = await import('../src/workspace/quota-store.js');
    const { InProcessWorkspaceLock } = await import('../src/workspace/lock.js');
    const { WorkspaceQuotaLedger } = await import('../src/workspace/quota-ledger.js');
    const ledger = new WorkspaceQuotaLedger(new InMemoryQuotaStore(), new InProcessWorkspaceLock(), { defaultQuotaMb: 0 });
    const svc = new AttachmentService(() => fs, ledger);
    await assert.rejects(() => svc.upload({ workspace: ctx, filename: 'x.txt', content: new Uint8Array([1, 2, 3]) }), (err: unknown) => {
      const msg = (err as Error).message;
      assert.ok(!msg.includes(ctx.workspaceRoot), `leaked: ${msg}`);
      return true;
    });
    await cleanup();
  });
});
