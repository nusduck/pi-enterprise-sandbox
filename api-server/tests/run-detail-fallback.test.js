import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalSandboxUrl = process.env.SANDBOX_BASE_URL;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;

process.env.SANDBOX_BASE_URL = 'http://sandbox.run-detail.test';
process.env.AGENT_BASE_URL = 'http://agent.run-detail.test';
process.env.AUTH_ENABLED = 'false';

const { handleGetRun } = await import(`../routes/runs.js?test=${Date.now()}`);

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

before(() => {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === 'http://sandbox.run-detail.test/agent-runs/run_persisted') {
      return new Response(JSON.stringify({
        run_id: 'run_persisted',
        conversation_id: 'conv_1',
        status: 'completed',
      }), { status: 200 });
    }
    if (url === 'http://agent.run-detail.test/internal/agent-runs/run_persisted') {
      return new Response(JSON.stringify({ error: 'Run not found' }), { status: 404 });
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

test('GET Run returns persisted detail when the live Agent log is missing', async () => {
  const res = responseCapture();
  await handleGetRun('run_persisted', res, { headers: {}, traceId: 'trace_1' });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    run_id: 'run_persisted',
    conversation_id: 'conv_1',
    status: 'completed',
    runtime_available: false,
  });
});
