/**
 * PR-10 BFF event-replay helpers + runs route cursor wiring.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseSseResumeCursor,
  buildAgentEventsQuery,
  dedupeBySequence,
  presentCreateRunAccepted,
} from '../src/application/event-replay-service.js';
import {
  normalizeCreateRunBody,
  readIdempotencyKeyHeader,
} from '../src/routes/runs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const EVT = '01K0G2PAV8FPMVC9QHJG7JPN58';
const RUN = '01K0G2PAV8FPMVC9QHJG7JPN53';

describe('parseSseResumeCursor', () => {
  it('parses afterSequence and after_sequence', () => {
    const sp = new URLSearchParams('afterSequence=17');
    assert.equal(parseSseResumeCursor({ searchParams: sp }).afterSequence, 17);
    const sp2 = new URLSearchParams('after_sequence=9&after=3');
    assert.equal(parseSseResumeCursor({ searchParams: sp2 }).afterSequence, 9);
  });

  it('numeric Last-Event-ID raises afterSequence', () => {
    const c = parseSseResumeCursor({
      searchParams: new URLSearchParams('after=5'),
      headers: { 'last-event-id': '12' },
    });
    assert.equal(c.afterSequence, 12);
    assert.equal(c.lastEventId, null);
  });

  it('ULID Last-Event-ID is forwarded separately', () => {
    const c = parseSseResumeCursor({
      searchParams: new URLSearchParams('afterSequence=4'),
      headers: { 'Last-Event-ID': EVT },
    });
    assert.equal(c.afterSequence, 4);
    assert.equal(c.lastEventId, EVT);
  });

  it('ignores garbage Last-Event-ID', () => {
    const c = parseSseResumeCursor({
      headers: { 'last-event-id': 'not-a-cursor' },
    });
    assert.equal(c.afterSequence, 0);
    assert.equal(c.lastEventId, null);
  });
});

describe('dedupeBySequence', () => {
  it('skips duplicates and advances cursor', () => {
    assert.deepEqual(dedupeBySequence(5, { sequence: 5 }), { emit: false, next: 5 });
    assert.deepEqual(dedupeBySequence(5, { sequence: 6 }), { emit: true, next: 6 });
    assert.deepEqual(dedupeBySequence(5, { sequence: 'x' }), { emit: false, next: 5 });
  });
});

describe('presentCreateRunAccepted', () => {
  it('fills dual keys and eventsUrl', () => {
    const p = presentCreateRunAccepted({
      run_id: RUN,
      conversation_id: 'c1',
      status: 'ACCEPTED',
    });
    assert.equal(p.runId, RUN);
    assert.equal(p.run_id, RUN);
    assert.equal(p.eventsUrl, `/api/runs/${RUN}/events`);
    assert.equal(p.status, 'ACCEPTED');
  });
});

describe('normalizeCreateRunBody', () => {
  it('accepts legacy messages[]', () => {
    const n = normalizeCreateRunBody({
      messages: [{ role: 'user', content: 'hi' }],
      conversation_id: 'c1',
    });
    assert.equal(n.error, undefined);
    assert.equal(n.messages.length, 1);
    assert.equal(n.conversation_id, 'c1');
  });

  it('accepts plan §18.3 message.content text parts', () => {
    const n = normalizeCreateRunBody({
      message: {
        content: [{ type: 'text', text: '分析已上传数据' }],
      },
    });
    assert.equal(n.error, undefined);
    assert.equal(n.messages[0].content, '分析已上传数据');
  });

  it('binds conversationId from route opts', () => {
    const n = normalizeCreateRunBody(
      { messages: [{ role: 'user', content: 'x' }] },
      { conversationId: 'conv-route' },
    );
    assert.equal(n.conversation_id, 'conv-route');
  });

  it('rejects empty body', () => {
    assert.equal(normalizeCreateRunBody({}).error.includes('messages'), true);
  });
});

describe('readIdempotencyKeyHeader', () => {
  it('reads Idempotency-Key variants', () => {
    assert.equal(
      readIdempotencyKeyHeader({ headers: { 'idempotency-key': ' k1 ' } }),
      'k1',
    );
    assert.equal(readIdempotencyKeyHeader({ headers: {} }), null);
  });
});

describe('buildAgentEventsQuery', () => {
  it('omits empty after', () => {
    assert.equal(buildAgentEventsQuery({ afterSequence: 0 }), '');
  });
  it('includes after + afterSequence', () => {
    const q = buildAgentEventsQuery({ afterSequence: 7 });
    assert.match(q, /after=7/);
    assert.match(q, /afterSequence=7/);
  });
});

describe('BFF PR-10 wiring (source contracts)', () => {
  it('server mounts conversation-scoped create runs', () => {
    const serverSrc = readFileSync(join(root, 'server.js'), 'utf8');
    assert.match(serverSrc, /\/api\/conversations\/.*\/runs/);
    assert.match(serverSrc, /Last-Event-ID/);
  });

  it('handleRunEvents uses parseSseResumeCursor and ownership first', () => {
    const runsSrc = readFileSync(join(root, 'src/routes/runs.js'), 'utf8');
    assert.match(runsSrc, /parseSseResumeCursor/);
    assert.match(runsSrc, /authorizeRunRequest/);
    assert.match(runsSrc, /openAgentRunEvents/);
    assert.match(runsSrc, /X-Accel-Buffering/);
    assert.match(runsSrc, /presentCreateRunAccepted/);
    assert.match(runsSrc, /waitForResponseDrain|proxySseUpstream/);
  });

  it('agent-client forwards Last-Event-ID', () => {
    const client = readFileSync(join(root, 'src/services/agent-client.js'), 'utf8');
    assert.match(client, /Last-Event-ID/);
    assert.match(client, /afterSequence/);
  });

  it('event-replay-service forbids in-process buffer as authority', () => {
    const src = readFileSync(
      join(root, 'src/application/event-replay-service.js'),
      'utf8',
    );
    assert.match(src, /Forbidden: process-local event buffer/);
  });
});
