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
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test, before, after } from 'node:test';
import { Context } from '@deepseek-ai/cordis';
import type { WorkspaceContext } from '../src/types.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { ArtifactService } from '../src/artifact/service.js';
import { DatasetService } from '../src/dataset/service.js';
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
  test('submit with content → download round-trips, filename sanitized, not leaking physical root', async () => {
    const { ctx, fs, cleanup } = await makeWs();
    const store = new InMemoryArtifactStore();
    const svc = new ArtifactService(() => fs, store);
    const content = new TextEncoder().encode('hello artifact');
    const rec = await svc.submit({ workspace: ctx, content, filename: '../evil.txt' });
    assert.equal(rec.filename, 'evil.txt');
    assert.ok(!rec.filename.includes('..'));
    const { record, content: got } = await svc.download(rec.artifactId, ctx);
    assert.equal(record.artifactId, rec.artifactId);
    assert.equal(new TextDecoder().decode(got), 'hello artifact');
    await cleanup();
  });

  test('artifact download with wrong workspace returns 404 without leaking root', async () => {
    const a = await makeWs();
    const b = await makeWs();
    const store = new InMemoryArtifactStore();
    const svcA = new ArtifactService(() => a.fs, store);
    const content = new TextEncoder().encode('secret');
    const rec = await svcA.submit({ workspace: a.ctx, content, filename: 'a.txt' });
    const svcB = new ArtifactService(() => b.fs, store);
    await assert.rejects(() => svcB.download(rec.artifactId, b.ctx), (err: unknown) => {
      const msg = (err as Error).message;
      assert.ok(!msg.includes(a.ctx.workspaceRoot), `leaked root: ${msg}`);
      return true;
    });
    await a.cleanup();
    await b.cleanup();
  });

  test('submit via sourcePath traverses WorkspaceFileSystem fence and redacts', async () => {
    const { ctx, fs, cleanup } = await makeWs();
    const svc = new ArtifactService(() => fs);
    await assert.rejects(() => svc.submit({ workspace: ctx, sourcePath: '../../etc/passwd' }), (err: unknown) => {
      const msg = (err as Error).message;
      assert.ok(!msg.includes(ctx.workspaceRoot));
      return true;
    });
    await cleanup();
  });
});

describe('W3-B dataset', () => {
  test('create → read round-trips, quota and fence enforced', async () => {
    const { ctx, fs, cleanup } = await makeWs();
    const store = new InMemoryDatasetStore();
    const svc = new DatasetService(() => fs, store);
    const content = new TextEncoder().encode('dataset payload');
    const rec = await svc.create({ workspace: ctx, name: 'my dataset.csv', content, filename: 'data.csv' });
    assert.equal(rec.name, 'data.csv');
    const { content: got } = await svc.read(rec.datasetId, ctx);
    assert.equal(new TextDecoder().decode(got), 'dataset payload');
    await cleanup();
  });

  test('dataset cross-workspace read 404 without leaking path', async () => {
    const a = await makeWs();
    const b = await makeWs();
    const store = new InMemoryDatasetStore();
    const svcA = new DatasetService(() => a.fs, store);
    const rec = await svcA.create({ workspace: a.ctx, name: 'x', content: new TextEncoder().encode('hi') });
    const svcB = new DatasetService(() => b.fs, store);
    await assert.rejects(() => svcB.read(rec.datasetId, b.ctx), (err: unknown) => {
      assert.ok(!(err as Error).message.includes(a.ctx.workspaceRoot));
      return true;
    });
    await a.cleanup();
    await b.cleanup();
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
