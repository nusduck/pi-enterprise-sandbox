/**
 * 管理端 Run 查询：角色 fail-closed、org 作用域、跨 org 404、参数校验、统计与游标。
 * SQL 本身由 tests/mysql/admin-run-read-repository.integration.test.js 在真实 MySQL 上验证。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AdminRunQueryService,
  computeRunStats,
  decodeCursor,
  encodeCursor,
  parseStatusFilter,
} from '../../src/application/admin-run-query-service.js';
import {
  AdminRoleRequiredError,
  OwnerScopedNotFoundError,
  ValidationError,
} from '../../src/application/errors.js';
import { handleAdminRunRoute } from '../../src/presentation/http/admin-run-routes.js';
import { userMessageText } from '../../src/infrastructure/mysql/repositories/admin-run-read-repository.js';

const ORG_A = '01M29ZHZV8VF2G344QZFM9MKDN';
const ORG_B = '01M3ZZZZZZZZZZZZZZZZZZZZZZ';
const RUN_A = '01M3BG9T8TAQ9TG6QVM4J1W43Q';
const RUN_B = '01M3BCX4SMZVRGR234KHY0FMMN';

const ADMIN = { provider: 'bff', externalOrgId: 'org-a', externalUserId: 'u1', role: 'admin' };
const MEMBER = { ...ADMIN, role: 'user' };
const NO_ROLE = { ...ADMIN, role: null };

function row(runId, orgId, over = {}) {
  return {
    runId, orgId, status: 'SUCCEEDED', statusReason: null, source: 'web', userId: '01M2T4AHKZFTPB5WYQD4M7YHDY',
    userName: 'alice', conversationId: null, conversationTitle: '标题', agentId: null, agentName: 'default',
    agentVersionId: null, agentVersionNo: 2, modelId: null, parentRunId: null, traceId: 't', toolCount: 3,
    approvalCount: 1, createdAt: '2026-09-25T05:00:00.000Z', startedAt: '2026-09-25T05:00:00.000Z',
    completedAt: '2026-09-25T05:00:30.000Z', updatedAt: '2026-09-25T05:00:30.000Z', ...over,
  };
}

/** In-memory stand-in that honours the org scope the real SQL applies. */
function fakeRead() {
  const runs = [row(RUN_A, ORG_A), row(RUN_B, ORG_B)];
  const calls = [];
  return {
    calls,
    async listRuns(orgId, f) {
      calls.push(['listRuns', orgId, f]);
      return runs.filter((r) => r.orgId === orgId).slice(0, f.limit);
    },
    async getRun(orgId, runId) {
      return runs.find((r) => r.orgId === orgId && r.runId === runId) ?? null;
    },
    async getTriggeringText() { return '你好'; },
    async listForStats(orgId, since) {
      calls.push(['listForStats', orgId, since.toISOString()]);
      return { rows: [], waiting: [] };
    },
    async listEvents(orgId, runId, opts) {
      calls.push(['listEvents', orgId, runId, opts]);
      return [{ runId, sequenceNo: 1, eventId: 'e1', eventType: 'run.accepted', eventVersion: 1, payloadJson: { data: {} }, createdAt: 'x' }];
    },
    async listTools(orgId, runId) {
      return [{ toolExecutionId: 't1', runId, toolCallId: 'c1', toolName: 'bash', status: 'SUCCEEDED', argumentsJson: {}, resultJson: null }];
    },
  };
}

function service(read = fakeRead()) {
  return new AdminRunQueryService({
    readRepository: read,
    resolveOrgId: async () => ORG_A,
    now: () => new Date('2026-09-25T08:00:00.000Z'),
  });
}

