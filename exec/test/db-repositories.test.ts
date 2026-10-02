/**
 * exec 仓储单测——直接测真实入口（具体模块），不经过已删除的 DB 收口 barrel。
 *
 * 建表 DDL 的权威在 `agent/src/infrastructure/mysql/migrations/`，exec 侧不再
 * 维护重复的 DDL 常量；这里只验证 InMemory*Store 的业务语义与 `sqlLimit`。
 * 不依赖真实 MySQL，因此在 macOS 无 DB 时也能全绿。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryQuotaStore } from '../src/workspace/quota-store.js';
import { InMemoryArtifactStore } from '../src/db/repositories/artifacts.js';
import { InMemoryDatasetStore } from '../src/db/repositories/datasets.js';
import { sqlLimit } from '../src/db/client.js';

test('InMemoryQuotaStore: sumReserved / put / delete', async () => {
  const s = new InMemoryQuotaStore();
  assert.equal(await s.sumReserved('ws1'), 0);
  await s.putReservation('ws1', 'r1', 100);
  await s.putReservation('ws1', 'r2', 200);
  assert.equal(await s.sumReserved('ws1'), 300);
  await s.deleteReservation('ws1', 'r1');
  assert.equal(await s.sumReserved('ws1'), 200);
  assert.equal(await s.getReservationBytes('ws1', 'r1'), 0);
});

test('InMemoryArtifactStore: 按 session + owner 列举，跨租户当作不存在', async () => {
  const s = new InMemoryArtifactStore();
  const base = {
    sessionId: 'sess1',
    workspaceId: 'ws1',
    orgId: 'o1',
    userId: 'u1',
    sourcePath: 'out.txt',
    mimeType: 'text/plain',
    sha256: 'a'.repeat(64),
    identity: null,
  };
  await s.insert({ ...base, artifactId: 'a1', name: 'out.txt', sizeBytes: 123 });
  await s.insert({ ...base, artifactId: 'a2', name: 'b.txt', sizeBytes: 456 });

  const owner = { orgId: 'o1', userId: 'u1' };
  const list = await s.listBySession('sess1', owner, 10);
  assert.equal(list.length, 2);
  assert.equal(await s.getOwned('a1', owner).then((r) => r?.name), 'out.txt');

  // 换一个租户：getOwned 必须返回 null（不是"找到了但拒绝"——那会泄漏存在性），
  // listBySession 必须为空。
  const other = { orgId: 'o2', userId: 'u2' };
  assert.equal(await s.getOwned('a1', other), null);
  assert.deepEqual(await s.listBySession('sess1', other, 10), []);
});

test('InMemoryDatasetStore: 幂等键查得到，跨租户当作不存在', async () => {
  const s = new InMemoryDatasetStore();
  const base = {
    sessionId: 'sess1',
    conversationId: 'conv1',
    workspaceId: 'ws1',
    orgId: 'o1',
    userId: 'u1',
    originalFilename: 'd.csv',
    storedRelativePath: 'datasets/d1/d.csv',
    mimeType: 'text/csv',
    sha256: null,
    sizeBytes: 0,
    status: 'uploading' as const,
    completedAt: null,
  };
  await s.insert({ ...base, datasetId: 'd1', idempotencyKey: 'k1' });

  const owner = { orgId: 'o1', userId: 'u1' };
  assert.equal(await s.getOwned('d1', owner).then((r) => r?.originalFilename), 'd.csv');
  assert.equal(await s.findByIdempotencyKey('sess1', owner, 'k1').then((r) => r?.datasetId), 'd1');
  assert.equal(await s.findByIdempotencyKey('sess1', owner, 'nope'), null);

  await s.complete('d1', {
    sha256: 'b'.repeat(64),
    sizeBytes: 42,
    status: 'ready',
    completedAt: new Date(),
  });
  const done = await s.getOwned('d1', owner);
  assert.equal(done?.status, 'ready');
  assert.equal(done?.sizeBytes, 42);

  const other = { orgId: 'o2', userId: 'u2' };
  assert.equal(await s.getOwned('d1', other), null);
  assert.equal(await s.findByIdempotencyKey('sess1', other, 'k1'), null);
});

test('MySQL LIMIT is validated before interpolation', () => {
  assert.equal(sqlLimit(100), '100');
  assert.throws(() => sqlLimit(Number.NaN), /limit must be an integer/);
  assert.throws(() => sqlLimit(1001), /limit must be an integer/);
});
