/**
 * 内部 Shell 路由 → 执行器 → runner 的**接线**回归（2026-09-16 审查 R1/R2/R4）。
 *
 * 审查时的隔离探针证实了三件事，这里把它们翻成「预期正确行为」的断言：
 * 1. R4：`workdir`/`stdin`/`env`/`stdoutMaxBytes` 曾被路由静默丢弃，HTTP 仍 200。
 * 2. R1：执行器从没收到过 `maxProcessCount`，Compose 声明的 20 从未生效；
 *    `evaluateChildQuota` / `ChildWorkspaceQuotaWatch` 从没有任何调用方。
 * 3. R2：请求断开到不了执行面，前台命令会在客户端放弃之后继续跑。
 *
 * 全部走内存路径：不连 MySQL、不起 bwrap，macOS 可跑。真实进程行为由
 * `isolation-*.test.ts` 的 argv 断言与容器内真机验证覆盖。
 */

import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import type { ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell';
import { registerInternalShellRoutes } from '../src/http/internal-shell.js';
import { IsolatedShellExecutor } from '../src/shell/executor.js';
import { MySqlJobRegistry } from '../src/shell/job-registry.js';
import { InMemoryJobStore } from '../src/shell/job-store-memory.js';
import { DEFAULT_SHELL_RESOURCE_LIMITS } from '../src/shell/resource-limits.js';
import type { ChildQuotaConfig } from '../src/workspace/child-quota.js';
import { InMemoryQuotaStore, type QuotaStore } from '../src/workspace/quota-store.js';
import { WorkspaceManager } from '../src/workspace/manager.js';

const ENVELOPE = {
  requestId: 'req-1',
  orgId: 'org_a',
  userId: 'user_a',
  workspaceId: 'ws_a',
  fenceToken: 1,
};

interface Harness {
  readonly app: Hono;
  readonly cleanup: () => Promise<void>;
}

async function makeHarness(
  overrides: {
    childQuota?: ChildQuotaConfig;
    resourceLimits?: typeof DEFAULT_SHELL_RESOURCE_LIMITS;
    quotaStore?: QuotaStore;
  } = {},
): Promise<Harness> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'exec-shell-wiring-')));
  const workspaceManager = new WorkspaceManager({
    workspacesBaseRoot: join(base, 'workspaces'),
    tempBaseRoot: join(base, 'tmp'),
  });
  const app = new Hono();
  registerInternalShellRoutes(app, {
    workspaceManager,
    jobRegistry: new MySqlJobRegistry(new InMemoryJobStore()),
    systemSkillRoot: join(base, 'skills'),
    enabledSkillPackagesFor: () => [],
    bwrapExecutable: '/unused',
    modeFor: () => 'workspace-write',
    resourceLimits: overrides.resourceLimits ?? DEFAULT_SHELL_RESOURCE_LIMITS,
    ...(overrides.childQuota !== undefined ? { childQuota: overrides.childQuota } : {}),
    quotaStore: overrides.quotaStore ?? new InMemoryQuotaStore(),
  });
  return { app, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function post(app: Hono, path: string, payload: unknown): Promise<Response> {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ envelope: ENVELOPE, payload }),
  });
}

/** 替换执行入口，记录路由真正交给执行器的 spec 与执行器自身的限额。 */
async function captureRun<T>(
  impl: (this: IsolatedShellExecutor, spec: ShellExecSpec) => Promise<ShellRunResult>,
  body: () => Promise<T>,
): Promise<T> {
  const original = IsolatedShellExecutor.prototype.run;
  IsolatedShellExecutor.prototype.run = impl;
  try {
    return await body();
  } finally {
    IsolatedShellExecutor.prototype.run = original;
  }
}

function emptyResult(spec: ShellExecSpec): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: spec.timeoutMs,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: { mode: 'workspace-write', denied: false },
  };
}

