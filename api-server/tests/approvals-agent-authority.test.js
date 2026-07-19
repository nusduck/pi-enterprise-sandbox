import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;

process.env.AGENT_BASE_URL = 'http://agent.approvals.test';
process.env.AUTH_ENABLED = 'false';

const {
  handleDecideApproval,
  handleGetApproval,
  handleListApprovals,
} = await import(`../routes/approvals.js?test=${Date.now()}`);

const APPROVAL = '01K0G2PAV8FPMVC9QHJG7JPN55';
const calls = [];

before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ origin: url.origin, path: `${url.pathname}${url.search}`, init });
    if (url.pathname === '/internal/approvals' && url.searchParams.get('status') === 'pending') {
      return new Response(JSON.stringify({ approvals: [{ approval_id: APPROVAL }] }), {
        status: 200,
      });
    }
    if (url.pathname === `/internal/approvals/${APPROVAL}`) {
      return new Response(
        JSON.stringify({ approval_id: APPROVAL, status: 'pending', tool_name: 'bash' }),
        { status: 200 },
      );
    }
    if (
      url.pathname === `/internal/approvals/${APPROVAL}/decide` &&
      init.method === 'POST'
    ) {
      return new Response(
        JSON.stringify({
          approval_id: APPROVAL,
          run_id: '01K0G2PAV8FPMVC9QHJG7JPN53',
          status: 'approved',
          changed: true,
          queued: true,
          resumePending: false,
        }),
        { status: 200 },
      );
    }
    if (url.pathname === '/internal/approvals/01K0G2PAV8FPMVC9QHJG7JPN59') {
      return new Response(JSON.stringify({ error: 'Approval not found', code: 'NOT_FOUND' }), {
        status: 404,
      });
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

test('approval list forwards owner identity and filters to Agent MySQL', async () => {
  const response = responseCapture();
  await handleListApprovals(
    new URL('http://bff.test/api/approvals?status=pending&limit=25'),
    response,
    request(),
  );
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).approvals[0].approval_id, APPROVAL);
  assert.equal(calls[0].path, '/internal/approvals?status=pending&limit=25');
  assert.ok(calls[0].init.headers['X-Acting-User-Id']);
  assert.ok(calls[0].init.headers['X-Acting-Organization-Id']);
});

test('approval detail forwards Agent response and preserves owner-scoped 404', async () => {
  const found = responseCapture();
  await handleGetApproval(APPROVAL, found, request());
  assert.equal(found.status, 200);
  assert.equal(JSON.parse(found.body).tool_name, 'bash');

  const missing = responseCapture();
  await handleGetApproval('01K0G2PAV8FPMVC9QHJG7JPN59', missing, request());
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).code, 'NOT_FOUND');
  assert.ok(calls.every((call) => !call.path.startsWith('/approvals')));
});

test('approval decision writes only through the Agent authority', async () => {
  const response = responseCapture();
  await handleDecideApproval(
    APPROVAL,
    {
      decision: 'approve',
      run_id: '01K0G2PAV8FPMVC9QHJG7JPN53',
      reason: 'reviewed',
    },
    response,
    request(),
  );

  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).status, 'approved');
  const decisionCall = calls.find((call) =>
    call.path.endsWith(`/internal/approvals/${APPROVAL}/decide`),
  );
  assert.ok(decisionCall);
  assert.equal(decisionCall.origin, 'http://agent.approvals.test');
  assert.equal(decisionCall.init.method, 'POST');
  assert.deepEqual(JSON.parse(decisionCall.init.body), {
    decision: 'approve',
    run_id: '01K0G2PAV8FPMVC9QHJG7JPN53',
    reason: 'reviewed',
  });
  assert.ok(calls.every((call) => call.path.startsWith('/internal/')));
});
