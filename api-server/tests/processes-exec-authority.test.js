import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalSandboxUrl = process.env.SANDBOX_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;

process.env.AGENT_BASE_URL = 'http://agent.processes.test';
process.env.SANDBOX_BASE_URL = 'http://exec.processes.test';
process.env.AUTH_ENABLED = 'false';

const {
  handleGetProcessLogs,
  handleListProcesses,
  handleProcessAction,
  handleReadProcess,
} = await import(`../src/routes/processes.js?test=${Date.now()}`);

const PROCESS = 'bash-123456789abc';
const SESSION = '01K0G2PAV8FPMVC9QHJG7JPN52';
const WORKSPACE = '01K0G2PAV8FPMVC9QHJG7JPN53';
const calls = [];

before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ host: url.host, path: `${url.pathname}${url.search}`, init });
    if (url.host === 'agent.processes.test') {
      return Response.json({
        sandbox_session_id: SESSION,
        workspace_id: WORKSPACE,
        org_id: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
        user_id: '01K0G2PAV8FPMVC9QHJG7JPN50',
      });
    }
    if (url.pathname.includes('foreign')) {
      return Response.json(
        { error: 'Process not found', code: 'not_found' },
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
        cursor: url.searchParams.get('cursor'),
        next_cursor: '0-9',
        text: 'chunk',
      });
    }
    if (url.pathname.endsWith('/signal') || url.pathname.endsWith('/cancel')) {
      return Response.json({ process_id: PROCESS, status: 'running' });
    }
    if (url.pathname.endsWith('/processes')) {
      return Response.json({ processes: [{ process_id: PROCESS, status: 'running' }] });
    }
    return Response.json({ error: 'Process not found' }, { status: 404 });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentUrl === undefined) delete process.env.AGENT_BASE_URL;
  else process.env.AGENT_BASE_URL = originalAgentUrl;
  if (originalSandboxUrl === undefined) delete process.env.SANDBOX_BASE_URL;
  else process.env.SANDBOX_BASE_URL = originalSandboxUrl;
  if (originalAuthEnabled === undefined) delete process.env.AUTH_ENABLED;
  else process.env.AUTH_ENABLED = originalAuthEnabled;
});

function responseCapture() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(body = '') { this.body = String(body); },
  };
}

function request() {
  return { headers: {}, traceId: 'a'.repeat(32) };
}

test('BFF authorizes the session in Agent then lists exec-owned processes', async () => {
  const response = responseCapture();
  await handleListProcesses(
    new URL(`http://bff/api/processes?session_id=${SESSION}&limit=20`),
    response,
    request(),
  );
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).processes[0].process_id, PROCESS);
  assert.equal(JSON.parse(response.body).processes[0].session_id, SESSION);
  assert.ok(calls.some((item) => item.host === 'agent.processes.test'));
  const execCall = calls.find((item) => item.path === `/sessions/${WORKSPACE}/processes?limit=20`);
  assert.ok(execCall);
  assert.ok(execCall.init.headers['X-Acting-User-Id']);
  assert.ok(execCall.init.headers['X-Acting-Organization-Id']);
});

test('BFF preserves log/read cursors and session-scoped control payloads', async () => {
  const logsResponse = responseCapture();
  await handleGetProcessLogs(
    PROCESS,
    new URL(`http://bff/api/processes/x/logs?session_id=${SESSION}&offset=7&limit=50`),
    logsResponse,
    request(),
  );
  assert.equal(logsResponse.status, 200);
  assert.ok(calls.some((item) => item.path.endsWith('/logs?offset=7&limit=50')));

  const readResponse = responseCapture();
  await handleReadProcess(
    PROCESS,
    new URL(`http://bff/api/processes/x/read?session_id=${SESSION}&stream=stderr&cursor=0-7&limit=64`),
    readResponse,
    request(),
  );
  assert.equal(JSON.parse(readResponse.body).cursor, '0-7');

  const signalResponse = responseCapture();
  await handleProcessAction(
    PROCESS,
    'signal',
    { session_id: SESSION, signal: 'SIGKILL' },
    signalResponse,
    request(),
  );
  const signalCall = calls.findLast((item) => item.path.endsWith('/signal'));
  assert.deepEqual(JSON.parse(signalCall.init.body), { signal: 'SIGKILL' });
});

test('BFF requires session scope and preserves exec owner-scoped 404', async () => {
  const missing = responseCapture();
  await handleGetProcessLogs(
    PROCESS,
    new URL('http://bff/api/processes/x/logs'),
    missing,
    request(),
  );
  assert.equal(missing.status, 400);

  const foreign = responseCapture();
  await handleGetProcessLogs(
    'foreign',
    new URL(`http://bff/api/processes/x/logs?session_id=${SESSION}`),
    foreign,
    request(),
  );
  assert.equal(foreign.status, 404);
});