test('run: workdir/stdin/env/stdoutMaxBytes 传到执行器，不再被静默丢弃', async () => {
  const h = await makeHarness();
  try {
    let seen: ShellExecSpec | undefined;
    let target: ReturnType<IsolatedShellExecutor['spawnTargetFor']> | undefined;
    const res = await captureRun(
      async function (this: IsolatedShellExecutor, spec) {
        seen = spec;
        target = this.spawnTargetFor(['bash', '-c', spec.command], spec);
        return emptyResult(spec);
      },
      () =>
        post(h.app, '/internal/v1/shell/run', {
          command: 'pwd',
          workdir: '/home/sandbox/workspace/subdir',
          stdin: 'hello',
          env: { REVIEW: 'yes' },
          stdoutMaxBytes: 123,
          timeoutMs: 30_000,
        }),
    );
    assert.equal(res.status, 200);
    assert.equal(seen?.workdir, '/home/sandbox/workspace/subdir');
    assert.equal(seen?.stdin, 'hello');
    assert.deepEqual(seen?.env, { REVIEW: 'yes' });
    assert.equal(seen?.stdoutMaxBytes, 123);
    assert.equal(seen?.timeoutMs, 30_000);
    // 真正决定 bwrap `--chdir` 的是 SpawnTarget，不是 spec 上那个字符串。
    assert.equal(target?.relativeCwd, 'subdir');
    assert.equal(target?.cwdScope, 'workspace');
    assert.equal(target?.stdin, 'hello');
    assert.equal(target?.envOverrides['REVIEW'], 'yes');
  } finally {
    await h.cleanup();
  }
});

test('run: 资源限额从装配传到执行器与 SpawnTarget', async () => {
  const limits = {
    executionTimeoutMs: 60_000,
    maxOutputChars: 1_000,
    maxProcessCount: 20,
    rlimits: { maxOpenFiles: 256, cpuSeconds: 300, fileSizeKb: 51_200 },
    containerMemoryBackstopMb: 512,
  };
  const h = await makeHarness({ resourceLimits: limits });
  try {
    let target: ReturnType<IsolatedShellExecutor['spawnTargetFor']> | undefined;
    const res = await captureRun(
      async function (this: IsolatedShellExecutor, spec) {
        assert.equal(this.maxProcessCount, 20);
        assert.equal(this.defaultTimeoutMs, 60_000);
        assert.equal(this.outputCapChars, 1_000);
        target = this.spawnTargetFor(['bash', '-c', spec.command], spec);
        return emptyResult(spec);
      },
      () => post(h.app, '/internal/v1/shell/run', { command: 'pwd' }),
    );
    assert.equal(res.status, 200);
    assert.equal(target?.maxProcessCount, 20);
    assert.deepEqual(target?.rlimits, { maxOpenFiles: 256, cpuSeconds: 300, fileSizeKb: 51_200 });
  } finally {
    await h.cleanup();
  }
});

test('run: 越界 workdir 与非法字段在执行前被拒绝（400），合法对照仍然成功', async () => {
  const h = await makeHarness();
  try {
    await captureRun(
      async function (this: IsolatedShellExecutor, spec) {
        assert.fail(`executor must not run for a rejected payload: ${spec.command}`);
      },
      async () => {
        for (const bad of [
          { command: 'pwd', workdir: '/etc' },
          { command: 'pwd', workdir: '/home/sandbox/workspace/../../etc' },
          { command: 'pwd', timeoutMs: 'soon' },
          { command: 'pwd', env: { '1BAD': 'v' } },
          { command: 'pwd', stdoutMaxBytes: -1 },
        ]) {
          const res = await post(h.app, '/internal/v1/shell/run', bad);
          assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
          const body = (await res.json()) as { ok: boolean; error: { code: string } };
          assert.equal(body.ok, false);
          assert.equal(body.error.code, 'ENVELOPE_INVALID');
        }
      },
    );

    // 拒绝对照之外必须有一条合法对照成功，否则「全部拒绝」也能假通过。
    const ok = await captureRun(
      async function (this: IsolatedShellExecutor, spec) {
        return emptyResult(spec);
      },
      () => post(h.app, '/internal/v1/shell/run', { command: 'pwd', workdir: '/tmp/build' }),
    );
    assert.equal(ok.status, 200);
  } finally {
    await h.cleanup();
  }
});

test('run: 超过服务端执行预算的 timeoutMs 被拒绝，预算内的通过', async () => {
  const h = await makeHarness({
    resourceLimits: { ...DEFAULT_SHELL_RESOURCE_LIMITS, executionTimeoutMs: 60_000 },
  });
  try {
    const tooLong = await post(h.app, '/internal/v1/shell/run', {
      command: 'sleep 1',
      timeoutMs: 60_001,
    });
    assert.equal(tooLong.status, 400);

    const ok = await captureRun(
      async function (this: IsolatedShellExecutor, spec) {
        assert.equal(spec.timeoutMs, 60_000);
        return emptyResult(spec);
      },
      () => post(h.app, '/internal/v1/shell/run', { command: 'sleep 1', timeoutMs: 60_000 }),
    );
    assert.equal(ok.status, 200);
  } finally {
    await h.cleanup();
  }
});

