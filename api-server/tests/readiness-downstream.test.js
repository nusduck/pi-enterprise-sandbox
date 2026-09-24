/**
 * K8s 部署评审 K1（docs/reviews/2026-09-19-k8s-deployment）：BFF `/health/ready`
 * 原来访问的是 Agent 与执行面的 `/health`（liveness），下游「活着但未就绪」时仍报 200。
 * readiness 必须按下游 `/ready` 的 HTTP 状态和 `status: ready` 契约判断。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReadiness } from '../src/routes/status.js';

function captureResponse() {
  const captured = { status: 0, body: null };
  const res = {
    writeHead(status) {
      captured.status = status;
    },
    end(text) {
      captured.body = JSON.parse(text);
    },
  };
  return { res, captured };
}

/** 下游替身：`/health` 恒 200（进程活着），`/ready` 由调用方决定。 */
function downstreamFetch(readyFor, seen) {
  return async (url) => {
    const { pathname } = new URL(String(url));
    seen.push(pathname);
    if (pathname === '/health') {
      return Response.json({ status: 'ok' });
    }
    if (pathname === '/ready') {
      const { status, body } = readyFor(String(url));
      return Response.json(body, { status });
    }
    return new Response('not found', { status: 404 });
  };
}

async function readiness(readyFor) {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = downstreamFetch(readyFor, seen);
  try {
    const { res, captured } = captureResponse();
    await handleReadiness(res);
    return { ...captured, seen };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const READY = { status: 200, body: { status: 'ready' } };
const NOT_READY = { status: 503, body: { status: 'not_ready' } };
const isSandbox = (url) => new URL(url).hostname === 'sandbox';

test('BFF readiness is 503 when downstream is alive but not ready', async () => {
  const result = await readiness(() => NOT_READY);
  assert.equal(result.status, 503);
  assert.equal(result.body.status, 'degraded');
  assert.ok(result.seen.includes('/ready'), `must probe /ready, saw ${result.seen}`);
  assert.ok(!result.seen.includes('/health'), `must not use liveness, saw ${result.seen}`);
});

test('BFF readiness is 503 when only the execution plane is not ready', async () => {
  const result = await readiness((url) => (isSandbox(url) ? NOT_READY : READY));
  assert.equal(result.status, 503);
  assert.equal(result.body.sandbox.status, 'not_ready');
  assert.equal(result.body.agent.status, 'ready');
});

test('BFF readiness is 503 when only the Agent is not ready', async () => {
  const result = await readiness((url) => (isSandbox(url) ? READY : NOT_READY));
  assert.equal(result.status, 503);
  assert.equal(result.body.agent.status, 'not_ready');
  assert.equal(result.body.sandbox.status, 'ready');
});

test('BFF readiness rejects a 200 whose body does not say ready', async () => {
  const result = await readiness(() => ({ status: 200, body: { status: 'ok' } }));
  assert.equal(result.status, 503);
});

test('BFF readiness is 200 when both downstream /ready answer ready', async () => {
  const result = await readiness(() => READY);
  assert.equal(result.status, 200);
  assert.equal(result.body.status, 'ok');
  assert.deepEqual(result.seen.sort(), ['/ready', '/ready']);
});