describe('AdminRunQueryService — access', () => {
  it('refuses callers without the admin role, including a missing role', async () => {
    for (const auth of [MEMBER, NO_ROLE, { ...ADMIN, role: '' }]) {
      await assert.rejects(service().list(auth), AdminRoleRequiredError);
      await assert.rejects(service().get(auth, RUN_A), AdminRoleRequiredError);
      await assert.rejects(service().stats(auth), AdminRoleRequiredError);
    }
  });

  it('lets an admin list and read runs of their own org', async () => {
    const read = fakeRead();
    const listed = await service(read).list(ADMIN);
    assert.deepEqual(listed.runs.map((r) => r.run_id), [RUN_A]);
    assert.equal(read.calls[0][1], ORG_A);
    const detail = await service(read).get(ADMIN, RUN_A);
    assert.equal(detail.run_id, RUN_A);
    assert.equal(detail.user_name, 'alice');
    assert.equal(detail.tool_count, 3);
    assert.equal(detail.user_input, '你好');
  });

  it('answers another org’s run and a missing run with the same 404', async () => {
    for (const id of [RUN_B, '01M3AAAAAAAAAAAAAAAAAAAAAA', 'not-a-ulid']) {
      await assert.rejects(service().get(ADMIN, id), OwnerScopedNotFoundError);
      await assert.rejects(service().events(ADMIN, id), OwnerScopedNotFoundError);
      await assert.rejects(service().tools(ADMIN, id), OwnerScopedNotFoundError);
    }
  });

  it('reads events and tools only after the run is found in the org', async () => {
    const read = fakeRead();
    const { events } = await service(read).events(ADMIN, RUN_A, { afterSequence: '0', limit: '100' });
    assert.deepEqual(events[0], {
      run_id: RUN_A, sequence: 1, event_id: 'e1', type: 'run.accepted', schema_version: 1, payload: { data: {} }, created_at: 'x',
    });
    assert.deepEqual(read.calls.at(-1), ['listEvents', ORG_A, RUN_A, { afterSequence: 0, limit: 100 }]);
    const { tools } = await service(read).tools(ADMIN, RUN_A);
    assert.equal(tools[0].toolName, 'bash');
  });
});

describe('AdminRunQueryService — parameters', () => {
  it('validates filters before touching the database', async () => {
    const read = fakeRead();
    const s = service(read);
    await assert.rejects(s.list(ADMIN, { limit: '0' }), ValidationError);
    await assert.rejects(s.list(ADMIN, { limit: '201' }), ValidationError);
    await assert.rejects(s.list(ADMIN, { status: 'bogus' }), ValidationError);
    await assert.rejects(s.list(ADMIN, { agentId: 'x' }), ValidationError);
    await assert.rejects(s.list(ADMIN, { from: 'yesterday' }), ValidationError);
    await assert.rejects(s.list(ADMIN, { cursor: 'garbage' }), ValidationError);
    await assert.rejects(s.events(ADMIN, RUN_A, { limit: '5000' }), ValidationError);
    await assert.rejects(s.stats(ADMIN, { dayStart: '2026-09-20T00:00:00.000Z' }), ValidationError);
    assert.equal(read.calls.filter((c) => c[0] === 'listRuns').length, 0);
  });

  it('maps status groups to plan §10 statuses', () => {
    assert.deepEqual(parseStatusFilter('waiting'), ['WAITING_APPROVAL', 'WAITING_INPUT']);
    assert.deepEqual(parseStatusFilter('failed,SUCCEEDED'), ['FAILED', 'SUCCEEDED']);
    assert.deepEqual(parseStatusFilter(''), []);
  });

  it('pages with an opaque keyset cursor', async () => {
    const cursor = encodeCursor({ createdAt: '2026-09-25T05:00:00.000Z', runId: RUN_A });
    assert.deepEqual(decodeCursor(cursor), { createdAt: '2026-09-25T05:00:00.000Z', runId: RUN_A });
    const read = fakeRead();
    await service(read).list(ADMIN, { cursor, limit: '1' });
    const [, , f] = read.calls[0];
    assert.deepEqual(f.before, { createdAt: '2026-09-25T05:00:00.000Z', runId: RUN_A });
    assert.equal(f.limit, 2, 'fetches one extra row to know whether a next page exists');
  });

  it('computes stats from the caller’s local day start', async () => {
    const read = fakeRead();
    await service(read).stats(ADMIN, { dayStart: '2026-09-24T16:00:00.000Z' });
    assert.deepEqual(read.calls[0], ['listForStats', ORG_A, '2026-09-18T16:00:00.000Z']);
  });
});

