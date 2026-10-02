/**
 * 列表分页的 BFF 面（design §2.4）——只做白名单转发，语义权威在 agent/。
 *
 * 钉住四件事：
 * 1. 只有白名单里的 query 键能到 agent：`foo` 这类未知键、以及非管理端的
 *    `scope` 一律丢掉（与 `agent-admin-client.ts` 的 `pick()` 同一条纪律）；
 * 2. agent 的响应体原样回给浏览器（`next_cursor` 不做二次加工）；
 * 3. agent 的 400 `{error, code}` 变成 BFF 的同码 400，而不是 500/REQUEST_FAILED；
 * 4. Skill 共享申请队列的 `scope=org` 由 BFF 写死，浏览器声明不了。
 *
 * `limit`/`cursor` 的**语义**不在 BFF 判：浏览器发 `limit=999` 必须原样到 agent，
 * 再由 agent 的 400 回来。这里只证明「说出去的话」和「带回来的话」。
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BFF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const originalFetch = globalThis.fetch;
const originalAgentUrl = process.env.AGENT_BASE_URL;
const originalAuthEnabled = process.env.AUTH_ENABLED;

process.env.AGENT_BASE_URL = 'http://agent.pagination.test';
process.env.AUTH_ENABLED = 'false';

const { handleListConversations } = await import(
  `../src/routes/conversations.js?test=${Date.now()}`
);
const { handleListApprovals } = await import(
  `../src/routes/approvals.js?test=${Date.now()}`
);
const { handleListCronJobs } = await import(
  `../src/routes/cron-jobs.js?test=${Date.now()}`
);
const { handleAdminSkillsRoute } = await import(
  `../src/routes/admin-skills.js?test=${Date.now()}`
);

const CONVERSATION = '01K0G2PAV8FPMVC9QHJG7JPN55';
const APPROVAL = '01K0G2PAV8FPMVC9QHJG7JPN56';
const CRON_JOB = '01K0G2PAV8FPMVC9QHJG7JPN57';
const SHARE_REQUEST = '01K0G2PAV8FPMVC9QHJG7JPN58';

const calls = [];
/** Per-test upstream body; replaced inside each test. */
let upstream = () => jsonResponse(200, {});

