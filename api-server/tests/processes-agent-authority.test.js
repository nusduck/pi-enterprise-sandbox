import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;

process.env.AGENT_BASE_URL = 'http://agent.processes.test';
process.env.AUTH_ENABLED = 'false';

const {
  handleGetProcessLogs,
  handleListProcesses,
  handleProcessAction,
  handleReadProcess,
} = await import(`../src/routes/processes.js?test=${Date.now()}`);

const PROCESS = '01K0G2PAV8FPMVC9QHJG7JPN5P';
const calls = [];

before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ path: `${url.pathname}${url.search}`, init });
    if (url.pathname.includes('01K0G2PAV8FPMVC9QHJG7JPN5X')) {
      return Response.json(
        { error: 'Process not found', code: 'NOT_FOUND' },
        { status: 404 },
      );
    }
    if (url.pathname.endsWith('/logs')) {
      return Response.json({
        stdout: 'history\n',
        stderr: '',
        next_offset: 8,
        completed: false,
        truncated: false,
      });
    }
    if (url.pathname.endsWith('/read')) {
      return Response.json({
        process_id: PROCESS,
        stream: url.searchParams.get('stream'),
        cursor: url.searchParams.get('cursor'),
        next_cursor: '0-9',
        data: 'chunk',
      });
    }
    if (url.pathname.endsWith('/signal') || url.pathname.endsWith('/cancel')) {
      return Response.json({ ok: true, status: 'running' });
    }
    if (url.pathname === '/internal/processes') {
      return Response.json({ processes: [{ process_id: PROCESS, status: 'running' }] });
    }
    return Response.json({ error: 'Process not found', code: 'NOT_FOUND' }, { status: 404 });
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
    writeHead(status) {
      this.status = status;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

function request() {
  return { headers: {}, traceId: 'a'.repeat(32) };
}

test('BFF loads process history from Agent with trusted owner headers', async () => {
  const response = responseCapture();
  await handleListProcesses(new URL('http://bff/api/processes?limit=20'), response, request());
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).processes[0].process_id, PROCESS);
  const call = calls.find((item) => item.path === '/internal/processes?limit=20');
  assert.ok(call.init.headers['X-Acting-User-Id']);
  assert.ok(call.init.headers['X-Acting-Organization-Id']);
});

test('BFF preserves log/read cursors and process control payloads', async () => {
  const logsResponse = responseCapture();
  await handleGetProcessLogs(
    PROCESS,
    new URL('http://bff/api/processes/x/logs?offset=7&limit=50'),
    logsResponse,
    request(),
  );
  assert.equal(logsResponse.status, 200);
  assert.ok(calls.some((item) => item.path.endsWith('/logs?offset=7&limit=50')));

  const readResponse = responseCapture();
  await handleReadProcess(
    PROCESS,
    new URL('http://bff/api/processes/x/read?stream=stderr&cursor=0-7&limit=64'),
    readResponse,
    request(),
  );
  assert.equal(JSON.parse(readResponse.body).cursor, '0-7');

  const signalResponse = responseCapture();
  await handleProcessAction(
    PROCESS,
    'signal',
    { signal: 'SIGKILL' },
    signalResponse,
    request(),
  );
  const signalCall = calls.findLast((item) => item.path.endsWith('/signal'));
  assert.deepEqual(JSON.parse(signalCall.init.body), { signal: 'SIGKILL' });
});

test('BFF does not soft-fail an Agent owner-scoped 404', async () => {
  const response = responseCapture();
  await handleGetProcessLogs(
    '01K0G2PAV8FPMVC9QHJG7JPN5X',
    new URL('http://bff/api/processes/x/logs'),
    response,
    request(),
  );
  assert.equal(response.status, 404);
  assert.equal(JSON.parse(response.body).code, 'NOT_FOUND');
});