describe('computeRunStats', () => {
  it('counts today / yesterday / failures / waiting and the 7-day series', () => {
    const dayStart = new Date('2026-09-24T16:00:00.000Z'); // 00:00 in UTC+8
    const now = new Date('2026-09-25T08:00:00.000Z');
    const r = (createdAt, status = 'SUCCEEDED', durMs = 10_000) => ({
      status, createdAt, startedAt: createdAt, completedAt: new Date(Date.parse(createdAt) + durMs).toISOString(), updatedAt: createdAt,
    });
    const s = computeRunStats(
      [
        r('2026-09-25T01:00:00.000Z'),
        r('2026-09-25T02:00:00.000Z', 'FAILED', 30_000),
        r('2026-09-24T15:59:00.000Z'), // yesterday in UTC+8
        r('2026-09-18T17:00:00.000Z'), // six days ago
      ],
      [{ status: 'WAITING_APPROVAL', createdAt: null, startedAt: null, completedAt: null, updatedAt: '2026-09-25T07:00:00.000Z' }],
      dayStart,
      now,
    );
    assert.equal(s.today, 2);
    assert.equal(s.yesterday, 1);
    assert.equal(s.failed_today, 1);
    assert.equal(s.failure_rate, 0.5);
    assert.equal(s.waiting, 1);
    assert.equal(s.longest_wait_ms, 3_600_000);
    assert.deepEqual(s.last_7_days, [1, 0, 0, 0, 0, 1, 2]);
    assert.equal(s.median_ms, 10_000);
    assert.equal(s.p95_ms, 30_000);
  });
});

describe('admin run routes', () => {
  function call(path, { method = 'GET', headers = {}, svc = service() } = {}) {
    const res = { status: 0, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = b ? JSON.parse(b) : null; }, setHeader() {} };
    const req = { method, headers: { 'x-acting-user-id': 'u1', 'x-acting-organization-id': 'org-a', ...headers } };
    const parsedUrl = new URL(`http://agent${path}`);
    return handleAdminRunRoute({ req, res, parsedUrl, path: parsedUrl.pathname, adminRunQueryService: svc }).then((handled) => ({ handled, res }));
  }

  it('ignores other paths', async () => {
    assert.equal((await call('/internal/agent-runs')).handled, false);
  });

  it('returns 403 without the admin role and 200 with it', async () => {
    const denied = await call('/internal/admin/runs', { headers: { 'x-acting-role': 'user' } });
    assert.equal(denied.res.status, 403);
    const ok = await call('/internal/admin/runs?status=completed', { headers: { 'x-acting-role': 'admin' } });
    assert.equal(ok.res.status, 200);
    assert.equal(ok.res.body.runs[0].run_id, RUN_A);
  });

  it('returns 404 for another org’s run and presents tools like the owner endpoint', async () => {
    const headers = { 'x-acting-role': 'admin' };
    assert.equal((await call(`/internal/admin/runs/${RUN_B}`, { headers })).res.status, 404);
    const tools = await call(`/internal/admin/runs/${RUN_A}/tools`, { headers });
    assert.equal(tools.res.status, 200);
    assert.equal(tools.res.body.tools[0].tool_call_id, 'c1');
    assert.equal(tools.res.body.tools[0].status, 'succeeded');
  });

  it('rejects writes and missing identity', async () => {
    assert.equal((await call('/internal/admin/runs', { method: 'POST' })).res.status, 405);
    const res = { status: 0, body: null, writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } };
    await handleAdminRunRoute({ req: { method: 'GET', headers: {} }, res, parsedUrl: new URL('http://a/internal/admin/runs'), path: '/internal/admin/runs', adminRunQueryService: service() });
    assert.equal(res.status, 400);
  });
});

describe('userMessageText', () => {
  it('reads the stored user message shape and older ones', () => {
    // Shape of tbl_agsvc_messages.content_json for user turns.
    assert.equal(userMessageText({ text: '今天星期几？', agentId: null, messages: [{ role: 'user', content: '今天星期几？' }] }), '今天星期几？');
    assert.equal(userMessageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb');
    assert.equal(userMessageText('plain'), 'plain');
    assert.equal(userMessageText({ text: '' }), null);
    assert.equal(userMessageText(null), null);
  });
});
