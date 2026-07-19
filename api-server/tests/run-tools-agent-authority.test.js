import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;

process.env.AGENT_BASE_URL = 'http://agent.run-tools.test';
process.env.AUTH_ENABLED = 'false';

const { handleListRunTools } = await import(`../routes/runs.js?test=${Date.now()}`);

const RUN = '01K0G2PAV8FPMVC9QHJG7JPN5H';
const CONV = '01K0G2PAV8FPMVC9QHJG7JPN51';
const calls = [];

before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, init });
    if (path === `/internal/agent-runs/${RUN}`) {
      return new Response(
        JSON.stringify({
          run_id: RUN,
          runId: RUN,
          conversation_id: CONV,
          conversationId: CONV,
          status: 'completed',
        }),
        { status: 200 },
      );
    }
    if (path === `/internal/agent-runs/${RUN}/tools`) {
      return new Response(
        JSON.stringify({
          tools: [
            {
              tool_call_id: 'call-1',
              run_id: RUN,
              tool_name: 'bash',
              status: 'succeeded',
              arguments: { command: 'pwd' },
            },
          ],
        }),
        { status: 200 },
      );
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

function responseCapture() {
  return {
    status: 0,
    body: '',
    headers: {},
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers || {};
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

test('run tool snapshots are owner-scoped and loaded from Agent, not Sandbox', async () => {
  const response = responseCapture();
  await handleListRunTools(RUN, response, {
    headers: {},
    traceId: 'a'.repeat(32),
  });

  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.tools[0].tool_call_id, 'call-1');
  assert.deepEqual(
    calls.map((call) => call.path),
    [`/internal/agent-runs/${RUN}`, `/internal/agent-runs/${RUN}/tools`],
  );
  assert.ok(calls.every((call) => call.init.headers['X-Acting-User-Id']));
  assert.ok(calls.every((call) => call.init.headers['X-Acting-Organization-Id']));
  assert.ok(calls.every((call) => !call.path.startsWith('/tool-executions')));
});
