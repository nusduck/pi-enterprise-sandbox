/**
 * `signal` 按信号种类决定语义 —— 复现测试。
 *
 * 缺陷：`MySqlJobRegistry.signalInternal` 对任何信号都先调活句柄 `cancel()`
 * 结束整个作业，再补发指定信号。于是 SIGINT / SIGHUP 这类本意不终止的信号
 * 也会结束进程，状态还被写成 `stopping`。
 *
 * 期望：
 * - 终止类信号（SIGTERM / SIGKILL / SIGQUIT）走 `cancel()` + 身份校验补发 + `stopping`（现行为）。
 * - 其他允许信号（允许集里的 SIGINT / SIGHUP）只经 `safeSignalIdentity`
 *   发给进程组，不调 `cancel`、不改状态；没有活句柄时仍抛
 *   `JobControlUnavailableError`。
 *
 * 公共路由允许集（SIGTERM / SIGKILL / SIGINT / SIGHUP）不扩大，所以这里用
 * 真实子进程 + trap 验证 SIGINT / SIGHUP（不用 SIGUSR1——它不在允许集里）。
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { JobControlUnavailableError } from '../src/shell/job-owner-access.js';
import type { JobProcessHandle } from '../src/shell/job-types.js';

const owner = { orgId: 'org1', userId: 'user1', workspaceId: 'ws1' };

interface RealHandle extends JobProcessHandle {
  readonly child: ChildProcess;
  cancelled(): boolean;
}

function spawnRealHandle(command: string): RealHandle {
  const child = spawn('bash', ['-c', command], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout?.on('data', (c: Buffer) => { output += c.toString(); });
  child.stderr?.on('data', (c: Buffer) => { output += c.toString(); });
  let cancelCalled = false;
  let doneResolve: (o: { status: 'completed' | 'killed' | 'failed'; exitCode: number | null; signal: NodeJS.Signals | null }) => void = () => {};
  const done = new Promise<{ status: 'completed' | 'killed' | 'failed'; exitCode: number | null; signal: NodeJS.Signals | null }>((res) => { doneResolve = res; });
  child.once('close', (code, signal) => {
    doneResolve({ status: 'killed', exitCode: code, signal: (signal as NodeJS.Signals | null) ?? null });
  });
  child.once('error', () => {
    doneResolve({ status: 'failed', exitCode: null, signal: null });
  });
  const handle: RealHandle = {
    child,
    pid: child.pid ?? null,
    pgid: child.pid ?? null,
    cancel: () => {
      cancelCalled = true;
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    },
    done,
    readOutput: () => {
      const delta = output;
      output = '';
      return { delta, lossy: false };
    },
    cancelled: () => cancelCalled,
  };
  return handle;
}

async function settleKill(reg: MySqlJobRegistry, h: RealHandle): Promise<void> {
  try { h.cancel(); } catch { /* ignore */ }
  await Promise.race([h.done, new Promise((r) => setTimeout(r, 3000))]);
  try { process.kill(h.child.pid!, 0); process.kill(-h.child.pid!, 'SIGKILL'); } catch { /* gone */ }
}

test('SIGHUP trapped: job keeps running and trap output appears (no cancel, no stopping)', async () => {
  const store = new InMemoryJobStore();
  const reg = new MySqlJobRegistry(store);
  const h = spawnRealHandle(`trap 'echo got-hup' HUP; while true; do sleep 0.2; done`);
  const snap = await reg.start({ kind: 'bash', label: 'trap-hup', owner, physicalRoots: [], run() { return h; } });
  try {
    await new Promise((r) => setTimeout(r, 400));
    const after = await reg.signal(snap.id, owner, 'SIGHUP');
    assert.equal(after.status, 'running', 'non-terminating signal must not move job to stopping');
    assert.equal(h.cancelled(), false, 'non-terminating signal must not call handle.cancel');
    // trap 输出最多等 3 秒出现（经 registry 对外可见）
    let seen = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const via = await reg.read(snap.id, owner, '0-0', 65536);
      if (via.text.includes('got-hup')) { seen = via.text; break; }
      seen = via.text;
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.ok(seen.includes('got-hup'), `trapped SIGHUP output missing, seen: ${JSON.stringify(seen)}`);
    const still = await reg.get(snap.id, owner);
    assert.equal(still.status, 'running', 'job must still be running after trapped SIGHUP');
  } finally {
    await settleKill(reg, h);
  }
});

test('SIGINT trapped: job keeps running (no cancel, no stopping)', async () => {
  const store = new InMemoryJobStore();
  const reg = new MySqlJobRegistry(store);
  const h = spawnRealHandle(`trap 'echo got-int' INT; while true; do sleep 0.2; done`);
  const snap = await reg.start({ kind: 'bash', label: 'trap-int', owner, physicalRoots: [], run() { return h; } });
  try {
    await new Promise((r) => setTimeout(r, 400));
    const after = await reg.signal(snap.id, owner, 'SIGINT');
    assert.equal(after.status, 'running', 'non-terminating signal must not move job to stopping');
    assert.equal(h.cancelled(), false, 'non-terminating signal must not call handle.cancel');
    await new Promise((r) => setTimeout(r, 800));
    const still = await reg.get(snap.id, owner);
    assert.equal(still.status, 'running', 'job must still be running after trapped SIGINT');
  } finally {
    await settleKill(reg, h);
  }
});

test('SIGTERM still ends the job (cancel + stopping)', async () => {
  const store = new InMemoryJobStore();
  const reg = new MySqlJobRegistry(store);
  const h = spawnRealHandle(`while true; do sleep 0.2; done`);
  const snap = await reg.start({ kind: 'bash', label: 'term', owner, physicalRoots: [], run() { return h; } });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const after = await reg.signal(snap.id, owner, 'SIGTERM');
    assert.equal(after.status, 'stopping');
    assert.equal(h.cancelled(), true, 'terminating signal must call handle.cancel');
  } finally {
    await settleKill(reg, h);
  }
});

test('SIGKILL still ends the job (cancel + stopping)', async () => {
  const store = new InMemoryJobStore();
  const reg = new MySqlJobRegistry(store);
  const h = spawnRealHandle(`while true; do sleep 0.2; done`);
  const snap = await reg.start({ kind: 'bash', label: 'kill', owner, physicalRoots: [], run() { return h; } });
  try {
    await new Promise((r) => setTimeout(r, 300));
    const after = await reg.signal(snap.id, owner, 'SIGKILL');
    assert.equal(after.status, 'stopping');
    assert.equal(h.cancelled(), true, 'terminating signal must call handle.cancel');
  } finally {
    await settleKill(reg, h);
  }
});

test('no live handle: non-terminating signal still throws JobControlUnavailableError', async () => {
  const store = new InMemoryJobStore();
  const reg = new MySqlJobRegistry(store);
  const h = spawnRealHandle(`while true; do sleep 0.2; done`);
  const snap = await reg.start({ kind: 'bash', label: 'gone', owner, physicalRoots: [], run() { return h; } });
  try {
    const reg2 = new MySqlJobRegistry(store);
    await assert.rejects(
      () => reg2.signal(snap.id, owner, 'SIGHUP'),
      (e: unknown) => e instanceof JobControlUnavailableError,
    );
  } finally {
    await settleKill(reg, h);
  }
});
