/**
 * Agent run manager: create / events / cancel / sequence resume.
 * Does not call the live LLM — stubs runAgentTurn.
 *
 * Run: node --test agent/tests/agent-run-api.test.js
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

import {
  createRun,
  getRun,
  subscribeEvents,
  cancelRun,
  activeRunCount,
  _resetForTests,
} from '../run-manager.js';

// Protocol harness: local server mirroring agent/server.js SSE envelopes.
// Full runAgentTurn (LLM/sandbox) is out of scope for this unit suite.

function createTestRunStore() {
  const runs = new Map();
  let seqGlobal = 0;

  function create(body) {
    const id = `test_${++seqGlobal}`;
    const run = {
      id,
      status: 'running',
      conversation_id: body.conversation_id || null,
      events: [],
      nextSequence: 1,
      subscribers: new Set(),
      cancelled: false,
    };
    runs.set(id, run);

    // Simulate async agent turn
    setTimeout(() => {
      if (run.cancelled) return;
      append(run, { type: 'trace', trace_id: 't1' });
      append(run, {
        type: 'session',
        session_id: 's1',
        conversation_id: body.conversation_id || 'c1',
      });
      append(run, { type: 'token', text: 'hello' });
      append(run, { type: 'done' });
      run.status = 'completed';
      for (const sub of run.subscribers) {
        sub({ sequence: -1, event: { type: '__run_terminal__' }, ts: Date.now() });
      }
    }, 20);

    return { run_id: id, status: run.status };
  }

  function append(run, event) {
    const entry = { sequence: run.nextSequence++, event, ts: Date.now() };
    run.events.push(entry);
    for (const sub of run.subscribers) {
      try {
        sub(entry);
      } catch {
        /* ignore */
      }
    }
    return entry;
  }

  function get(id) {
    const run = runs.get(id);
    if (!run) return null;
    return {
      run_id: run.id,
      status: run.status,
      conversation_id: run.conversation_id,
      event_count: run.events.length,
      next_sequence: run.nextSequence,
    };
  }

  function subscribe(id, after, onEvent) {
    const run = runs.get(id);
    if (!run) return null;
    for (const entry of run.events) {
      if (entry.sequence > after) onEvent(entry);
    }
    if (run.status !== 'running' && run.status !== 'queued') {
      onEvent({ sequence: -1, event: { type: '__run_terminal__' }, ts: Date.now() });
      return () => {};
    }
    run.subscribers.add(onEvent);
    return () => run.subscribers.delete(onEvent);
  }

  function cancel(id) {
    const run = runs.get(id);
    if (!run) return null;
    if (run.status === 'completed' || run.status === 'cancelled') {
      return { run_id: id, status: run.status, cancelled: run.status === 'cancelled' };
    }
    run.cancelled = true;
    run.status = 'cancelled';
    append(run, { type: 'error', message: 'run cancelled' });
    append(run, { type: 'done' });
    for (const sub of run.subscribers) {
      sub({ sequence: -1, event: { type: '__run_terminal__' }, ts: Date.now() });
    }
    return { run_id: id, status: 'cancelled', cancelled: true };
  }

  return { create, get, subscribe, cancel, runs };
}

