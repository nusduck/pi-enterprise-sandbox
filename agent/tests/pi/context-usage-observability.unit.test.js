/**
 * Context pressure is observable before compaction acts on it.
 *
 * Pi's `context` event fires as each LLM call is assembled and its handler ctx
 * exposes `getContextUsage()`. Nothing subscribed to it, so how full the window
 * was could only be inferred after the fact from `session.compacted`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createObservabilityExtension,
  normalizeContextUsage,
} from '../../src/extensions/observability/index.js';

const runContext = Object.freeze({
  orgId: 'org',
  userId: 'user',
  conversationId: 'conv',
  agentSessionId: 'sess',
  runId: 'run-1',
  sandboxSessionId: 'sbx',
  traceId: 'trace',
});

/** Collects everything the extension records. */
function createRecorder() {
  const events = [];
  return {
    events,
    async record(input) {
      events.push(input);
      return null;
    },
  };
}

/** Minimal ExtensionAPI double: captures handlers by event name. */
function createPi() {
  const handlers = new Map();
  return {
    handlers,
    on(type, handler) {
      handlers.set(type, handler);
    },
    registerTool() {},
    emit(type, event, ctx) {
      const handler = handlers.get(type);
      if (!handler) throw new Error(`no handler for ${type}`);
      return handler(event, ctx);
    },
  };
}

/** @param {(number|null)[]} tokenSeries */
function ctxWithUsageSeries(tokenSeries, contextWindow = 1000) {
  let index = 0;
  return {
    getContextUsage() {
      const tokens = tokenSeries[Math.min(index, tokenSeries.length - 1)];
      index += 1;
      if (tokens === undefined) return undefined;
      return {
        tokens,
        contextWindow,
        percent: tokens == null ? null : (tokens / contextWindow) * 100,
      };
    },
  };
}

describe('normalizeContextUsage', () => {
  it('keeps unknown tokens as null instead of coercing to zero', () => {
    // Right after a compaction the SDK reports null until the next response.
    assert.deepEqual(
      normalizeContextUsage({ tokens: null, contextWindow: 1000, percent: null }),
      { tokens: null, contextWindow: 1000, percent: null },
    );
  });

  it('derives percent when the SDK omits it', () => {
    assert.deepEqual(normalizeContextUsage({ tokens: 250, contextWindow: 1000 }), {
      tokens: 250,
      contextWindow: 1000,
      percent: 25,
    });
  });

  it('rejects shapes that carry no usable number', () => {
    assert.equal(normalizeContextUsage(undefined), null);
    assert.equal(normalizeContextUsage({}), null);
    assert.equal(normalizeContextUsage({ tokens: 'lots' }), null);
  });
});

describe('context.usage events', () => {
  it('records usage for each newly assembled context', async () => {
    const recorder = createRecorder();
    const pi = createPi();
    createObservabilityExtension({
      runContext,
      deps: { recorder, modelId: 'm1', provider: 'llmio' },
    })(pi);

    const ctx = ctxWithUsageSeries([100, 400]);
    await pi.emit('context', { type: 'context', messages: [] }, ctx);
    await pi.emit('context', { type: 'context', messages: [] }, ctx);

    assert.equal(recorder.events.length, 2);
    assert.equal(recorder.events[0].type, 'context.usage');
    assert.deepEqual(recorder.events[0].data, {
      tokens: 100,
      contextWindow: 1000,
      percent: 10,
      modelId: 'm1',
      provider: 'llmio',
      sequence: 1,
    });
    assert.equal(recorder.events[1].data.tokens, 400);
    assert.equal(recorder.events[1].data.sequence, 2);
    assert.notEqual(
      recorder.events[0].dedupeKey,
      recorder.events[1].dedupeKey,
      'each assembled context needs its own durable identity',
    );
  });

  it('does not re-emit when a provider retry reuses the same context', async () => {
    const recorder = createRecorder();
    const pi = createPi();
    createObservabilityExtension({ runContext, deps: { recorder } })(pi);

    const ctx = ctxWithUsageSeries([500, 500, 500]);
    await pi.emit('context', { type: 'context', messages: [] }, ctx);
    await pi.emit('context', { type: 'context', messages: [] }, ctx);
    await pi.emit('context', { type: 'context', messages: [] }, ctx);

    assert.equal(recorder.events.length, 1);
  });

  it('stays silent when the SDK cannot report usage', async () => {
    const recorder = createRecorder();
    const pi = createPi();
    createObservabilityExtension({ runContext, deps: { recorder } })(pi);

    await pi.emit('context', { type: 'context', messages: [] }, {});
    await pi.emit(
      'context',
      { type: 'context', messages: [] },
      { getContextUsage: () => undefined },
    );

    assert.equal(recorder.events.length, 0);
  });

  it('never alters the assembled messages', async () => {
    const recorder = createRecorder();
    const pi = createPi();
    createObservabilityExtension({ runContext, deps: { recorder } })(pi);

    const result = await pi.emit(
      'context',
      { type: 'context', messages: [{ role: 'user' }] },
      ctxWithUsageSeries([10]),
    );
    assert.equal(result, undefined, 'returning a value would rewrite the context');
  });
});
