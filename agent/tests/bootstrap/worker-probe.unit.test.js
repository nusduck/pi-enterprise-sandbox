/**
 * Worker 探针 listener：liveness 不查依赖，readiness 要求启动完成、消费者在跑、
 * 未关停且 MySQL / Redis 在超时内可达。
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  createWorkerProbeServer,
  evaluateWorkerReadiness,
  resolveWorkerProbePort,
  closeWorkerProbeServer,
  DEFAULT_AGENT_WORKER_PROBE_PORT,
} from '../../src/bootstrap/worker-probe.js';
import { startWorkerMain } from '../../src/bootstrap/worker-main.js';

function readyState(overrides = {}) {
  return {
    started: () => true,
    shuttingDown: () => false,
    consumerRunning: () => true,
    pingMysql: async () => [[{ 1: 1 }]],
    pingRedis: async () => 'PONG',
    ...overrides,
  };
}

async function listen(state, options = {}) {
  const server = createWorkerProbeServer(state, { port: 0, checkTimeoutMs: 100, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

describe('resolveWorkerProbePort', () => {
  it('defaults when empty and rejects invalid values', () => {
    assert.equal(resolveWorkerProbePort(undefined), DEFAULT_AGENT_WORKER_PROBE_PORT);
    assert.equal(resolveWorkerProbePort(' '), DEFAULT_AGENT_WORKER_PROBE_PORT);
    assert.equal(resolveWorkerProbePort('9001'), 9001);
    for (const bad of ['0', '65536', 'abc', '80.5', '-1', '4101x']) {
      assert.throws(() => resolveWorkerProbePort(bad), /AGENT_WORKER_PROBE_PORT/, bad);
    }
  });
});

describe('evaluateWorkerReadiness', () => {
  it('is ready only when every condition holds', async () => {
    const ok = await evaluateWorkerReadiness(readyState(), 100);
    assert.equal(ok.ready, true);
    assert.equal(ok.body.status, 'ready');

    const cases = {
      notStarted: { started: () => false },
      shuttingDown: { shuttingDown: () => true },
      consumerStopped: { consumerRunning: () => false },
      consumerPaused: { consumerPaused: () => true },
      mysqlDown: { pingMysql: async () => { throw new Error('ECONNREFUSED'); } },
      redisDown: { pingRedis: async () => { throw new Error('ECONNREFUSED'); } },
      mysqlHangs: { pingMysql: () => new Promise(() => {}) },
      flagThrows: { consumerRunning: () => { throw new Error('boom'); } },
    };
    for (const [name, override] of Object.entries(cases)) {
      const result = await evaluateWorkerReadiness(readyState(override), 50);
      assert.equal(result.ready, false, name);
      assert.equal(result.body.status, 'not_ready', name);
    }
  });

  it('reports a paused consumer distinctly from a stopped one', async () => {
    const paused = await evaluateWorkerReadiness(readyState({ consumerPaused: () => true }), 50);
    assert.equal(paused.ready, false);
    assert.equal(paused.body.consumer, 'paused');
    const running = await evaluateWorkerReadiness(readyState({ consumerPaused: () => false }), 50);
    assert.equal(running.body.consumer, 'running');
    const stopped = await evaluateWorkerReadiness(readyState({ consumerRunning: () => false }), 50);
    assert.equal(stopped.body.consumer, 'stopped');
  });

  it('does not ping dependencies before start or during shutdown', async () => {
    let pings = 0;
    const counting = { pingMysql: async () => { pings += 1; }, pingRedis: async () => { pings += 1; } };
    await evaluateWorkerReadiness(readyState({ ...counting, started: () => false }), 50);
    await evaluateWorkerReadiness(readyState({ ...counting, shuttingDown: () => true }), 50);
    assert.equal(pings, 0);
  });

  it('does not leak error details in the body', async () => {
    const result = await evaluateWorkerReadiness(
      readyState({ pingMysql: async () => { throw new Error('mysql://sandbox:secret@db'); } }),
      50,
    );
    assert.doesNotMatch(JSON.stringify(result.body), /secret/);
  });
});

describe('createWorkerProbeServer', () => {
  const servers = [];
  after(async () => {
    for (const server of servers) await closeWorkerProbeServer(server);
  });

  it('serves liveness regardless of dependencies and readiness from state', async () => {
    let redisUp = true;
    const { server, base } = await listen(
      readyState({
        pingRedis: async () => {
          if (!redisUp) throw new Error('down');
          return 'PONG';
        },
      }),
    );
    servers.push(server);

    let res = await fetch(`${base}/ready`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).redis, 'ok');

    redisUp = false;
    res = await fetch(`${base}/ready`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).redis, 'unavailable');

    res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).status, 'ok');
  });

  it('exposes no other routes or methods', async () => {
    const { server, base } = await listen(readyState());
    servers.push(server);
    for (const [method, path] of [['GET', '/'], ['GET', '/internal/v1/runs'], ['POST', '/ready'], ['POST', '/health']]) {
      const res = await fetch(`${base}${path}`, { method });
      assert.equal(res.status, 404, `${method} ${path}`);
    }
  });
});

describe('startWorkerMain probe lifecycle', () => {
  it('rejects an invalid probe port before starting the container', async () => {
    let created = false;
    await assert.rejects(
      () =>
        startWorkerMain(
          { AGENT_WORKER_PROBE_PORT: 'nope' },
          { createContainer: () => { created = true; return {}; } },
        ),
      /AGENT_WORKER_PROBE_PORT/,
    );
    assert.equal(created, false);
  });

  it('reports not ready during startup and closes the listener when startup fails', async () => {
    let server;
    let readinessDuringStart;
    await assert.rejects(
      () =>
        startWorkerMain(
          { AGENT_ALLOW_STUB_EXECUTOR: 'true', NODE_ENV: 'development' },
          {
            startProbeServer: async (state) => {
              server = createWorkerProbeServer(state, { port: 0, checkTimeoutMs: 50 });
              await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
              return server;
            },
            createContainer: () => ({
              async start() {
                const { port } = server.address();
                readinessDuringStart = await fetch(`http://127.0.0.1:${port}/ready`);
                throw new Error('schema drift');
              },
            }),
          },
        ),
      /schema drift/,
    );
    assert.equal(readinessDuringStart.status, 503);
    assert.equal((await readinessDuringStart.json()).started, false);
    assert.equal(server.listening, false);
  });
});
