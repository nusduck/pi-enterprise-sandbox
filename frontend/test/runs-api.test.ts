import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cancelRun,
  createRun,
  followUpRun,
  isStreamTerminalRunStatus,
  steerRun,
} from '../src/shared/api/runs.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('streamRunEvents terminal detection', () => {
  it('treats true terminal statuses (and wire aliases) as terminal', () => {
    assert.equal(isStreamTerminalRunStatus('SUCCEEDED'), true);
    assert.equal(isStreamTerminalRunStatus('succeeded'), true);
    assert.equal(isStreamTerminalRunStatus('completed'), true);
    assert.equal(isStreamTerminalRunStatus('failed'), true);
    assert.equal(isStreamTerminalRunStatus('FAILED'), true);
    assert.equal(isStreamTerminalRunStatus('cancelled'), true);
    assert.equal(isStreamTerminalRunStatus('canceled'), true);
    assert.equal(isStreamTerminalRunStatus('interrupted'), true);
    assert.equal(isStreamTerminalRunStatus('budget_exceeded'), true);
    assert.equal(isStreamTerminalRunStatus('orphaned'), true);
  });

  it('does not treat parked waiting_* statuses as terminal', () => {
    // SSE must reconnect while the run is parked for human approval/input.
    assert.equal(isStreamTerminalRunStatus('waiting_approval'), false);
    assert.equal(isStreamTerminalRunStatus('WAITING_APPROVAL'), false);
    assert.equal(isStreamTerminalRunStatus('waiting_input'), false);
    assert.equal(isStreamTerminalRunStatus('WAITING_INPUT'), false);
    assert.equal(isStreamTerminalRunStatus('running'), false);
    assert.equal(isStreamTerminalRunStatus('queued'), false);
    assert.equal(isStreamTerminalRunStatus('rejected'), false);
  });
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

    await createRun({
      model_id: 'deepseek-v4-flash-vision-exp',
      messages: [{ role: 'user', content: 'hello' }],
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/runs');
    assert.equal(requests[0].init?.method, 'POST');
    const headers = requests[0].init?.headers as Record<string, string>;
    assert.match(headers['Idempotency-Key'], /^run_[A-Za-z0-9_-]+$/);
    assert.equal(
      JSON.parse(String(requests[0].init?.body)).model_id,
      'deepseek-v4-flash-vision-exp',
    );
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

    assert.deepEqual(await cancelRun('run/1'), { cancelledDescendants: [] });

    const headers = captured?.headers as Record<string, string>;
    assert.match(headers['Idempotency-Key'], /^cancel_[A-Za-z0-9_-]+$/);
  });

  it('reports the sub-agent children a cancel also stopped', async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          runId: 'run-1',
          cancelledDescendants: ['01K0G2PAV8FPMVC9QHJG7JPN60', ' '],
          cancelled_descendants: ['ignored when camelCase is present'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    assert.deepEqual(await cancelRun('run-1'), {
      cancelledDescendants: ['01K0G2PAV8FPMVC9QHJG7JPN60'],
    });
  });

  it('accepts the snake_case alias and an Agent without the field', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ cancelled_descendants: ['run-child'] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    assert.deepEqual(await cancelRun('run-1'), {
      cancelledDescendants: ['run-child'],
    });

    globalThis.fetch = async () =>
      new Response('{"runId":"run-1"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    assert.deepEqual(await cancelRun('run-1'), { cancelledDescendants: [] });
  });

  it('does not fail a completed cancel on an unparseable body', async () => {
    globalThis.fetch = async () =>
      new Response('not json', {
        status: 202,
        headers: { 'Content-Type': 'text/plain' },
      });
    assert.deepEqual(await cancelRun('run-1'), { cancelledDescendants: [] });
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