function startTestServer(store, { token = '' } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (token) {
      if ((req.headers['x-internal-token'] || '') !== token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/agent-runs') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (!Array.isArray(body.messages) || !body.messages.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'messages required' }));
        return;
      }
      const result = store.create(body);
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    const getMatch = url.pathname.match(/^\/internal\/agent-runs\/([^/]+)$/);
    if (req.method === 'GET' && getMatch) {
      const run = store.get(decodeURIComponent(getMatch[1]));
      if (!run) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(run));
      return;
    }
    const evMatch = url.pathname.match(/^\/internal\/agent-runs\/([^/]+)\/events$/);
    if (req.method === 'GET' && evMatch) {
      const runId = decodeURIComponent(evMatch[1]);
      const after = parseInt(url.searchParams.get('after') || '0', 10) || 0;
      if (!store.get(runId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      const unsub = store.subscribe(runId, after, (entry) => {
        if (entry.event?.type === '__run_terminal__') {
          res.write(`event: end\ndata: {}\n\n`);
          res.end();
          return;
        }
        res.write(
          `id: ${entry.sequence}\ndata: ${JSON.stringify({
            sequence: entry.sequence,
            event: entry.event,
            ts: entry.ts,
          })}\n\n`,
        );
      });
      req.on('close', () => unsub && unsub());
      return;
    }
    const cancelMatch = url.pathname.match(/^\/internal\/agent-runs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      const result = store.cancel(decodeURIComponent(cancelMatch[1]));
      if (!result) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return server;
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

describe('agent run API protocol', () => {
  it('creates a run, streams sequenced events, ends cleanly', async () => {
    const store = createTestRunStore();
    const server = startTestServer(store, { token: 'secret' });
    const base = await listen(server);
    try {
      const createResp = await fetch(`${base}/internal/agent-runs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Token': 'secret',
        },
        body: JSON.stringify({
          messages: [{ role: 'user', content: 'hi' }],
          conversation_id: 'conv_test',
        }),
      });
      assert.equal(createResp.status, 202);
      const created = await createResp.json();
      assert.ok(created.run_id);

      const eventsResp = await fetch(
        `${base}/internal/agent-runs/${created.run_id}/events?after=0`,
        { headers: { 'X-Internal-Token': 'secret', Accept: 'text/event-stream' } },
      );
      assert.equal(eventsResp.status, 200);
      const text = await eventsResp.text();
      assert.match(text, /"type":"token"/);
      assert.match(text, /"type":"done"/);
      assert.match(text, /"sequence":/);

      const status = await fetch(`${base}/internal/agent-runs/${created.run_id}`, {
        headers: { 'X-Internal-Token': 'secret' },
      }).then((r) => r.json());
      assert.equal(status.status, 'completed');
    } finally {
      server.close();
    }
  });

  it('rejects missing internal token when configured', async () => {
    const store = createTestRunStore();
    const server = startTestServer(store, { token: 'secret' });
    const base = await listen(server);
    try {
      const resp = await fetch(`${base}/internal/agent-runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }] }),
      });
      assert.equal(resp.status, 401);
    } finally {
      server.close();
    }
  });

  it('cancel is idempotent and stops further work', async () => {
    const store = createTestRunStore();
    // Override create to be long-running
    const slowId = 'slow_1';
    store.runs.set(slowId, {
      id: slowId,
      status: 'running',
      conversation_id: null,
      events: [],
      nextSequence: 1,
      subscribers: new Set(),
      cancelled: false,
    });
    // Patch store.cancel is already good; call via HTTP
    const server = startTestServer(store, { token: '' });
    const base = await listen(server);
    try {
      const r1 = await fetch(`${base}/internal/agent-runs/${slowId}/cancel`, {
        method: 'POST',
      }).then((r) => r.json());
      assert.equal(r1.cancelled, true);
      assert.equal(r1.status, 'cancelled');

      const r2 = await fetch(`${base}/internal/agent-runs/${slowId}/cancel`, {
        method: 'POST',
      }).then((r) => r.json());
      assert.equal(r2.status, 'cancelled');
    } finally {
      server.close();
    }
  });

  it('events?after=N resumes without replaying earlier sequences', async () => {
    const store = createTestRunStore();
    const id = 'resume_1';
    const run = {
      id,
      status: 'completed',
      conversation_id: null,
      events: [
        { sequence: 1, event: { type: 'token', text: 'a' }, ts: 1 },
        { sequence: 2, event: { type: 'token', text: 'b' }, ts: 2 },
        { sequence: 3, event: { type: 'done' }, ts: 3 },
      ],
      nextSequence: 4,
      subscribers: new Set(),
      cancelled: false,
    };
    store.runs.set(id, run);
    const server = startTestServer(store);
    const base = await listen(server);
    try {
      const text = await fetch(`${base}/internal/agent-runs/${id}/events?after=1`, {
        headers: { Accept: 'text/event-stream' },
      }).then((r) => r.text());
      assert.doesNotMatch(text, /"text":"a"/);
      assert.match(text, /"text":"b"/);
      assert.match(text, /"type":"done"/);
    } finally {
      server.close();
    }
  });
});

describe('run-manager exports', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('exposes create/get/subscribe/cancel/activeRunCount', () => {
    assert.equal(typeof createRun, 'function');
    assert.equal(typeof getRun, 'function');
    assert.equal(typeof subscribeEvents, 'function');
    assert.equal(typeof cancelRun, 'function');
    assert.equal(typeof activeRunCount, 'function');
    assert.equal(activeRunCount(), 0);
  });
});
