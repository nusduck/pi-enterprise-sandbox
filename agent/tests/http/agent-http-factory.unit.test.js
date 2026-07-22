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
  resolveRequestTraceContext,
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
const APPROVAL = '01K0G2PAV8FPMVC9QHJG7JPN55';
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
  let conversations;
  let approvalDecisionCalls;
  let steerCalls;
  let followUpCalls;

  before(async () => {
    created = [];
    runs = new Map();
    events = new Map();
    cancelCalled = 0;
    conversations = new Map();
    approvalDecisionCalls = [];
    steerCalls = [];
    followUpCalls = [];

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

    const conversationService = {
      async list(auth) {
        if (auth.externalUserId === 'foreign') return [];
        return [...conversations.values()];
      },
      async create(_auth, body) {
        const row = {
          id: CONV,
          title: body.title || 'New chat',
          messages: [],
          created_at: '2026-07-18T06:00:00.000Z',
          updated_at: '2026-07-18T06:00:00.000Z',
        };
        conversations.set(CONV, row);
        return row;
      },
      async get(conversationId, auth) {
        if (auth.externalUserId === 'foreign' || !conversations.has(conversationId)) {
          throw new OwnerScopedNotFoundError('Conversation not found');
        }
        return conversations.get(conversationId);
      },
      async delete(conversationId, auth) {
        await this.get(conversationId, auth);
        conversations.delete(conversationId);
      },
      async ensureSession(_auth, input) {
        return {
          conversation_id: input.conversationId || CONV,
          session_id: '01K0G2PAV8FPMVC9QHJG7JPN52',
          workspace_id: '01K0G2PAV8FPMVC9QHJG7JPN54',
          reused_session: Boolean(input.conversationId),
          status: 'ACTIVE',
        };
      },
    };

    const approval = {
      id: APPROVAL,
      approval_id: APPROVAL,
      run_id: RUN,
      conversation_id: CONV,
      tool_execution_id: '01K0G2PAV8FPMVC9QHJG7JPN56',
      tool_name: 'bash',
      status: 'pending',
      risk_level: 'high',
      reason: 'EXTERNAL_HIGH_RISK',
      arguments: { command: 'deploy' },
      payload: { toolName: 'bash' },
      user_id: '01K0G2PAV8FPMVC9QHJG7JPN50',
      created_at: '2026-07-18T06:00:00.000Z',
      expires_at: null,
      decided_at: null,
    };
    const approvalQueryService = {
      async list(auth, opts) {
        if (auth.externalUserId === 'foreign') return [];
        if (opts.status && opts.status.toLowerCase() !== approval.status) return [];
        return [approval];
      },
      async get(approvalId, auth) {
        if (auth.externalUserId === 'foreign' || approvalId !== APPROVAL) {
          throw new OwnerScopedNotFoundError('Approval not found', {
            resource: 'approvals',
            id: approvalId,
          });
        }
        return approval;
      },
    };
    const approvalDecisionService = {
      async resolve(input) {
        if (input.auth.externalUserId === 'foreign') {
          throw new OwnerScopedNotFoundError('Approval not found');
        }
        approvalDecisionCalls.push({ operation: 'resolve', ...input });
        return {
          ok: true,
          approval_id: input.approvalId,
          run_id: input.runId || RUN,
          status: input.decision === 'approve' ? 'approved' : 'rejected',
          changed: true,
          queued: true,
          resumePending: false,
        };
      },
      async resume(input) {
        if (input.auth.externalUserId === 'foreign') {
          throw new OwnerScopedNotFoundError('Run not found');
        }
        approvalDecisionCalls.push({ operation: 'resume', ...input });
        return {
          ok: false,
          approval_id: input.approvalId,
          run_id: input.runId,
          status: 'waiting_approval',
          queued: false,
          resumePending: true,
        };
      },
    };

    const steerRunService = {
      async execute(input) {
        steerCalls.push(input);
        return {
          runId: input.runId,
          steerId: '01K0G2PAV8FPMVC9QHJG7JPN57',
          messageId: '01K0G2PAV8FPMVC9QHJG7JPN58',
          sequence: 2,
          status: 'ACCEPTED',
        };
      },
    };
    const followUpService = {
      async execute(input) {
        followUpCalls.push(input);
        return {
          runId: '01K0G2PAV8FPMVC9QHJG7JPN59',
          status: 'ACCEPTED',
          conversationId: input.conversationId,
          eventsUrl: '/api/runs/01K0G2PAV8FPMVC9QHJG7JPN59/events',
          agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
        };
      },
    };
    const traceQueryService = {
      async listForRun({ runId, auth }) {
        if (auth.externalUserId === 'foreign') {
          throw new OwnerScopedNotFoundError('Trace not found', {
            resource: 'trace_spans',
          });
        }
        return {
          traceId: TRACE,
          trace_id: TRACE,
          runId,
          run_id: runId,
          spans: [
            {
              id: 'b'.repeat(16),
              spanId: 'b'.repeat(16),
              traceId: TRACE,
              runId,
              parentSpanId: null,
              kind: 'run',
              name: 'Run',
              status: 'ok',
              attributes: { eventType: 'run.completed' },
            },
          ],
        };
      },
    };

    server = createAgentHttpServer({
      createRunService,
      getRunService,
      cancelRunService,
      eventQueryService,
      conversationService,
      approvalQueryService,
      approvalDecisionService,
      steerRunService,
      followUpService,
      traceQueryService,
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
      headers: {
        'Idempotency-Key': 'k1',
        traceparent: `00-${TRACE}-bbbbbbbbbbbbbbbb-01`,
      },
      body: { messages: [{ role: 'user', content: 'hi' }] },
    });
    assert.equal(r.status, 202);
    assert.equal(r.json.runId, RUN);
    assert.equal(r.json.run_id, RUN);
    assert.equal(r.json.status, 'ACCEPTED');
    assert.equal(created.length, 1);
    assert.equal(created[0].idempotencyKey, 'k1');
    assert.equal(created[0].traceId, TRACE);
    assert.equal(created[0].spanId, 'bbbbbbbbbbbbbbbb');
  });

  it('serves durable owner-scoped trace spans after a worker restart', async () => {
    const requestTrace = 'd'.repeat(32);
    const r = await req(port, 'GET', `/internal/agent-runs/${RUN}/trace`, {
      headers: { 'X-Trace-Id': requestTrace },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.trace_id, TRACE);
    assert.equal(r.json.spans[0].kind, 'run');
    assert.equal(r.headers.get('x-trace-id'), requestTrace);

    const foreign = await req(port, 'GET', `/internal/agent-runs/${RUN}/trace`, {
      headers: {
        'X-Acting-User-Id': 'foreign',
        'X-Trace-Id': TRACE,
      },
    });
    assert.equal(foreign.status, 404);
  });

  it('serves owner-scoped conversation CRUD through the Agent endpoint', async () => {
    const createdConversation = await req(port, 'POST', '/internal/conversations', {
      body: { title: 'MySQL chat' },
    });
    assert.equal(createdConversation.status, 201);
    assert.equal(createdConversation.json.id, CONV);

    const listed = await req(port, 'GET', '/internal/conversations');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.map((row) => row.id), [CONV]);

    const loaded = await req(port, 'GET', `/internal/conversations/${CONV}`);
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.title, 'MySQL chat');

    const foreign = await req(port, 'GET', `/internal/conversations/${CONV}`, {
      headers: { 'X-Acting-User-Id': 'foreign' },
    });
    assert.equal(foreign.status, 404);

    const removed = await req(port, 'DELETE', `/internal/conversations/${CONV}`);
    assert.equal(removed.status, 204);
    const missing = await req(port, 'GET', `/internal/conversations/${CONV}`);
    assert.equal(missing.status, 404);
  });

  it('coordinates pre-upload formal session ensure with a W3C trace id', async () => {
    const ensured = await req(port, 'POST', '/internal/sessions/ensure', {
      headers: { 'X-Trace-Id': TRACE },
      body: { conversation_id: CONV },
    });
    assert.equal(ensured.status, 200);
    assert.equal(ensured.json.conversation_id, CONV);
    assert.equal(ensured.json.status, 'ACTIVE');
    assert.equal(ensured.json.trace_id, TRACE);
    assert.equal(ensured.headers.get('x-trace-id'), TRACE);
  });

  it('serves owner-scoped approval list/detail with status filtering', async () => {
    const listed = await req(port, 'GET', '/internal/approvals?status=pending&limit=10');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.approvals.map((row) => row.approval_id), [APPROVAL]);

    const filtered = await req(port, 'GET', '/internal/approvals?status=approved');
    assert.equal(filtered.status, 200);
    assert.deepEqual(filtered.json.approvals, []);

    const detail = await req(port, 'GET', `/internal/approvals/${APPROVAL}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.tool_name, 'bash');

    const foreign = await req(port, 'GET', `/internal/approvals/${APPROVAL}`, {
      headers: { 'X-Acting-User-Id': 'foreign' },
    });
    assert.equal(foreign.status, 404);
  });

  it('requires acting owner headers for approval reads', async () => {
    const missing = await req(port, 'GET', '/internal/approvals', {
      headers: {
        'X-Acting-User-Id': '',
        'X-Acting-Organization-Id': '',
      },
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'AUTH_CONTEXT_REQUIRED');
  });

  it('serves owner-scoped approval decide and resume POST endpoints', async () => {
    const decided = await req(port, 'POST', `/internal/approvals/${APPROVAL}/decide`, {
      body: { decision: 'approve', run_id: RUN, reason: 'reviewed' },
    });
    assert.equal(decided.status, 200);
    assert.equal(decided.json.status, 'approved');
    assert.equal(approvalDecisionCalls[0].operation, 'resolve');
    assert.equal(approvalDecisionCalls[0].approvalId, APPROVAL);
    assert.equal(approvalDecisionCalls[0].runId, RUN);

    const resumed = await req(
      port,
      'POST',
      `/internal/agent-runs/${RUN}/resume-approval`,
      { body: { approval_id: APPROVAL } },
    );
    assert.equal(resumed.status, 202);
    assert.equal(resumed.json.resumePending, true);
    assert.equal(approvalDecisionCalls[1].operation, 'resume');
    assert.equal(approvalDecisionCalls[1].approvalId, APPROVAL);

    const foreign = await req(
      port,
      'POST',
      `/internal/approvals/${APPROVAL}/decide`,
      {
        headers: { 'X-Acting-User-Id': 'foreign' },
        body: { decision: 'approve' },
      },
    );
    assert.equal(foreign.status, 404);
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

  it('persists steer admission and creates conversation-scoped follow-up Runs', async () => {
    const missing = await req(
      port,
      'POST',
      `/internal/agent-runs/${RUN}/steer`,
      { body: { text: 'x' } },
    );
    assert.equal(missing.status, 400);
    assert.equal(missing.json.code, 'IDEMPOTENCY_KEY_REQUIRED');

    const steer = await req(
      port,
      'POST',
      `/internal/agent-runs/${RUN}/steer`,
      {
        headers: { 'Idempotency-Key': 'steer-1', 'X-Trace-Id': TRACE },
        body: { text: 'inspect outliers', conversation_id: CONV },
      },
    );
    assert.equal(steer.status, 202);
    assert.equal(steer.json.status, 'ACCEPTED');
    assert.equal(steerCalls[0].idempotencyKey, 'steer-1');
    assert.equal(steerCalls[0].traceId, TRACE);

    const follow = await req(
      port,
      'POST',
      `/internal/conversations/${CONV}/follow-ups`,
      {
        headers: { 'Idempotency-Key': 'follow-1', 'X-Trace-Id': TRACE },
        body: { text: 'summarize' },
      },
    );
    assert.equal(follow.status, 202);
    assert.equal(follow.json.conversationId, CONV);
    assert.equal(followUpCalls[0].conversationId, CONV);
    assert.equal(followUpCalls[0].idempotencyKey, 'follow-1');
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
    assert.deepEqual(
      resolveRequestTraceContext({
        headers: {
          traceparent: `00-${TRACE}-bbbbbbbbbbbbbbbb-01`,
        },
      }),
      {
        traceId: TRACE,
        parentSpanId: 'bbbbbbbbbbbbbbbb',
        traceFlags: '01',
      },
    );
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

  it('/ready reports MCP discovery counts and fails when an enabled server is unreachable', async () => {
    const srv = createAgentHttpServer({
      createRunService: { execute: async () => ({}) },
      getRunService: { execute: async () => ({}) },
      cancelRunService: { execute: async () => ({}) },
      eventQueryService: { listEvents: async () => ({ events: [] }) },
      dataPlaneReady: true,
      sandboxHealthCheck: async () => ({ status: 'ok' }),
      mcpReadiness: () => ({
        ready: false,
        serverCount: 1,
        toolCount: 0,
        servers: [
          {
            serverId: 'crm',
            status: 'unreachable',
            toolCount: 0,
            error: 'connect ECONNREFUSED',
          },
        ],
      }),
      config: {},
    });
    const p = await listen(srv);
    try {
      const res = await fetch(`http://127.0.0.1:${p}/ready`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.mcp.status, 'unreachable');
      assert.equal(body.mcp.server_count, 1);
      assert.equal(body.mcp.servers[0].id, 'crm');
      assert.match(body.mcp.servers[0].error, /ECONNREFUSED/);
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