before(() => {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({
      origin: url.origin,
      pathname: url.pathname,
      params: Object.fromEntries(url.searchParams),
      init,
    });
    return upstream(url, init);
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalAgentUrl === undefined) delete process.env.AGENT_BASE_URL;
  else process.env.AGENT_BASE_URL = originalAgentUrl;
  if (originalAuthEnabled === undefined) delete process.env.AUTH_ENABLED;
  else process.env.AUTH_ENABLED = originalAuthEnabled;
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The shape agent/ uses for a limit out of range or an undecodable cursor. */
function validationError() {
  return jsonResponse(400, {
    error: 'limit must be between 1 and 100',
    code: 'VALIDATION_ERROR',
  });
}

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

function lastCall() {
  return calls[calls.length - 1];
}

// ── GET /api/conversations → /internal/conversations ────────────────────────

test('会话列表只转发 limit/cursor/q，响应体含 next_cursor 原样回浏览器', async () => {
  upstream = () =>
    jsonResponse(200, {
      conversations: [{ conversation_id: CONVERSATION, title: '风格指南' }],
      next_cursor: 'CURSOR-2',
    });
  const response = responseCapture();
  await handleListConversations(
    new URL(
      'http://bff.test/api/conversations?limit=30&cursor=CURSOR-1&q=%E9%A3%8E%E6%A0%BC&foo=bar&scope=org',
    ),
    response,
    request(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    conversations: [{ conversation_id: CONVERSATION, title: '风格指南' }],
    next_cursor: 'CURSOR-2',
  });
  const call = lastCall();
  assert.equal(call.origin, 'http://agent.pagination.test');
  assert.equal(call.pathname, '/internal/conversations');
  assert.deepEqual(call.params, { limit: '30', cursor: 'CURSOR-1', q: '风格' });
});

test('会话列表末页的 next_cursor=null 原样透传，不改成 undefined/省略键', async () => {
  upstream = () => jsonResponse(200, { conversations: [], next_cursor: null });
  const response = responseCapture();
  await handleListConversations(
    new URL('http://bff.test/api/conversations?cursor=CURSOR-LAST'),
    response,
    request(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { conversations: [], next_cursor: null });
  assert.deepEqual(lastCall().params, { cursor: 'CURSOR-LAST' });
});

test('会话列表：agent 的 400 VALIDATION_ERROR 变成 BFF 的 400 同码', async () => {
  upstream = () => validationError();
  const response = responseCapture();
  await handleListConversations(
    new URL('http://bff.test/api/conversations?limit=999'),
    response,
    request(),
  );

  assert.equal(response.status, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.equal(body.error, 'limit must be between 1 and 100');
  // 越界的 limit 必须真的到过 agent——BFF 不做范围判断。
  assert.deepEqual(lastCall().params, { limit: '999' });
});

// ── GET /api/approvals → /internal/approvals ────────────────────────────────

test('审批列表只转发 status/limit/cursor，响应体含 next_cursor 原样回浏览器', async () => {
  upstream = () =>
    jsonResponse(200, {
      approvals: [{ approval_id: APPROVAL, status: 'pending' }],
      next_cursor: 'CURSOR-2',
    });
  const response = responseCapture();
  await handleListApprovals(
    new URL(
      'http://bff.test/api/approvals?status=pending&limit=25&cursor=CURSOR-1&foo=bar&scope=org',
    ),
    response,
    request(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    approvals: [{ approval_id: APPROVAL, status: 'pending' }],
    next_cursor: 'CURSOR-2',
  });
  const call = lastCall();
  assert.equal(call.origin, 'http://agent.pagination.test');
  assert.equal(call.pathname, '/internal/approvals');
  assert.deepEqual(call.params, { status: 'pending', limit: '25', cursor: 'CURSOR-1' });
});

test('审批列表：空的 status 不转发（保持既有语义），cursor 仍然照传', async () => {
  upstream = () => jsonResponse(200, { approvals: [], next_cursor: null });
  const response = responseCapture();
  await handleListApprovals(
    new URL('http://bff.test/api/approvals?status=&limit=50&cursor=CURSOR-1'),
    response,
    request(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(lastCall().params, { limit: '50', cursor: 'CURSOR-1' });
});

test('审批列表：agent 的 400 VALIDATION_ERROR 变成 BFF 的 400 同码', async () => {
  upstream = () => validationError();
  const response = responseCapture();
  await handleListApprovals(
    new URL('http://bff.test/api/approvals?cursor=not-a-cursor'),
    response,
    request(),
  );

  assert.equal(response.status, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.equal(body.error, 'limit must be between 1 and 100');
  assert.deepEqual(lastCall().params, { cursor: 'not-a-cursor' });
});

// ── GET /api/cron-jobs → /internal/cron-jobs ────────────────────────────────

test('定时任务列表只转发 limit/cursor（status 也不转发），响应体原样回浏览器', async () => {
  upstream = () =>
    jsonResponse(200, {
      cron_jobs: [{ cron_job_id: CRON_JOB, name: '日报' }],
      next_cursor: 'CURSOR-2',
    });
  const response = responseCapture();
  await handleListCronJobs(
    new URL(
      'http://bff.test/api/cron-jobs?limit=50&cursor=CURSOR-1&status=pending&foo=bar&scope=org',
    ),
    response,
    request(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    cron_jobs: [{ cron_job_id: CRON_JOB, name: '日报' }],
    next_cursor: 'CURSOR-2',
  });
  const call = lastCall();
  assert.equal(call.origin, 'http://agent.pagination.test');
  assert.equal(call.pathname, '/internal/cron-jobs');
  assert.deepEqual(call.params, { limit: '50', cursor: 'CURSOR-1' });
});

test('定时任务列表：agent 的 400 VALIDATION_ERROR 变成 BFF 的 400 同码', async () => {
  upstream = () => validationError();
  const response = responseCapture();
  await handleListCronJobs(new URL('http://bff.test/api/cron-jobs?limit=999'), response, request());

  assert.equal(response.status, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.equal(body.error, 'limit must be between 1 and 100');
  assert.deepEqual(lastCall().params, { limit: '999' });
});

// ── GET /api/admin/skills/share-requests → /internal/skills/share-requests ──

test('共享申请队列：scope=org 由 BFF 写死并转发 status/limit/cursor', async () => {
  upstream = () =>
    jsonResponse(200, {
      requests: [{ request_id: SHARE_REQUEST, status: 'pending' }],
      next_cursor: 'CURSOR-2',
    });
  const response = responseCapture();
  await handleAdminSkillsRoute(
    'GET',
    '/api/admin/skills/share-requests',
    new URL(
      'http://bff.test/api/admin/skills/share-requests?status=pending&limit=50&cursor=CURSOR-1&foo=bar',
    ),
    response,
    request(),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), {
    requests: [{ request_id: SHARE_REQUEST, status: 'pending' }],
    next_cursor: 'CURSOR-2',
  });
  const call = lastCall();
  assert.equal(call.origin, 'http://agent.pagination.test');
  assert.equal(call.pathname, '/internal/skills/share-requests');
  assert.deepEqual(call.params, {
    status: 'pending',
    scope: 'org',
    limit: '50',
    cursor: 'CURSOR-1',
  });
});

test('共享申请队列：浏览器不传 scope 也仍是 org，传 scope=user 也改不掉', async () => {
  upstream = () => jsonResponse(200, { requests: [], next_cursor: null });
  const bare = responseCapture();
  await handleAdminSkillsRoute(
    'GET',
    '/api/admin/skills/share-requests',
    new URL('http://bff.test/api/admin/skills/share-requests?limit=50'),
    bare,
    request(),
  );
  assert.equal(bare.status, 200);
  assert.deepEqual(lastCall().params, { scope: 'org', limit: '50' });

  const forged = responseCapture();
  await handleAdminSkillsRoute(
    'GET',
    '/api/admin/skills/share-requests',
    new URL('http://bff.test/api/admin/skills/share-requests?scope=user&cursor=CURSOR-1'),
    forged,
    request(),
  );
  assert.equal(forged.status, 200);
  assert.deepEqual(lastCall().params, { scope: 'org', cursor: 'CURSOR-1' });
});

test('共享申请队列：agent 的 400 VALIDATION_ERROR 变成 BFF 的 400 同码', async () => {
  upstream = () => validationError();
  const response = responseCapture();
  await handleAdminSkillsRoute(
    'GET',
    '/api/admin/skills/share-requests',
    new URL('http://bff.test/api/admin/skills/share-requests?cursor=not-a-cursor'),
    response,
    request(),
  );

  assert.equal(response.status, 400);
  const body = JSON.parse(response.body);
  assert.equal(body.code, 'VALIDATION_ERROR');
  assert.equal(body.error, 'limit must be between 1 and 100');
  assert.deepEqual(lastCall().params, { scope: 'org', cursor: 'not-a-cursor' });
});

// ── 真实 HTTP 入口：server.ts 的 parsedUrl 接线 ──────────────────────────────

/**
 * 等 BFF 开始监听；失败时把子进程 stderr 一起带出来，别只剩一句 timeout。
 * 必须用进程原本的 fetch：本文件的 `globalThis.fetch` 已被上面的替身换掉，
 * 继续用它等于对着自己的桩断言，真实链路一次都没碰。
 */
async function waitForLive(port, stderr, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await originalFetch(`http://127.0.0.1:${port}/health/live`);
      if (res.status === 200) return;
      lastErr = new Error(`status ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${lastErr}; server stderr: ${stderr.text}`);
}

test('真实 HTTP 入口：会话列表 query 原样到 agent，agent 的 400 原样回浏览器', async () => {
  const seen = [];
  const agentStub = http.createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'limit must be between 1 and 100', code: 'VALIDATION_ERROR' }));
  });
  await new Promise((resolve) => agentStub.listen(0, '127.0.0.1', resolve));
  const agentPort = agentStub.address().port;

  const serverEntry = 'dist/server.js';
  assert.ok(
    fs.existsSync(path.join(BFF_ROOT, serverEntry)),
    'dist/server.js must exist; run npm run build first',
  );
  const port = 22000 + Math.floor(Math.random() * 1000);
  const stderr = { text: '' };
  const child = spawn(process.execPath, [serverEntry], {
    cwd: BFF_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      SANDBOX_BASE_URL: 'http://127.0.0.1:9',
      AGENT_BASE_URL: `http://127.0.0.1:${agentPort}`,
      AGENT_INTERNAL_TOKEN: '',
      AUTH_ENABLED: 'false',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr.on('data', (chunk) => {
    stderr.text += String(chunk);
  });

  try {
    await waitForLive(port, stderr);
    const response = await originalFetch(
      `http://127.0.0.1:${port}/api/conversations?limit=999&cursor=CURSOR-1&q=%E9%A3%8E%E6%A0%BC&foo=bar`,
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, 'VALIDATION_ERROR');
    assert.equal(body.error, 'limit must be between 1 and 100');
    // 未知键 `foo` 在真实链路上也没出去；`q` 按 URL 编码原样透传。
    assert.deepEqual(
      seen.filter((url) => url.startsWith('/internal/conversations')),
      ['/internal/conversations?limit=999&cursor=CURSOR-1&q=%E9%A3%8E%E6%A0%BC'],
    );
  } finally {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    agentStub.close();
  }
});
