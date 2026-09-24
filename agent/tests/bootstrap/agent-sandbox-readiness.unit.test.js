/**
 * K8s 部署评审 K1（docs/reviews/2026-09-19-k8s-deployment）：Agent `/ready` 注入的
 * 执行面检查原来访问 exec `/health`（liveness），执行面存储/数据库故障或进入关停时
 * Agent 仍报就绪。必须按 exec `/ready` 的 HTTP 状态与 `status: ready` 判断。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSandboxClient } from '../../src/infrastructure/sandbox/sandbox-client.js';
import { createAgentHttpServer } from '../../src/bootstrap/create-http-server.ts';
import { readSource } from '../support/read-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SANDBOX_BASE = new URL(process.env.SANDBOX_BASE_URL || 'http://sandbox:8081');

/**
 * 只拦截发往执行面的请求：`/health` 恒 200（进程活着），`/ready` 由 `ready` 决定。
 * 发往本地测试服务器的请求照常放行。
 */
async function withExecStub(ready, fn) {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    if (target.host !== SANDBOX_BASE.host) return originalFetch(url, options);
    seen.push(target.pathname);
    if (target.pathname === '/health') return Response.json({ status: 'ok' });
    if (target.pathname === '/ready') return Response.json(ready.body, { status: ready.status });
    return new Response('not found', { status: 404 });
  };
  try {
    return await fn(seen);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const READY = { status: 200, body: { status: 'ready' } };
const NOT_READY = { status: 503, body: { status: 'not_ready', storage: { tmp: 'unavailable' } } };

async function agentReady(execReady) {
  return withExecStub(execReady, async (seen) => {
    const srv = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      dataPlaneReady: true,
      sandboxReadyCheck: () => createSandboxClient().checkReady(),
      config: { ALLOW_UNAUTHENTICATED_INTERNAL: true },
    });
    const port = await new Promise((resolve) => {
      srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/ready`);
      return { status: res.status, body: await res.json(), seen };
    } finally {
      await new Promise((r) => srv.close(() => r()));
    }
  });
}

describe('Agent /ready execution-plane probe', () => {
  it('sandbox client readiness probes exec /ready, not /health', async () => {
    const result = await withExecStub(NOT_READY, async (seen) => ({
      readiness: await createSandboxClient().checkReady(),
      seen,
    }));
    assert.deepEqual(result.seen, ['/ready']);
    assert.equal(result.readiness.status, 'not_ready');
  });

  it('a 200 whose body is not status=ready is not ready', async () => {
    const readiness = await withExecStub({ status: 200, body: { status: 'ok' } }, () =>
      createSandboxClient().checkReady(),
    );
    assert.equal(readiness.status, 'not_ready');
  });

  it('Agent /ready is 503 when exec is alive but not ready', async () => {
    const result = await agentReady(NOT_READY);
    assert.equal(result.status, 503);
    assert.equal(result.body.sandbox, 'not_ready');
    assert.equal(result.body.data_plane, 'ok');
  });

  it('Agent /ready is 200 when exec /ready answers ready', async () => {
    const result = await agentReady(READY);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ready');
    assert.equal(result.body.sandbox, 'ok');
  });

  it('production wiring injects the exec readiness probe, not liveness', () => {
    const src = readSource(path.join(__dirname, '../../src/bootstrap/http-main.js'));
    assert.match(src, /sandboxReadyCheck/);
    assert.doesNotMatch(src, /checkHealth\(/);
    assert.doesNotMatch(src, /sandboxHealthCheck/);
  });
});
