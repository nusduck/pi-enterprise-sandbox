/**
 * Context compaction is observable and configurable.
 *
 * Two things were broken:
 *   1. `session.compacted` was deduped on a field SessionCompactEvent does not
 *      have (`timestamp`), so a second threshold compaction in one Run was
 *      silently dropped from the durable event stream.
 *   2. applyContextPolicy was dead code — AgentVersion.contextPolicy never
 *      reached Pi's settings manager, so autoCompact/reserveTokens/
 *      keepRecentTokens could not be configured per agent.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent';

import { createObservabilityExtension } from '../../src/extensions/observability/index.js';
import { resolveCompactionSettings } from '../../src/application/context-policy-service.js';
import {
  bindAgentVersionConfig,
  resolveAgentVersionBindings,
  PINNED_PI_SDK_VERSION,
} from '../../src/infrastructure/pi/pi-runtime-factory.js';

const RUN_CTX = Object.freeze({
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  conversationId: '01K0G2PAV8FPMVC9QHJG7JPN51',
  agentSessionId: '01K0G2PAV8FPMVC9QHJG7JPN52',
  runId: '01K0G2PAV8FPMVC9QHJG7JPN5H',
  sandboxSessionId: null,
  traceId: 'b'.repeat(32),
});

/** Recorder double that keeps every record() call and honours dedupeKey. */
function recordingRecorder() {
  const seen = new Set();
  const records = [];
  return {
    records,
    async record(input) {
      if (input.dedupeKey) {
        if (seen.has(input.dedupeKey)) return null;
        seen.add(input.dedupeKey);
      }
      records.push(input);
      return { eventId: `evt-${records.length}` };
    },
  };
}

/** @param {object} recorder */
async function compactionHandler(recorder) {
  const handlers = [];
  const obs = createObservabilityExtension({
    runContext: RUN_CTX,
    deps: { recorder },
  });
  await obs({
    on(event, handler) {
      if (event === 'session_compact') handlers.push(handler);
    },
  });
  assert.equal(handlers.length, 1, 'observability must handle session_compact');
  return handlers[0];
}

/** @param {string} id */
function compactEvent(id, reason = 'threshold') {
  return {
    type: 'session_compact',
    reason,
    willRetry: false,
    fromExtension: false,
    compactionEntry: {
      type: 'compaction',
      id,
      parentId: 'entry-0',
      timestamp: '2026-07-18T00:00:00.000Z',
      summary: 'summary text',
      firstKeptEntryId: `kept-${id}`,
      tokensBefore: 120_000,
    },
  };
}

describe('compaction observability', () => {
  it('records one session.compacted per compaction, keyed on the entry id', async () => {
    const recorder = recordingRecorder();
    const handle = await compactionHandler(recorder);

    // Two threshold compactions in the same Run — the case the old dedupeKey
    // collapsed into one event.
    await handle(compactEvent('cmp-1'));
    await handle(compactEvent('cmp-2'));

    const compactions = recorder.records.filter(
      (r) => r.type === 'session.compacted',
    );
    assert.equal(compactions.length, 2);
    assert.deepEqual(
      compactions.map((r) => r.dedupeKey),
      ['session.compacted:cmp-1', 'session.compacted:cmp-2'],
    );
    assert.equal(compactions[0].data.reason, 'threshold');
    assert.equal(compactions[0].data.compactionId, 'cmp-1');
    assert.equal(compactions[0].data.firstKeptEntryId, 'kept-cmp-1');
    assert.equal(compactions[0].data.tokensBefore, 120_000);
  });

  it('still dedupes a genuine replay of the same compaction', async () => {
    const recorder = recordingRecorder();
    const handle = await compactionHandler(recorder);

    await handle(compactEvent('cmp-1'));
    await handle(compactEvent('cmp-1'));

    assert.equal(
      recorder.records.filter((r) => r.type === 'session.compacted').length,
      1,
    );
  });

  it('records the event even when no compaction entry is attached', async () => {
    const recorder = recordingRecorder();
    const handle = await compactionHandler(recorder);

    await handle({ type: 'session_compact', reason: 'manual', willRetry: false });

    const [record] = recorder.records.filter(
      (r) => r.type === 'session.compacted',
    );
    assert.ok(record, 'must not silently drop the event');
    assert.equal(record.data.compactionId, null);
  });
});

describe('AgentVersion compaction policy', () => {
  /** @param {object} configJson */
  function bind(configJson) {
    return bindAgentVersionConfig({
      agentVersionId: '01K0G2PAV8FPMVC9QHJG7JPN5E',
      piSdkVersion: PINNED_PI_SDK_VERSION,
      configJson,
    });
  }

  it('reaches the runtime bindings', () => {
    const bindings = resolveAgentVersionBindings(
      bind({ contextPolicy: { autoCompact: false, reserveTokens: 4_096 } }),
      {},
    );
    assert.deepEqual(bindings.contextPolicy, {
      autoCompact: false,
      reserveTokens: 4_096,
    });
  });

  it('is an empty object when unset, so the SDK defaults stand', () => {
    const bindings = resolveAgentVersionBindings(bind({}), {});
    assert.deepEqual(bindings.contextPolicy, {});

    // Pi's own defaults: auto-compact on, 16k reserve, 20k kept recent.
    assert.deepEqual(
      resolveCompactionSettings({}, DEFAULT_COMPACTION_SETTINGS),
      { enabled: true, reserveTokens: 16_384, keepRecentTokens: 20_000 },
    );
  });

  it('turns compaction off and resizes the window when configured', () => {
    assert.deepEqual(
      resolveCompactionSettings({
        autoCompact: false,
        reserveTokens: 8_192,
        keepRecentTokens: 30_000,
      }),
      { enabled: false, reserveTokens: 8_192, keepRecentTokens: 30_000 },
    );
  });
});
