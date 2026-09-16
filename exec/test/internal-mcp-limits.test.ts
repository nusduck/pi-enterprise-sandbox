/**
 * MCP 窄桥的执行入口与内部 Shell 路由**同一套**限额、配额与取消接线
 * （2026-09-16 修复后复核 F1）。
 *
 * R1/R2 的修复只接到了 `/internal/v1/shell/run`：`/internal/mcp/v1/shell/execute`
 * 与 `python/execute` 仍然 new 一个裸执行器——`maxProcessCount=0`、`rlimits`
 * 缺失、没有配额准入/采样、请求断开到不了执行面。外部 MCP 客户端恰好走这条路。
 *
 * 每条拒绝断言都配一条合法成功的对照，避免「全部拒绝」假通过。
 * 不起 bwrap：替换执行器的 run / runPython，只验证路由交给执行器的东西。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Hono } from 'hono';
import { Context as CordisContext } from '@deepseek-ai/cordis';
import type { ShellExecSpec, ShellRunResult } from '@deepseek-ai/dsh-shell';
import { ArtifactService } from '../src/artifact/service.js';
import { WorkspaceFileSystem } from '../src/fs/workspace-fs.js';
import { registerInternalMcpRoutes } from '../src/http/internal-mcp.js';
import { IsolatedShellExecutor } from '../src/shell/executor.js';
import type { ShellResourceLimits } from '../src/shell/resource-limits.js';
import type { ChildQuotaConfig } from '../src/workspace/child-quota.js';
import { WorkspaceManager } from '../src/workspace/manager.js';
import { InMemoryQuotaStore, type QuotaStore } from '../src/workspace/quota-store.js';

const TOKEN = 'mcp-internal-token-for-tests';
const SESSION = '01JQ0000000000000000000001';
const WORKSPACE = '01JQ0000000000000000000002';
const IDENTITY = { sandbox_session_id: SESSION, workspace_id: WORKSPACE };

const LIMITS: ShellResourceLimits = {
  executionTimeoutMs: 60_000,
  maxOutputChars: 1_000,
  maxProcessCount: 20,
  rlimits: { maxOpenFiles: 256, cpuSeconds: 300, fileSizeKb: 51_200 },
  containerMemoryBackstopMb: 512,
};

/** 控制面账本已预留 5 MB，而配额只有 1 MB——与内部路由的超额用例同一构造。 */
const OVER_RESERVED: QuotaStore = {
  sumReserved: async () => 5 * 1024 * 1024,
  getReservationBytes: async () => 0,
  putReservation: async () => undefined,
  deleteReservation: async () => undefined,
};

async function makeBridge(
  overrides: { childQuota?: ChildQuotaConfig; quotaStore?: QuotaStore } = {},
): Promise<{ app: Hono; cleanup: () => Promise<void> }> {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'exec-mcp-limits-')));
  await mkdir(path.join(base, 'skills'), { recursive: true });
  const app = new Hono();
  registerInternalMcpRoutes(app, {
    workspaceManager: new WorkspaceManager({
      workspacesBaseRoot: path.join(base, 'workspaces'),
      tempBaseRoot: path.join(base, 'tmp'),
    }),
    systemSkillRoot: path.join(base, 'skills'),
    bwrapExecutable: '/unused',
    artifactService: new ArtifactService(
      (ws) => new WorkspaceFileSystem(new CordisContext() as never, ws),
      undefined,
      {
        roots: {
          artifactsRoot: path.join(base, 'control', 'artifacts'),
          controlRoot: path.join(base, 'control', 'root'),
        },
      },
    ),
    internalToken: TOKEN,
    resourceLimits: LIMITS,
    ...(overrides.childQuota !== undefined ? { childQuota: overrides.childQuota } : {}),
    quotaStore: overrides.quotaStore ?? new InMemoryQuotaStore(),
  });
  return { app, cleanup: () => rm(base, { recursive: true, force: true }) };
}

