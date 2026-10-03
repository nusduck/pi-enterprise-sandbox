/**
 * 作业输出落盘（`<controlRoot>/job-output`）的回归测试。
 *
 * 背景：`MySqlJobRegistry` 的输出只活在进程内存的 `StreamCursorBuffer`，
 * 结算后 live 条目最多保留 5 分钟 / 512 条，exec 重启后全丢；`read()` 在
 * 没有 live 条目时直接返回空文本、`lossy=false`，调用方分不清"没有新输出"
 * 和"输出已经丢了"。
 *
 * 全部在 macOS 可跑：真实 temp 目录 + `InMemoryJobStore`，不依赖 MySQL/bwrap。
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Hono } from 'hono';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { FileJobOutputStore } from '../src/shell/job-output-store.js';
import type { JobOwner, JobProcessHandle, JobStartSpec } from '../src/shell/job-types.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { createPublicRouter } from '../src/http/public/router.js';

const ownerA: JobOwner = { orgId: 'org1', userId: 'user1', workspaceId: 'ws1' };

function fakeHandle(
  overrides: Partial<JobProcessHandle> = {},
): JobProcessHandle & { triggerDone: (o: never) => void; pushOutput: (t: string) => void } {
  let doneResolve: (o: never) => void = () => {};
  const done = new Promise<never>((res) => {
    doneResolve = res as (o: never) => void;
  });
  let outputText = '';
  const handle = {
    pid: 1000 + Math.floor(Math.random() * 1000),
    pgid: undefined,
    cancel: (_reason?: string) => {},
    done,
    readOutput: () => {
      if (!outputText) return { delta: '', lossy: false };
      const delta = outputText;
      outputText = '';
      return { delta, lossy: false };
    },
    writeStdin: (_data: string, _eof: boolean) => {},
    ...overrides,
  } as unknown as JobProcessHandle & { triggerDone: (o: never) => void; pushOutput: (t: string) => void };
  handle.triggerDone = (outcome: never) => doneResolve(outcome);
  handle.pushOutput = (text: string) => {
    outputText += text;
  };
  return handle;
}

async function settleAndEvict(reg: MySqlJobRegistry, id: string, owner: JobOwner): Promise<void> {
  // 调用方已先触发 handle.done；这里轮询等结算完成（settle 内会 await 落盘，
  // 所以返回时文件一定已写好；settledRetentionMs=0 时条目同时已被回收）。
  const deadline = Date.now() + 5000;
  for (;;) {
    const snap = await reg.get(id, owner);
    if (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'killed') break;
    if (Date.now() > deadline) throw new Error(`job ${id} did not settle in time`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('job output persistence (job-output-store + registry)', () => {
  let base: string;

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), 'dsh-job-output-'));
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  test('超过保留窗口后 read 仍能读到完整输出，游标续读不重复', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-'));
    const store = new InMemoryJobStore();
    const reg = new MySqlJobRegistry(store, {
      settledRetentionMs: 0,
      jobOutputDir: path.join(controlRoot, 'job-output'),
    });
    const h = fakeHandle();
    const snap = await reg.start({
      kind: 'bash',
      label: 'echo hi',
      owner: ownerA,
      physicalRoots: [],
      run() {
        return h;
      },
    } satisfies JobStartSpec);
    h.pushOutput('hello world\n');
    // 先 live 读一次，把输出刷进 buffer（同时触发一次节流落盘）。
    const live = await reg.read(snap.id, ownerA, null, 1000);
    assert.match(live.text, /hello world/);
    h.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(reg, snap.id, ownerA);
    assert.equal(reg.liveEntryCount(), 0, 'settled entry must be evicted with retention 0');

    const r1 = await reg.read(snap.id, ownerA, null, 1000);
    assert.match(r1.text, /hello world/, 'evicted job must still serve persisted output');
    assert.equal(r1.lossy, false);
    assert.ok(!('outputUnavailable' in r1) || r1.outputUnavailable !== true);
    // 游标续读：用 nextCursor 再读必须为空且不重复。
    const r2 = await reg.read(snap.id, ownerA, r1.nextCursor, 1000);
    assert.equal(r2.text, '');
    assert.equal(r2.lossy, false);
    assert.ok(!('outputUnavailable' in r2) || r2.outputUnavailable !== true);
  });

  test('模拟 exec 重启：新 registry 同 store 同控制根仍能读到输出', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-restart-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const store = new InMemoryJobStore();
    const reg1 = new MySqlJobRegistry(store, { settledRetentionMs: 0, jobOutputDir: outputDir });
    const h = fakeHandle();
    const snap = await reg1.start({
      kind: 'bash',
      label: 'restart-me',
      owner: ownerA,
      physicalRoots: [],
      run() {
        return h;
      },
    } satisfies JobStartSpec);
    h.pushOutput('survive restart\n');
    await reg1.read(snap.id, ownerA, null, 1000);
    h.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(reg1, snap.id, ownerA);

    // 重启：live 内存全丢，只剩同一个 store 与同一个控制根。
    const reg2 = new MySqlJobRegistry(store, { settledRetentionMs: 0, jobOutputDir: outputDir });
    const r = await reg2.read(snap.id, ownerA, null, 1000);
    assert.match(r.text, /survive restart/);
    assert.equal(r.lossy, false);
    assert.ok(r.outputUnavailable !== true);
  });

  test('超过上限丢最老数据、generation 前进，行为与内存缓冲一致', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-trunc-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const store = new InMemoryJobStore();
    const reg = new MySqlJobRegistry(store, {
      settledRetentionMs: 60_000,
      maxOutputBytes: 10,
      jobOutputDir: outputDir,
    });
    const h = fakeHandle();
    const snap = await reg.start({
      kind: 'bash',
      label: 'big',
      owner: ownerA,
      physicalRoots: [],
      run() {
        return h;
      },
    } satisfies JobStartSpec);
    h.pushOutput('0123456789ABCDEF'); // 16B > 10B，只留尾部 10B
    const liveStale = await reg.read(snap.id, ownerA, '0-0', 100);
    assert.equal(liveStale.lossy, true);
    assert.equal(liveStale.text, '6789ABCDEF');
    assert.match(liveStale.nextCursor, /^1-/);
    // 落后的游标在内存缓冲里的行为先记下来。
    const liveBehind = await reg.read(snap.id, ownerA, '0-5', 100);

    h.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(reg, snap.id, ownerA);
    // 换一个"重启后"的 registry，只从文件恢复。
    const reg2 = new MySqlJobRegistry(store, {
      settledRetentionMs: 0,
      maxOutputBytes: 10,
      jobOutputDir: outputDir,
    });
    const r1 = await reg2.read(snap.id, ownerA, '0-0', 100);
    assert.equal(r1.text, liveStale.text);
    assert.equal(r1.lossy, true);
    assert.equal(r1.nextCursor, liveStale.nextCursor);
    const r2 = await reg2.read(snap.id, ownerA, '0-5', 100);
    assert.equal(r2.text, liveBehind.text);
    assert.equal(r2.lossy, liveBehind.lossy);
    assert.equal(r2.nextCursor, liveBehind.nextCursor);
  });

  test('文件缺失或损坏时返回 outputUnavailable=true、lossy=true', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-missing-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const store = new InMemoryJobStore();
    const reg = new MySqlJobRegistry(store, { settledRetentionMs: 0, jobOutputDir: outputDir });
    const h = fakeHandle();
    const snap = await reg.start({
      kind: 'bash',
      label: 'gone',
      owner: ownerA,
      physicalRoots: [],
      run() {
        return h;
      },
    } satisfies JobStartSpec);
    h.pushOutput('will be deleted\n');
    await reg.read(snap.id, ownerA, null, 1000);
    h.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(reg, snap.id, ownerA);

    // 缺失：删掉落盘文件。
    await unlink(path.join(outputDir, `${snap.id}.log`));
    await unlink(path.join(outputDir, `${snap.id}.meta.json`));
    const missing = await reg.read(snap.id, ownerA, null, 1000);
    assert.equal(missing.text, '');
    assert.equal(missing.lossy, true);
    assert.equal(missing.outputUnavailable, true);

    // 损坏：meta 写进非法 JSON 后同样标记不可用。
    const h2 = fakeHandle();
    const snap2 = await reg.start({
      kind: 'bash',
      label: 'corrupt',
      owner: ownerA,
      physicalRoots: [],
      run() {
        return h2;
      },
    } satisfies JobStartSpec);
    h2.pushOutput('will be corrupted\n');
    await reg.read(snap2.id, ownerA, null, 1000);
    h2.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(reg, snap2.id, ownerA);
    await writeFile(path.join(outputDir, `${snap2.id}.meta.json`), 'not-json{{{');
    const corrupt = await reg.read(snap2.id, ownerA, null, 1000);
    assert.equal(corrupt.text, '');
    assert.equal(corrupt.lossy, true);
    assert.equal(corrupt.outputUnavailable, true);
  });

  test('jobId 含 ../ 等非法字符时不会读写控制根之外的文件', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-traversal-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const fileStore = new FileJobOutputStore(outputDir, { maxBytes: 100 });
    const evil = '../../evil-escape';
    await fileStore.save(evil, { generation: 0, baseOffset: 0, total: 3, truncated: false }, 'x', []);
    const loaded = await fileStore.load(evil, 100);
    assert.equal(loaded.ok, false);
    // 控制根之外没有产生文件：父目录里除了 controlRoot 本身别无他物。
    const siblings = await readdir(base);
    assert.ok(
      !siblings.includes('evil-escape') && !siblings.includes('evil-escape.log'),
      `traversal must not escape control root, siblings: ${siblings.join(',')}`,
    );
    // 请求非法 id 建作业直接拒绝（现有 newJobId 字符集校验）。
    const store = new InMemoryJobStore();
    const reg = new MySqlJobRegistry(store, { jobOutputDir: outputDir });
    await assert.rejects(
      () =>
        reg.start({
          id: 'bash-../../evil',
          kind: 'bash',
          label: 'evil',
          owner: ownerA,
          physicalRoots: [],
          run() {
            return fakeHandle();
          },
        } satisfies JobStartSpec),
      /invalid requested job id/,
    );
    // 非法 id 读作业：归属层即 404，且不会在控制根外留下任何文件。
    await assert.rejects(() => reg.read('../evil', ownerA, null, 100), /not found|JOB_NOT_FOUND/i);
    const after = await readdir(base);
    assert.deepEqual(after.sort(), siblings.sort());
  });

  test('工作区删除后对应输出文件被删除，另一个工作区不受影响', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-gc-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const wsBase = await mkdtemp(path.join(base, 'ws-'));
    const workspaceManager = new WorkspaceManager({
      workspacesBaseRoot: path.join(wsBase, 'workspaces'),
      tempBaseRoot: path.join(wsBase, 'tmp'),
    });
    const store = new InMemoryJobStore();
    const jobRegistry = new MySqlJobRegistry(store, { jobOutputDir: outputDir });
    const app: Hono = createPublicRouter({
      apiToken: null,
      workspaceManager,
      systemSkillRoot: path.join(wsBase, 'skills'),
      enabledSkillPackagesFor: () => [],
      jobRegistry,
    });

    const actingA = { 'x-acting-organization-id': 'org1', 'x-acting-user-id': 'user1' };
    const sessionA = 'pub_sessout_del_a_1';
    const sessionB = 'pub_sessout_del_b_1';
    await workspaceManager.initWorkspace(sessionA);
    await workspaceManager.initWorkspace(sessionB);
    const ownerWsA: JobOwner = { orgId: 'org1', userId: 'user1', workspaceId: sessionA };
    const ownerWsB: JobOwner = { orgId: 'org1', userId: 'user1', workspaceId: sessionB };

    const ha = fakeHandle();
    const snapA = await jobRegistry.start({
      kind: 'bash',
      label: 'job-a',
      owner: ownerWsA,
      physicalRoots: [],
      run() {
        return ha;
      },
    } satisfies JobStartSpec);
    const hb = fakeHandle();
    const snapB = await jobRegistry.start({
      kind: 'bash',
      label: 'job-b',
      owner: ownerWsB,
      physicalRoots: [],
      run() {
        return hb;
      },
    } satisfies JobStartSpec);
    ha.pushOutput('output A\n');
    hb.pushOutput('output B\n');
    await jobRegistry.read(snapA.id, ownerWsA, null, 1000);
    await jobRegistry.read(snapB.id, ownerWsB, null, 1000);
    ha.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    hb.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(jobRegistry, snapA.id, ownerWsA);
    await settleAndEvict(jobRegistry, snapB.id, ownerWsB);
    // 对照组：B 的输出文件确实存在且可读。
    const beforeB = await readFile(path.join(outputDir, `${snapB.id}.log`), 'utf8');
    assert.match(beforeB, /output B/);

    const res = await app.request(`/sessions/${sessionA}`, { method: 'DELETE', headers: actingA });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { removed: true });

    const remaining = await readdir(outputDir).catch(() => [] as string[]);
    assert.ok(!remaining.includes(`${snapA.id}.log`), `A 的输出必须被删: ${remaining.join(',')}`);
    assert.ok(!remaining.includes(`${snapA.id}.meta.json`), `A 的元数据必须被删: ${remaining.join(',')}`);
    assert.ok(remaining.includes(`${snapB.id}.log`), `B 的输出必须保留: ${remaining.join(',')}`);
    const afterB = await readFile(path.join(outputDir, `${snapB.id}.log`), 'utf8');
    assert.equal(afterB, beforeB);
  });

  test('运行中从未被 read 的作业：定时器落盘后新 registry 仍能读到输出', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-live-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const store = new InMemoryJobStore();
    const reg1 = new MySqlJobRegistry(store, {
      settledRetentionMs: 60_000,
      persistMinIntervalMs: 20,
      jobOutputDir: outputDir,
    });
    const h = fakeHandle();
    const snap = await reg1.start({
      kind: 'bash',
      label: 'live-no-read',
      owner: ownerA,
      physicalRoots: [],
      run() {
        return h;
      },
    } satisfies JobStartSpec);
    h.pushOutput('live without read\n');
    // 全程不调 reg1.read：只有后台定时器能把输出搬进 buffer 并落盘。
    // 轮询等落盘文件出现（间隔 20ms，最多等 3s）。
    const deadline = Date.now() + 3000;
    let found = false;
    for (;;) {
      const files = await readdir(outputDir).catch(() => [] as string[]);
      if (files.includes(`${snap.id}.log`) && files.includes(`${snap.id}.meta.json`)) {
        found = true;
        break;
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(found, 'timer must persist running job output without any read()');

    // 模拟 exec 重启：全新 registry 实例（无 live 内存），共用同一个 store 和目录。
    // 重试读：落盘是 log→meta 两步 rename，极小概率撞上中间态（读到 corrupt），
    // 定时器无新输出时不再重写，稍后重试即稳定。
    const reg2 = new MySqlJobRegistry(store, {
      settledRetentionMs: 0,
      persistMinIntervalMs: 20,
      jobOutputDir: outputDir,
    });
    let text = '';
    let unavailable: boolean | undefined;
    const readDeadline = Date.now() + 3000;
    for (;;) {
      const r = await reg2.read(snap.id, ownerA, null, 1000);
      text = r.text;
      unavailable = r.outputUnavailable;
      if (text.includes('live without read')) break;
      if (Date.now() > readDeadline) break;
      await new Promise((r2) => setTimeout(r2, 20));
    }
    assert.match(text, /live without read/, 'restarted registry must serve timer-persisted output');
    assert.ok(unavailable !== true, 'persisted output must not be reported unavailable');

    // 收尾：结算 reg1（清定时器），避免泄漏到别的测试。
    h.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(reg1, snap.id, ownerA);
  });

  test('结算后定时器已清除：readOutput 不再被调用、文件不再变化', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-timer-stop-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const store = new InMemoryJobStore();
    const reg = new MySqlJobRegistry(store, {
      settledRetentionMs: 60_000,
      persistMinIntervalMs: 20,
      jobOutputDir: outputDir,
    });
    const h = fakeHandle();
    let readCalls = 0;
    const origRead = h.readOutput.bind(h);
    h.readOutput = () => {
      readCalls += 1;
      return origRead();
    };
    const snap = await reg.start({
      kind: 'bash',
      label: 'timer-stop',
      owner: ownerA,
      physicalRoots: [],
      run() {
        return h;
      },
    } satisfies JobStartSpec);
    h.pushOutput('timer stop\n');
    // 先等定时器至少跑过一次（文件出现），证明定时器起过；全程不调 read。
    const deadline = Date.now() + 3000;
    let found = false;
    for (;;) {
      const files = await readdir(outputDir).catch(() => [] as string[]);
      if (files.includes(`${snap.id}.log`) && files.includes(`${snap.id}.meta.json`)) {
        found = true;
        break;
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(found, 'timer must persist running job output before settle');

    h.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(reg, snap.id, ownerA);
    const callsAfterSettle = readCalls;
    assert.ok(callsAfterSettle > 0, 'readOutput must have been called at least once before settle');
    const logPath = path.join(outputDir, `${snap.id}.log`);
    const before = await stat(logPath);
    // 若干个 20ms 间隔后：定时器若还活着，一定会再调 readOutput / 重写文件。
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(readCalls, callsAfterSettle, 'timer must stop calling readOutput after settle');
    const after = await stat(logPath);
    assert.equal(after.mtimeMs, before.mtimeMs, 'output file must not be rewritten after settle');
  });

  test('输出不变时定时器不重复写盘', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-norewrite-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const store = new InMemoryJobStore();
    const reg = new MySqlJobRegistry(store, {
      settledRetentionMs: 60_000,
      persistMinIntervalMs: 20,
      jobOutputDir: outputDir,
    });
    const h = fakeHandle();
    const snap = await reg.start({
      kind: 'bash',
      label: 'no-rewrite',
      owner: ownerA,
      physicalRoots: [],
      run() {
        return h;
      },
    } satisfies JobStartSpec);
    h.pushOutput('stable output\n');
    // 全程不调 read：等第一次定时落盘（文件出现即证据）。
    const deadline = Date.now() + 3000;
    const logPath = path.join(outputDir, `${snap.id}.log`);
    let found = false;
    for (;;) {
      const files = await readdir(outputDir).catch(() => [] as string[]);
      if (files.includes(`${snap.id}.log`) && files.includes(`${snap.id}.meta.json`)) {
        found = true;
        break;
      }
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(found, 'timer must persist running job output without any read()');
    // 落盘后静置：无新输出、无 read，若干个间隔内 mtime 必须纹丝不动。
    await new Promise((r) => setTimeout(r, 100));
    const before = await stat(logPath);
    await new Promise((r) => setTimeout(r, 200));
    const after = await stat(logPath);
    assert.equal(after.mtimeMs, before.mtimeMs, 'timer must skip persist when buffer total unchanged');

    // 收尾。
    h.triggerDone({ status: 'completed', exitCode: 0, signal: null });
    await settleAndEvict(reg, snap.id, ownerA);
  });
  test('read() 与定时器并发落盘：结算后的文件完整、不被判为损坏', async () => {
    const controlRoot = await mkdtemp(path.join(base, 'control-race-'));
    const outputDir = path.join(controlRoot, 'job-output');
    const store = new InMemoryJobStore();
    const reg = new MySqlJobRegistry(store, {
      settledRetentionMs: 0,
      persistMinIntervalMs: 1,
      jobOutputDir: outputDir,
    });
    const h = fakeHandle();
    const snap = await reg.start({
      kind: 'bash', label: 'race', owner: ownerA, physicalRoots: [],
      run() { return h; },
    } satisfies JobStartSpec);
    let expected = '';
    for (let i = 0; i < 40; i++) {
      const line = `line-${i}\n`;
      expected += line;
      h.pushOutput(line);
      await Promise.all([reg.read(snap.id, ownerA, null, 1_000_000), reg.read(snap.id, ownerA, null, 1_000_000)]);
      await new Promise((r) => setTimeout(r, 1));
    }
    h.triggerDone({ status: 'completed', exitCode: 0, signal: null } as never);
    await settleAndEvict(reg, snap.id, ownerA);
    const reg2 = new MySqlJobRegistry(store, { jobOutputDir: outputDir });
    const r = await reg2.read(snap.id, ownerA, null, 1_000_000);
    assert.ok(r.outputUnavailable !== true, 'serialized writes must leave a consistent log/meta pair');
    assert.equal(r.text, expected);
  });
});
