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

  // Node lowercases inbound header names, so a real request always presents
  // `last-event-id` regardless of how the browser cased it.
  it('ULID Last-Event-ID is forwarded separately', () => {
    const c = parseSseResumeCursor({
      searchParams: new URLSearchParams('afterSequence=4'),
      headers: { 'last-event-id': EVT },
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

describe('presentCreateRunAccepted', () => {
  it('fills events_url and emits one spelling per field', () => {
    const p = presentCreateRunAccepted({
      run_id: RUN,
      conversation_id: 'c1',
      status: 'ACCEPTED',
    });
    assert.equal(p.run_id, RUN);
    assert.equal(p.conversation_id, 'c1');
    assert.equal(p.events_url, `/api/runs/${RUN}/events`);
    assert.equal(p.status, 'ACCEPTED');
    assert.equal(Object.hasOwn(p, 'runId'), false);
    assert.equal(Object.hasOwn(p, 'eventsUrl'), false);
  });

  it('surfaces sandbox session for upload and artifact download', () => {
    const sandbox = '01K0G2PAV8FPMVC9QHJG7JPN5F';
    const p = presentCreateRunAccepted({
      run_id: RUN,
      conversation_id: 'c1',
      agent_session_id: '01K0G2PAV8FPMVC9QHJG7JPN52',
      sandbox_session_id: sandbox,
      status: 'ACCEPTED',
    });
    // Both names survive: uploads read session_id, run-scoped callers read
    // sandbox_session_id.
    assert.equal(p.session_id, sandbox);
    assert.equal(p.sandbox_session_id, sandbox);
    assert.equal(p.agent_session_id, '01K0G2PAV8FPMVC9QHJG7JPN52');
    assert.equal(Object.hasOwn(p, 'sandboxSessionId'), false);
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
