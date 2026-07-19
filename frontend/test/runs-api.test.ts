import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelRun,
  createRun,
  followUpRun,
  steerRun,
} from '../src/shared/api/runs.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('Run API idempotency headers', () => {
  it('adds a fresh run idempotency key to create requests', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ run_id: 'run-1', status: 'ACCEPTED' }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await createRun({ messages: [{ role: 'user', content: 'hello' }] });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/runs');
    assert.equal(requests[0].init?.method, 'POST');
    const headers = requests[0].init?.headers as Record<string, string>;
    assert.match(headers['Idempotency-Key'], /^run_[A-Za-z0-9_-]+$/);
  });

  it('adds a cancel-specific idempotency key', async () => {
    let captured: RequestInit | undefined;
    globalThis.fetch = async (_url, init) => {
      captured = init;
      return new Response('{}', {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    assert.equal(await cancelRun('run/1'), true);

    const headers = captured?.headers as Record<string, string>;
    assert.match(headers['Idempotency-Key'], /^cancel_[A-Za-z0-9_-]+$/);
  });

  it('adds a steer idempotency key and preserves the run-scoped path', async () => {
    let capturedUrl = '';
    let captured: RequestInit | undefined;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      captured = init;
      return new Response('{}', {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await steerRun('run/1', { text: 'change direction', conversation_id: 'conv-1' });

    assert.equal(capturedUrl, '/api/runs/run%2F1/steer');
    const headers = captured?.headers as Record<string, string>;
    assert.match(headers['Idempotency-Key'], /^steer_[A-Za-z0-9_-]+$/);
  });

  it('creates follow-up Runs through the conversation-scoped API', async () => {
    let capturedUrl = '';
    let captured: RequestInit | undefined;
    globalThis.fetch = async (url, init) => {
      capturedUrl = String(url);
      captured = init;
      return new Response(JSON.stringify({
        run_id: 'run-next',
        conversation_id: 'conv/1',
        agent_session_id: 'agent-session-1',
        status: 'ACCEPTED',
      }), {
        status: 202,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const created = await followUpRun('conv/1', { text: 'next task' });

    assert.equal(capturedUrl, '/api/conversations/conv%2F1/follow-ups');
    const headers = captured?.headers as Record<string, string>;
    assert.match(headers['Idempotency-Key'], /^follow_up_[A-Za-z0-9_-]+$/);
    assert.equal(created.run_id, 'run-next');
    assert.equal(created.agent_session_id, 'agent-session-1');
    assert.deepEqual(JSON.parse(String(captured?.body)), {
      text: 'next task',
      agent_id: null,
    });
  });
});
