import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalSandboxUrl = process.env.SANDBOX_BASE_URL;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;

process.env.SANDBOX_BASE_URL = 'http://sandbox.run-detail.test';
process.env.AGENT_BASE_URL = 'http://agent.run-detail.test';
process.env.AUTH_ENABLED = 'false';

const {
  handleGetRun,
  presentRunDetail,
  toIsoTimestamp,
} = await import(`../routes/runs.js?test=${Date.now()}`);

function responseCapture() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

const PERSISTED_ISO = {
  created_at: '2026-07-14T10:00:00.000Z',
  updated_at: '2026-07-14T10:05:00.000Z',
};

const LIVE_MS = {
  created_at: Date.parse('2026-07-14T11:00:00.000Z'),
  updated_at: Date.parse('2026-07-14T11:30:00.000Z'),
};

before(() => {
  globalThis.fetch = async (input) => {
    const url = String(input);

    if (url === 'http://sandbox.run-detail.test/agent-runs/run_persisted') {
      return new Response(JSON.stringify({
        run_id: 'run_persisted',
        conversation_id: 'conv_1',
        status: 'completed',
        ...PERSISTED_ISO,
      }), { status: 200 });
    }
    if (url === 'http://agent.run-detail.test/internal/agent-runs/run_persisted') {
      return new Response(JSON.stringify({ error: 'Run not found' }), { status: 404 });
    }

    if (url === 'http://sandbox.run-detail.test/agent-runs/run_live') {
      return new Response(JSON.stringify({
        run_id: 'run_live',
        conversation_id: 'conv_2',
        status: 'running',
        ...PERSISTED_ISO,
      }), { status: 200 });
    }
    if (url === 'http://agent.run-detail.test/internal/agent-runs/run_live') {
      return new Response(JSON.stringify({
        run_id: 'run_live',
        conversation_id: 'conv_2',
        status: 'running',
        event_count: 3,
        next_sequence: 4,
        ...LIVE_MS,
      }), { status: 200 });
    }

    if (url === 'http://sandbox.run-detail.test/agent-runs/run_bad_live_ts') {
      return new Response(JSON.stringify({
        run_id: 'run_bad_live_ts',
        conversation_id: 'conv_3',
        status: 'running',
        ...PERSISTED_ISO,
      }), { status: 200 });
    }
    if (url === 'http://agent.run-detail.test/internal/agent-runs/run_bad_live_ts') {
      return new Response(JSON.stringify({
        run_id: 'run_bad_live_ts',
        conversation_id: 'conv_3',
        status: 'running',
        created_at: Number.NaN,
        updated_at: 'not-a-date',
      }), { status: 200 });
    }

    throw new Error(`Unexpected fetch: ${url}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalSandboxUrl === undefined) delete process.env.SANDBOX_BASE_URL;
  else process.env.SANDBOX_BASE_URL = originalSandboxUrl;
  if (originalAgentUrl === undefined) delete process.env.AGENT_BASE_URL;
  else process.env.AGENT_BASE_URL = originalAgentUrl;
  if (originalAuthEnabled === undefined) delete process.env.AUTH_ENABLED;
  else process.env.AUTH_ENABLED = originalAuthEnabled;
});

test('toIsoTimestamp converts epoch ms and ISO strings', () => {
  assert.equal(toIsoTimestamp(LIVE_MS.created_at), '2026-07-14T11:00:00.000Z');
  assert.equal(toIsoTimestamp('2026-07-14T10:00:00.000Z'), '2026-07-14T10:00:00.000Z');
  assert.equal(toIsoTimestamp(null), null);
  assert.equal(toIsoTimestamp('bogus'), null);
  assert.equal(toIsoTimestamp(Number.NaN), null);
});

test('presentRunDetail prefers converted live timestamps over persisted', () => {
  const detail = presentRunDetail(
    {
      run_id: 'r1',
      status: 'running',
      ...PERSISTED_ISO,
    },
    {
      run_id: 'r1',
      status: 'running',
      ...LIVE_MS,
    },
    true,
  );
  assert.equal(detail.runtime_available, true);
  assert.equal(detail.created_at, '2026-07-14T11:00:00.000Z');
  assert.equal(detail.updated_at, '2026-07-14T11:30:00.000Z');
  assert.equal(typeof detail.created_at, 'string');
  assert.equal(typeof detail.updated_at, 'string');
});

test('presentRunDetail falls back to persisted timestamps when live is invalid', () => {
  const detail = presentRunDetail(
    {
      run_id: 'r2',
      status: 'running',
      ...PERSISTED_ISO,
    },
    {
      run_id: 'r2',
      status: 'running',
      created_at: Number.NaN,
      updated_at: 'nope',
    },
    true,
  );
  assert.equal(detail.runtime_available, true);
  assert.equal(detail.created_at, PERSISTED_ISO.created_at);
  assert.equal(detail.updated_at, PERSISTED_ISO.updated_at);
});

test('GET Run returns persisted detail when the live Agent log is missing', async () => {
  const res = responseCapture();
  await handleGetRun('run_persisted', res, { headers: {}, traceId: 'trace_1' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    run_id: 'run_persisted',
    conversation_id: 'conv_1',
    status: 'completed',
    created_at: PERSISTED_ISO.created_at,
    updated_at: PERSISTED_ISO.updated_at,
    runtime_available: false,
  });
});

test('GET Run converts live epoch-ms timestamps to ISO strings', async () => {
  const res = responseCapture();
  await handleGetRun('run_live', res, { headers: {}, traceId: 'trace_2' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.runtime_available, true);
  assert.equal(body.status, 'running');
  assert.equal(body.event_count, 3);
  assert.equal(body.created_at, '2026-07-14T11:00:00.000Z');
  assert.equal(body.updated_at, '2026-07-14T11:30:00.000Z');
  assert.equal(typeof body.created_at, 'string');
  assert.equal(typeof body.updated_at, 'string');
});

test('GET Run uses persisted timestamps when live timestamps are invalid', async () => {
  const res = responseCapture();
  await handleGetRun('run_bad_live_ts', res, { headers: {}, traceId: 'trace_3' });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.runtime_available, true);
  assert.equal(body.created_at, PERSISTED_ISO.created_at);
  assert.equal(body.updated_at, PERSISTED_ISO.updated_at);
});