test('run: 请求断开进入执行的 AbortSignal', async () => {
  const h = await makeHarness();
  try {
    const client = new AbortController();
    let aborted = false;
    const res = await captureRun(
      async function (this: IsolatedShellExecutor, spec) {
        // 模拟一条仍在执行的命令：只在收到取消时才结算。
        await new Promise<void>((resolve) => {
          spec.signal?.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
          client.abort();
        });
        return { ...emptyResult(spec), aborted: true };
      },
      () =>
        h.app.request('/internal/v1/shell/run', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ envelope: ENVELOPE, payload: { command: 'sleep 60' } }),
          signal: client.signal,
        }),
    );
    assert.equal(aborted, true, 'client disconnect must reach the execution signal');
    assert.equal(res.status, 200);
  } finally {
    await h.cleanup();
  }
});

test('run: 配额超额时 fail-closed——不 spawn，把原因交给模型', async () => {
  // 工作区树是空的，所以用**预留量**制造超额：控制面账本里已经占了 5 MB，
  // 配额只有 1 MB。这条路径与真实超额走的是同一个 `evaluateChildQuota`。
  const overReserved: QuotaStore = {
    sumReserved: async () => 5 * 1024 * 1024,
    getReservationBytes: async () => 0,
    putReservation: async () => undefined,
    deleteReservation: async () => undefined,
  };
  const h = await makeHarness({
    childQuota: { enforcement: true, workspaceQuotaMb: 1, tempQuotaMb: 0 },
    quotaStore: overReserved,
  });
  try {
    const res = await captureRun(
      async function (this: IsolatedShellExecutor, spec) {
        assert.fail(`executor must not run when quota admission denies: ${spec.command}`);
      },
      () => post(h.app, '/internal/v1/shell/run', { command: 'dd if=/dev/zero of=big' }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; data: ShellRunResult };
    assert.equal(body.ok, true);
    assert.equal(body.data.sandbox.denied, true);
    assert.equal(body.data.exitCode, 126);
    assert.match(body.data.stderr.text, /quota exceeded/i);
  } finally {
    await h.cleanup();
  }
});

test('run: 关闭监控时正常命令照常执行（拒绝不是唯一结果）', async () => {
  const h = await makeHarness({
    childQuota: { enforcement: false, workspaceQuotaMb: 1, tempQuotaMb: 1 },
  });
  try {
    let ran = false;
    const res = await captureRun(
      async function (this: IsolatedShellExecutor, spec) {
        ran = true;
        return emptyResult(spec);
      },
      () => post(h.app, '/internal/v1/shell/run', { command: 'pwd' }),
    );
    assert.equal(ran, true);
    assert.equal(res.status, 200);
  } finally {
    await h.cleanup();
  }
});

test('start: workdir/env/stdin 传到执行器；timeoutMs 被拒绝', async () => {
  const h = await makeHarness();
  try {
    const rejected = await post(h.app, '/internal/v1/shell/start', {
      command: 'sleep 5',
      timeoutMs: 1_000,
    });
    assert.equal(rejected.status, 400);

    const originalStart = IsolatedShellExecutor.prototype.start;
    let target: ReturnType<IsolatedShellExecutor['spawnTargetFor']> | undefined;
    IsolatedShellExecutor.prototype.start = function (this: IsolatedShellExecutor, spec) {
      target = this.spawnTargetFor(['bash', '-c', spec.command], spec);
      const handle: ShellProcess = {
        status: 'completed',
        exitCode: 0,
        signal: null,
        done: Promise.resolve(),
        sandbox: { mode: 'workspace-write', denied: false },
        readOutput: () => ({ delta: '', lossy: false }),
        kill: () => false,
      };
      return handle;
    };
    try {
      const res = await post(h.app, '/internal/v1/shell/start', {
        command: 'sleep 5',
        workdir: '/tmp/build',
        stdin: '',
        env: { A: 'b' },
        id: 'bash-wiring1',
      });
      assert.equal(res.status, 200);
    } finally {
      IsolatedShellExecutor.prototype.start = originalStart;
    }
    assert.equal(target?.relativeCwd, 'build');
    assert.equal(target?.cwdScope, 'temp');
    // 空字符串 stdin 与缺省不同：它表示「有输入、内容为空」。
    assert.equal(target?.stdin, '');
    assert.equal(target?.envOverrides['A'], 'b');
    assert.equal(target?.maxProcessCount, DEFAULT_SHELL_RESOURCE_LIMITS.maxProcessCount);
  } finally {
    await h.cleanup();
  }
});
