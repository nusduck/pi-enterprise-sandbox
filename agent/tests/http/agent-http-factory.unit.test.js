/**
 * PR-04 T4: HTTP factory with fake services (offline, no MySQL/Redis/knex).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createAgentHttpServer,
  resolveRequestTraceId,
  parseTraceparent,
  mapErrorToHttp,
  presentCreateRunResponse,
} from '../../src/bootstrap/create-http-server.js';
import {
  OwnerScopedNotFoundError,
  ValidationError,
} from '../../src/application/errors.js';
import { isTerminalRunStatus } from '../../src/domain/run/run-status.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const TRACE = 'a'.repeat(32);

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve(port);
    });
  });
}

async function req(port, method, urlPath, { headers = {}, body } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Acting-User-Id': 'user-ext-1',
      'X-Acting-Organization-Id': 'org-ext-1',
      ...headers,
    },
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json, headers: res.headers };
}

describe('createAgentHttpServer factory', () => {
  /** @type {http.Server} */
  let server;
  let port;
  /** @type {object[]} */
  let created;
  /** @type {Map<string, object>} */
  let runs;
  /** @type {Map<string, object[]>} */
  let events;
  let cancelCalled;

  before(async () => {
    created = [];
    runs = new Map();
    events = new Map();
    cancelCalled = 0;

    const createRunService = {
      async execute(input) {
        created.push(input);
        const runId = RUN;
        const row = {
          runId,
          status: 'ACCEPTED',
          conversationId: CONV,
          orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
          userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
          agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
          traceId: input.traceId,
          attempt: 0,
          statusReason: null,
          cancelRequestedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
        };
        runs.set(runId, row);
        events.set(runId, [
          {
            sequence: 1,
            event: { type: 'run.accepted', status: 'ACCEPTED' },
            ts: Date.now(),
          },
        ]);
        return {
          runId,
          status: 'ACCEPTED',
          conversationId: CONV,
          eventsUrl: `/api/runs/${runId}/events`,
          agentSessionId: row.agentSessionId,
        };
      },
    };

    const getRunService = {
      async execute({ runId, auth }) {
        if (auth.externalUserId === 'foreign') {
          throw new OwnerScopedNotFoundError('Run not found');
        }
        const row = runs.get(runId);
        if (!row) throw new OwnerScopedNotFoundError('Run not found');
        return row;
      },
    };

    const cancelRunService = {
      async execute() {
        cancelCalled += 1;
        return {
          runId: RUN,
          status: 'CANCELLING',
          cancelRequested: true,
          signalPending: false,
          terminal: false,
        };
      },
    };

    const eventQueryService = {
      async listEvents({ runId, afterSequence = 0 }) {
        const row = runs.get(runId);
        if (!row) throw new OwnerScopedNotFoundError('Run not found');
        const all = events.get(runId) || [];
        const page = all.filter((e) => e.sequence > afterSequence);
        return {
          run: row,
          events: page,
          terminal: isTerminalRunStatus(row.status),
          status: row.status,
        };
      },
    };

    server = createAgentHttpServer({
      createRunService,
      getRunService,
      cancelRunService,
      eventQueryService,
      config: { AGENT_INTERNAL_TOKEN: '' },
      eventPollIntervalMs: 50,
      eventHeartbeatMs: 1000,
    });
    port = await listen(server);
  });

  after(async () => {
    await new Promise((r) => server.close(() => r()));
  });

  it('create returns 202 after service execute (persist-before-response contract)', async () => {
    const r = await req(port, 'POST', '/internal/agent-runs', {
      headers: { 'Idempotency-Key': 'k1', 'X-Trace-Id': TRACE },
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.status, 202);
    assert.equal(r.json.runId, RUN);
    assert.equal(r.json.run_id, RUN);
    assert.equal(r.json.status, 'ACCEPTED');
    assert.equal(created.length, 1);
    assert.equal(created[0].idempotencyKey, 'k1');
    assert.equal(created[0].traceId, TRACE);
  });

  it('immediate GET after create works', async () => {
    const r = await req(port, 'GET', `/internal/agent-runs/${RUN}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.run_id, RUN);
    assert.equal(r.json.status, 'ACCEPTED');
  });

  it('requires Idempotency-Key', async () => {
    const r = await req(port, 'POST', '/internal/agent-runs', {
      body: { messages: [{ role: 'user', content: 'x' }] },
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.code, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('foreign owner GET is 404', async () => {
    const r = await req(port, 'GET', `/internal/agent-runs/${RUN}`, {
      headers: {
        'X-Acting-User-Id': 'foreign',
        'X-Acting-Organization-Id': 'org-ext-1',
      },
    });
    assert.equal(r.status, 404);
  });

  it('rejects missing acting headers', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/agent-runs/${RUN}`, {
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 400);
  });

  it('events JSON history works (restart-safe, no Map)', async () => {
    const r = await req(
      port,
      'GET',
      `/internal/agent-runs/${RUN}/events?format=json&after=0`,
    );
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.events));
    assert.equal(r.json.events[0].sequence, 1);
    assert.equal(r.json.events[0].event.type, 'run.accepted');
  });

  it('cancel requires Idempotency-Key and returns cancel intent shape', async () => {
    const missing = await req(port, 'POST', `/internal/agent-runs/${RUN}/cancel`, {
      body: { reason: 'stop' },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const r = await req(port, 'POST', `/internal/agent-runs/${RUN}/cancel`, {
      headers: { 'Idempotency-Key': 'cancel-1' },
      body: { reason: 'stop' },
    });
    assert.equal(r.status, 200);
    assert.equal(cancelCalled, 1);
    assert.equal(r.json.cancelRequested, true);
  });

  it('steer returns 501 without Map fallback', async () => {
    const r = await req(port, 'POST', `/internal/agent-runs/${RUN}/steer`, {
      body: { text: 'x' },
    });
    assert.equal(r.status, 501);
  });

  it('resolveRequestTraceId prefers valid traceparent and rejects illegal', () => {
    assert.equal(
      parseTraceparent(`00-${TRACE}-bbbbbbbbbbbbbbbb-01`),
      TRACE,
    );
    assert.equal(parseTraceparent(`00-${TRACE}-${'0'.repeat(16)}-01`), null);
    assert.equal(parseTraceparent(`ff-${TRACE}-bbbbbbbbbbbbbbbb-01`), null);

    const id = resolveRequestTraceId({
      headers: {
        traceparent: `00-${TRACE}-bbbbbbbbbbbbbbbb-01`,
      },
    });
    assert.equal(id, TRACE);
    // All-zero span is illegal → mint new
    const badSpan = resolveRequestTraceId({
      headers: {
        traceparent: `00-${TRACE}-${'0'.repeat(16)}-01`,
      },
    });
    assert.notEqual(badSpan, TRACE);
    assert.match(badSpan, /^[0-9a-f]{32}$/);
    const minted = resolveRequestTraceId({
      headers: { 'x-trace-id': '0'.repeat(32) },
    });
    assert.match(minted, /^[0-9a-f]{32}$/);
    assert.notEqual(minted, '0'.repeat(32));
  });

  it('/ready is 503 when data plane is not ready', async () => {
    const srv = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      dataPlaneReady: false,
      sandboxHealthCheck: async () => ({ status: 'ok' }),
      config: {},
    });
    const p = await listen(srv);
    try {
      const res = await fetch(`http://127.0.0.1:${p}/ready`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.data_plane, 'unavailable');
    } finally {
      await new Promise((r) => srv.close(() => r()));
    }
  });

  it('mapErrorToHttp never embeds DSN secrets', () => {
    const err = new ValidationError('bad');
    assert.equal(mapErrorToHttp(err).status, 400);
    const cfg = Object.assign(new Error('fail'), {
      code: 'MYSQL_CONFIG_ERROR',
      name: 'MysqlConfigError',
    });
    const m = mapErrorToHttp(cfg);
    assert.equal(m.status, 503);
    assert.doesNotMatch(JSON.stringify(m.body), /mysql:\/\//);
  });

  it('presentCreateRunResponse dual keys', () => {
    const p = presentCreateRunResponse({
      runId: RUN,
      status: 'ACCEPTED',
      conversationId: CONV,
      eventsUrl: '/e',
    });
    assert.equal(p.run_id, RUN);
    assert.equal(p.runId, RUN);
  });
});

