/**
 * exec/src/db/repositories/* 单测——仓储层收口与 DDL 固化。
 *
 * 策略：用 InMemory*Store 验证业务语义，用字符串断言验证 DDL
 * 是否包含迁移所需的列/索引；不依赖真实 MySQL，因此在 macOS
 * 无 DB 时也能全绿（_shared.md #6）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WORKSPACE_QUOTA_RESERVATIONS_DDL,
  EXEC_JOBS_DDL,
  EXEC_WORKSPACES_DDL,
  EXEC_EXECUTIONS_DDL,
  EXEC_ARTIFACTS_DDL,
  EXEC_DATASETS_DDL,
  SESSION_EVENTS_DDL,
} from '../src/db/index.js';
import { InMemoryQuotaStore } from '../src/workspace/quota-store.js';
import {
  InMemoryWorkspaceStore,
  InMemoryExecutionStore,
  InMemoryArtifactStore,
  InMemoryDatasetStore,
  InMemorySessionEventStore,
} from '../src/db/repositories/index.js';
import { sqlLimit } from '../src/db/client.js';

test('DDLs contain required columns and indexes', () => {
  // workspace_quota_reservations: W2-C 已给的 DDL，W3-D 固化
  assert.match(WORKSPACE_QUOTA_RESERVATIONS_DDL, /workspace_id/);
  assert.match(WORKSPACE_QUOTA_RESERVATIONS_DDL, /reservation_id/);
  assert.match(WORKSPACE_QUOTA_RESERVATIONS_DDL, /PRIMARY KEY.*workspace_id.*reservation_id/s);

  // exec_jobs: W2-B 已给的列清单
  assert.match(EXEC_JOBS_DDL, /process_id/);
  assert.match(EXEC_JOBS_DDL, /org_id.*user_id.*workspace_id/s);
  assert.match(EXEC_JOBS_DDL, /start_identity/);
  assert.match(EXEC_JOBS_DDL, /pgid/);

  // exec_workspaces: 后续 W3-A 需要
  assert.match(EXEC_WORKSPACES_DDL, /workspace_id/);
  assert.match(EXEC_WORKSPACES_DDL, /workspace_root/);
  assert.match(EXEC_WORKSPACES_DDL, /temp_root/);

  // exec_executions
  assert.match(EXEC_EXECUTIONS_DDL, /execution_id/);
  assert.match(EXEC_EXECUTIONS_DDL, /command/);

  // exec_artifacts / exec_datasets
  assert.match(EXEC_ARTIFACTS_DDL, /artifact_id/);
  assert.match(EXEC_ARTIFACTS_DDL, /name/);
  // 2026-08-29 扩列：公共面 ArtifactResponse 需要这两个字段，之前表里没有，
  // 所以路由只能编一个 '0'.repeat(64) 出来。
  assert.match(EXEC_ARTIFACTS_DDL, /sha256/);
  assert.match(EXEC_ARTIFACTS_DDL, /mime_type/);
  assert.match(EXEC_ARTIFACTS_DDL, /source_path/);
  assert.match(EXEC_ARTIFACTS_DDL, /identity/);
  assert.match(EXEC_ARTIFACTS_DDL, /session_id/);
  assert.match(EXEC_DATASETS_DDL, /dataset_id/);

  // session_events: ADR 0005 决策 2
  assert.match(SESSION_EVENTS_DDL, /agent_session_id/);
  assert.match(SESSION_EVENTS_DDL, /seq/);
  assert.match(SESSION_EVENTS_DDL, /PRIMARY KEY.*agent_session_id.*seq/s);
});

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

test('InMemoryWorkspaceStore: ensure is idempotent', async () => {
  const s = new InMemoryWorkspaceStore();
  const r1 = await s.ensure({
    workspaceId: 'ws1',
    orgId: 'o1',
    userId: 'u1',
    workspaceRoot: '/tmp/ws1',
    tempRoot: '/tmp/ws1-tmp',
  });
  const r2 = await s.ensure({
    workspaceId: 'ws1',
    orgId: 'o1',
    userId: 'u1',
    workspaceRoot: '/tmp/ws1',
    tempRoot: '/tmp/ws1-tmp',
  });
  assert.equal(r1.workspaceId, r2.workspaceId);
  assert.equal(r1.createdAt.getTime(), r2.createdAt.getTime());
  await s.deleteById('ws1');
  assert.equal(await s.getById('ws1'), null);
});

test('InMemoryExecutionStore: insert and updateStatus', async () => {
  const s = new InMemoryExecutionStore();
  await s.insert({
    executionId: 'e1',
    workspaceId: 'ws1',
    orgId: 'o1',
    userId: 'u1',
    command: 'echo hi',
  });
  const before = await s.getById('e1');
  assert.equal(before?.status, 'running');
  await s.updateStatus('e1', 'completed');
  const after = await s.getById('e1');
  assert.equal(after?.status, 'completed');
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

test('InMemorySessionEventStore: appendBatch and list fromSeq', async () => {
  const s = new InMemorySessionEventStore();
  await s.appendBatch([
    { agentSessionId: 'sess1', seq: 1, eventType: 'a', payloadJson: '{}' },
    { agentSessionId: 'sess1', seq: 2, eventType: 'b', payloadJson: '{}' },
    { agentSessionId: 'sess1', seq: 3, eventType: 'c', payloadJson: '{}' },
  ]);
  const all = await s.list('sess1');
  assert.equal(all.length, 3);
  const from2 = await s.list('sess1', 2);
  assert.equal(from2.length, 2);
  assert.equal(from2[0]?.seq, 2);
  assert.equal(await s.maxSeq('sess1'), 3);
  assert.equal(await s.maxSeq('unknown'), null);
});

test('re-exports: JobStore and QuotaStore are same objects as W2 definitions', async () => {
  // 确保 db 层没有另起一套接口——import 路径一致
  const { MySqlJobStore } = await import('../src/shell/job-store-mysql.js');
  const { MySqlJobStore: ReExported } = await import('../src/db/repositories/exec-jobs.js');
  assert.equal(MySqlJobStore, ReExported);
});

test('MySQL LIMIT is validated before interpolation', () => {
  assert.equal(sqlLimit(100), '100');
  assert.throws(() => sqlLimit(Number.NaN), /limit must be an integer/);
  assert.throws(() => sqlLimit(1001), /limit must be an integer/);
});
