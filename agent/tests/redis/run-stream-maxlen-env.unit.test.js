/**
 * AGENT_RUN_STREAM_MAXLEN 必须真正生效（2026-10-03 文档一致性盘点发现：deployment.md 与 compose 都写着可调，
 * 但 RunEventStream 的两处装配从未传入，改了不生效）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RUN_STREAM_MAXLEN, runStreamMaxLenFromEnv } from '../../src/infrastructure/redis/constants.js';
import { RunEventStream } from '../../src/infrastructure/redis/run-event-stream.js';

describe('runStreamMaxLenFromEnv', () => {
  it('unset / empty → default', () => {
    assert.equal(runStreamMaxLenFromEnv({}), RUN_STREAM_MAXLEN);
    assert.equal(runStreamMaxLenFromEnv({ AGENT_RUN_STREAM_MAXLEN: '' }), RUN_STREAM_MAXLEN);
  });

  it('a valid integer is honored', () => {
    assert.equal(runStreamMaxLenFromEnv({ AGENT_RUN_STREAM_MAXLEN: '5000' }), 5000);
    assert.equal(runStreamMaxLenFromEnv({ AGENT_RUN_STREAM_MAXLEN: ' 20000 ' }), 20000);
  });

  it('invalid or out-of-range values fall back to the default and warn', () => {
    const warnings = [];
    const warn = (m) => warnings.push(m);
    for (const raw of ['abc', '0', '-5', '12.5', '50', '2000000']) {
      assert.equal(runStreamMaxLenFromEnv({ AGENT_RUN_STREAM_MAXLEN: raw }, warn), RUN_STREAM_MAXLEN, raw);
    }
    assert.equal(warnings.length, 6);
    assert.match(warnings[0], /AGENT_RUN_STREAM_MAXLEN/);
  });
});

describe('RunEventStream honors the configured maxLen on XADD', () => {
  it('passes MAXLEN ~ <configured>', async () => {
    const calls = [];
    const redis = { xadd: async (...args) => { calls.push(args); return '1-0'; }, xrange: async () => [] };
    const stream = new RunEventStream(redis, { maxLen: runStreamMaxLenFromEnv({ AGENT_RUN_STREAM_MAXLEN: '4321' }) });
    assert.equal(stream.maxLen, 4321);
  });
});