describe('production import graph', () => {
  it('server.js does not import run-manager', () => {
    const src = readFileSync(
      path.join(__dirname, '../../server.js'),
      'utf8',
    );
    assert.doesNotMatch(src, /from ['"].*run-manager/);
    assert.doesNotMatch(src, /application\/run-manager/);
    assert.match(src, /createAgentHttpServer|startHttpMain/);
  });

  it('create-http-server does not import run-manager', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/bootstrap/create-http-server.js'),
      'utf8',
    );
    assert.doesNotMatch(src, /from ['"].*run-manager/);
    assert.doesNotMatch(src, /require\(['"].*run-manager/);
    assert.doesNotMatch(src, /application\/run-manager/);
  });

  it('SSE path wires waitDrain + sleepMs (async backpressure, no listener leak)', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/bootstrap/create-http-server.js'),
      'utf8',
    );
    assert.match(src, /waitDrain/);
    assert.match(src, /waitForWritableResume/);
    assert.match(src, /sleepMs/);
    assert.match(src, /writeWithBackpressure/);
    // Fallback poll must await write before next event.
    assert.match(src, /await writeWithBackpressure/);
  });

  it('container module has no top-level knex/ioredis require side effects', () => {
    const src = readFileSync(
      path.join(__dirname, '../../src/bootstrap/container.js'),
      'utf8',
    );
    // Lazy dynamic import only inside start()
    assert.match(src, /await import\(/);
    assert.doesNotMatch(src, /^import knex/m);
    assert.doesNotMatch(src, /^import.*ioredis/m);
  });
});
