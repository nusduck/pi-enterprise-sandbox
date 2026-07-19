import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;
process.env.AGENT_BASE_URL = 'http://agent.run-trace.test';
process.env.AUTH_ENABLED = 'false';

const { handleGetRunTrace } = await import(`../src/routes/runs.js?trace=${Date.now()}`);
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';
const TRACE = 'a'.repeat(32);
const REQUEST_TRACE = 'd'.repeat(32);
const CURSOR = 'c'.repeat(16);
const calls = [];

function responseCapture() {
  return {
    status: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = { ...this.headers, ...(headers || {}) };
    },
    setHeader(name, value) { this.headers[name] = value; },
    end(body = '') { this.body = String(body); },
  };
}

before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, init });
    if (path === `/internal/agent-runs/${RUN}`) {
      return new Response(JSON.stringify({
        run_id: RUN,
        conversation_id: '01K0G2PAV8FPMVC9QHJG7JPN51',
        status: 'completed',
      }), { status: 200 });
    }
    if (path.startsWith(`/internal/agent-runs/${RUN}/trace`)) {
      return new Response(JSON.stringify({
        traceId: TRACE,
        runId: RUN,
        spans: [{ id: 'b'.repeat(16), runId: RUN, traceId: TRACE }],
        truncated: true,
        next_cursor: CURSOR,
      }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentUrl === undefined) delete process.env.AGENT_BASE_URL;
  else process.env.AGENT_BASE_URL = originalAgentUrl;
  if (originalAuthEnabled === undefined) delete process.env.AUTH_ENABLED;
  else process.env.AUTH_ENABLED = originalAuthEnabled;
});

test('BFF trace route authorizes the Run before proxying durable spans', async () => {
  const response = responseCapture();
  await handleGetRunTrace(RUN, response, {
    headers: {},
    traceId: REQUEST_TRACE,
    url: `/api/runs/${RUN}/trace?limit=10&cursor=${CURSOR}`,
  });
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.spans.length, 1);
  assert.equal(body.traceId, TRACE);
  assert.equal(body.truncated, true);
  assert.equal(response.headers['X-Trace-Id'], REQUEST_TRACE);
  assert.deepEqual(calls.map((call) => call.path), [
    `/internal/agent-runs/${RUN}`,
    `/internal/agent-runs/${RUN}/trace?limit=10&cursor=${CURSOR}`,
  ]);
});