function post(app: Hono, p: string, payload: object, signal?: AbortSignal): Promise<Response> {
  return app.request(`/internal/mcp/v1${p}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ...IDENTITY, ...payload }),
    ...(signal !== undefined ? { signal } : {}),
  });
}

function emptyResult(timeoutMs: number): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    sandbox: { mode: 'workspace-write', denied: false },
  };
}

type RunPythonInput = Parameters<IsolatedShellExecutor['runPython']>[0];

/** 同时替换 run 与 runPython；未替换的一侧被调用即失败。 */
async function withExecutor<T>(
  impl: {
    run?: (this: IsolatedShellExecutor, spec: ShellExecSpec) => Promise<ShellRunResult>;
    runPython?: (this: IsolatedShellExecutor, input: RunPythonInput) => Promise<ShellRunResult>;
  },
  body: () => Promise<T>,
): Promise<T> {
  const proto = IsolatedShellExecutor.prototype;
  const original = { run: proto.run, runPython: proto.runPython };
  proto.run = impl.run ?? (async () => assert.fail('run must not be called'));
  proto.runPython = impl.runPython ?? (async () => assert.fail('runPython must not be called'));
  try {
    return await body();
  } finally {
    proto.run = original.run;
    proto.runPython = original.runPython;
  }
}

test('shell/execute: 资源限额从装配传到执行器与 SpawnTarget', async () => {
  const h = await makeBridge();
  try {
    let target: ReturnType<IsolatedShellExecutor['spawnTargetFor']> | undefined;
    let timeoutMs: number | undefined;
    const res = await withExecutor(
      {
        async run(spec) {
          assert.equal(this.defaultTimeoutMs, 60_000);
          assert.equal(this.outputCapChars, 1_000);
          target = this.spawnTargetFor(['bash', '-c', spec.command], spec);
          timeoutMs = spec.timeoutMs;
          return emptyResult(spec.timeoutMs);
        },
      },
      () => post(h.app, '/shell/execute', { command: 'pwd', timeout_seconds: 30 }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { status: string }).status, 'succeeded');
    assert.equal(target?.maxProcessCount, 20);
    assert.deepEqual(target?.rlimits, LIMITS.rlimits);
    assert.equal(timeoutMs, 30_000);
  } finally {
    await h.cleanup();
  }
});

test('python/execute: 执行器同样带限额', async () => {
  const h = await makeBridge();
  try {
    let seen: { maxProcessCount: number; rlimits: unknown } | undefined;
    const res = await withExecutor(
      {
        async runPython(input) {
          seen = { maxProcessCount: this.maxProcessCount, rlimits: this.rlimits };
          return emptyResult(input.timeoutMs ?? 0);
        },
      },
      () => post(h.app, '/python/execute', { code: 'print(1)' }),
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seen, { maxProcessCount: 20, rlimits: LIMITS.rlimits });
  } finally {
    await h.cleanup();
  }
});

test('shell/execute: 超过服务端执行预算的 timeout_seconds 被拒绝（400），预算内通过', async () => {
  const h = await makeBridge();
  try {
    const over = await withExecutor({}, () =>
      post(h.app, '/shell/execute', { command: 'pwd', timeout_seconds: 61 }),
    );
    assert.equal(over.status, 400);
    const ok = await withExecutor(
      { run: async (spec) => emptyResult(spec.timeoutMs) },
      () => post(h.app, '/shell/execute', { command: 'pwd', timeout_seconds: 60 }),
    );
    assert.equal(ok.status, 200);
  } finally {
    await h.cleanup();
  }
});

test('shell/execute: 请求断开进入执行的 AbortSignal', async () => {
  const h = await makeBridge();
  try {
    const client = new AbortController();
    let aborted = false;
    await withExecutor(
      {
        async run(spec) {
          await new Promise<void>((resolve) => {
            spec.signal?.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
            client.abort();
          });
          return { ...emptyResult(spec.timeoutMs), aborted: true };
        },
      },
      () => post(h.app, '/shell/execute', { command: 'sleep 60' }, client.signal).catch(() => null),
    );
    assert.equal(aborted, true, 'client disconnect must reach the execution signal');
  } finally {
    await h.cleanup();
  }
});

test('python/execute: 请求断开进入执行的 AbortSignal', async () => {
  const h = await makeBridge();
  try {
    const client = new AbortController();
    let aborted = false;
    await withExecutor(
      {
        async runPython(input) {
          await new Promise<void>((resolve) => {
            input.signal?.addEventListener('abort', () => {
              aborted = true;
              resolve();
            });
            client.abort();
          });
          return { ...emptyResult(input.timeoutMs ?? 0), aborted: true };
        },
      },
      () => post(h.app, '/python/execute', { code: 'import time' }, client.signal).catch(() => null),
    );
    assert.equal(aborted, true, 'client disconnect must reach the python execution signal');
  } finally {
    await h.cleanup();
  }
});

test('shell/execute 与 python/execute: 配额超额时不执行，状态 failed 并说明原因', async () => {
  const h = await makeBridge({
    childQuota: { enforcement: true, workspaceQuotaMb: 1, tempQuotaMb: 0 },
    quotaStore: OVER_RESERVED,
  });
  try {
    for (const [route, payload] of [
      ['/shell/execute', { command: 'dd if=/dev/zero of=big' }],
      ['/python/execute', { code: 'open("big","wb").write(b"0"*10**9)' }],
    ] as const) {
      const res = await withExecutor({}, () => post(h.app, route, payload));
      assert.equal(res.status, 200, route);
      const body = (await res.json()) as { status: string; exit_code: number; stderr_preview: string };
      assert.equal(body.status, 'failed', route);
      assert.equal(body.exit_code, 126, route);
      assert.match(body.stderr_preview, /quota exceeded/i, route);
    }
  } finally {
    await h.cleanup();
  }
});

test('配额监控开启但未超额时照常执行（拒绝不是唯一结果）', async () => {
  const h = await makeBridge({
    childQuota: { enforcement: true, workspaceQuotaMb: 100, tempQuotaMb: 100 },
  });
  try {
    let ran = 0;
    const shell = await withExecutor(
      {
        run: async (spec) => {
          ran += 1;
          return emptyResult(spec.timeoutMs);
        },
      },
      () => post(h.app, '/shell/execute', { command: 'pwd' }),
    );
    const python = await withExecutor(
      {
        runPython: async (input) => {
          ran += 1;
          return emptyResult(input.timeoutMs ?? 0);
        },
      },
      () => post(h.app, '/python/execute', { code: 'print(1)' }),
    );
    assert.equal(shell.status, 200);
    assert.equal(python.status, 200);
    assert.equal(ran, 2);
  } finally {
    await h.cleanup();
  }
});

test('生产装配（createExecAppFromEnv）把环境里的限额接到 MCP 桥，不只是手工注入', async () => {
  const { createExecAppFromEnv } = await import('../src/http/app.js');
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'exec-mcp-env-')));
  const runtime = createExecAppFromEnv({
    DEPLOYMENT_ENV: 'development',
    SANDBOX_INTERNAL_HMAC_KEYRING: JSON.stringify({ kid: Buffer.from('0'.repeat(32)).toString('base64url') }),
    SANDBOX_INTERNAL_HMAC_ACTIVE_KID: 'kid',
    SANDBOX_API_TOKEN: 'exec-test-service-token-32-bytes-long',
    SANDBOX_MCP_INTERNAL_TOKEN: TOKEN,
    SANDBOX_WORKSPACES_ROOT: path.join(base, 'ws'),
    SANDBOX_TEMP_ROOT: path.join(base, 'tmp'),
    SANDBOX_MAX_PROCESS_COUNT: '17',
    SANDBOX_MAX_OPEN_FILES: '128',
    SANDBOX_EXECUTION_TIMEOUT_SECONDS: '45',
  } as NodeJS.ProcessEnv);
  try {
    let seen: { maxProcessCount: number; maxOpenFiles: number | undefined; defaultTimeoutMs: number } | undefined;
    const call = (timeout: number) =>
      runtime.app.request('/internal/mcp/v1/shell/execute', {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...IDENTITY, command: 'pwd', timeout_seconds: timeout }),
      });
    const ok = await withExecutor(
      {
        async run(spec) {
          seen = {
            maxProcessCount: this.maxProcessCount,
            maxOpenFiles: this.rlimits?.maxOpenFiles,
            defaultTimeoutMs: this.defaultTimeoutMs,
          };
          return emptyResult(spec.timeoutMs);
        },
      },
      () => call(45),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(seen, { maxProcessCount: 17, maxOpenFiles: 128, defaultTimeoutMs: 45_000 });
    const over = await withExecutor({}, () => call(46));
    assert.equal(over.status, 400);
  } finally {
    await runtime.dispose();
    await rm(base, { recursive: true, force: true });
  }
});
