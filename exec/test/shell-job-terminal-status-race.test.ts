/**
 * 终态不被 `stopping` 覆盖——复现测试。
 *
 * 2026-10-03 集成真机：在进程控制台取消一个后台进程后，exec_jobs 行 `finished_at` 已写、`status` 却停在
 * `stopping`，界面一直显示运行中。根因：`signalInternal` 先 `handle.cancel()`，进程很快退出、结算把状态写成
 * `killed`，随后 `signalInternal` 再无条件写 `stopping`，覆盖了终态。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import type { JobProcessHandle } from '../src/shell/job-types.js';

const owner = { orgId: 'org1', userId: 'user1', workspaceId: 'ws1' };

/** cancel() 立刻让作业结算为 killed——模拟「进程很快退出」。 */
function quickExitHandle(): JobProcessHandle {
  let resolveDone: (o: unknown) => void = () => {};
  const done = new Promise((res) => { resolveDone = res; });
  return {
    pid: undefined,
    pgid: undefined,
    done,
    cancel: () => resolveDone({ status: 'killed', exitCode: null, signal: 'SIGTERM' }),
    readOutput: () => ({ delta: '', lossy: false }),
    writeStdin: () => {},
  } as unknown as JobProcessHandle;
}

async function settle() {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
}

test('a job that settles during signal keeps its terminal status (not overwritten by stopping)', async () => {
  const store = new InMemoryJobStore();
  const reg = new MySqlJobRegistry(store);
  const snap = await reg.start({ kind: 'bash', label: 'loop', owner, physicalRoots: [], run: () => quickExitHandle() });
  await reg.signal(snap.id, owner, 'SIGTERM');
  await settle();
  const rec = await store.getById(snap.id, owner);
  assert.equal(rec?.status, 'killed', `status was ${rec?.status}`);
  assert.ok(rec?.finishedAt, 'finished_at is set');
});

test('store: a non-terminal status never overwrites a terminal one; terminal over running still works', async () => {
  const store = new InMemoryJobStore();
  const reg = new MySqlJobRegistry(store);
  let resolveDone: (o: unknown) => void = () => {};
  const handle = {
    pid: undefined, pgid: undefined,
    done: new Promise((res) => { resolveDone = res; }),
    cancel: () => {}, readOutput: () => ({ delta: '', lossy: false }), writeStdin: () => {},
  } as unknown as JobProcessHandle;
  const snap = await reg.start({ kind: 'bash', label: 'x', owner, physicalRoots: [], run: () => handle });

  // 对照：运行中可以改成 stopping
  await store.updateStatus(snap.id, owner, { status: 'stopping', detail: 'signal SIGTERM' });
  assert.equal((await store.getById(snap.id, owner))?.status, 'stopping');

  resolveDone({ status: 'completed', exitCode: 0, signal: null });
  await settle();
  assert.equal((await store.getById(snap.id, owner))?.status, 'completed');

  await store.updateStatus(snap.id, owner, { status: 'stopping', detail: 'late signal' });
  const rec = await store.getById(snap.id, owner);
  assert.equal(rec?.status, 'completed', 'terminal status survives a late stopping write');
  assert.notEqual(rec?.detail, 'late signal');
});
