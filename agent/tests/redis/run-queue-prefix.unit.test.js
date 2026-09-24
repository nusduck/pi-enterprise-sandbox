/**
 * BullMQ prefix 的 hash tag 约束（ADR 0011 D9）。
 *
 * 负对照：旧的无 tag 前缀 `bull` 在建 Queue/Worker 之前就被拒；正对照：默认 `{bull}`
 * 与环境独立的 `{dsh-test-bull}` 通过。校验先于 bullmq 加载，所以不需要 Redis。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRunQueue,
  createRunWorker,
  DEFAULT_AGENT_RUN_QUEUE_PREFIX,
  RedisConfigError,
  resolveRunQueuePrefix,
} from '../../src/infrastructure/redis/index.js';

const URL = 'redis://127.0.0.1:6379/0';

describe('run queue prefix hash tag', () => {
  it('defaults to {bull} when unset or blank', () => {
    assert.equal(DEFAULT_AGENT_RUN_QUEUE_PREFIX, '{bull}');
    assert.equal(resolveRunQueuePrefix(undefined), '{bull}');
    assert.equal(resolveRunQueuePrefix(null), '{bull}');
    assert.equal(resolveRunQueuePrefix('  '), '{bull}');
  });

  it('accepts environment-specific tagged prefixes', () => {
    assert.equal(resolveRunQueuePrefix('{dsh-test-bull}'), '{dsh-test-bull}');
    assert.equal(resolveRunQueuePrefix(' {bull} '), '{bull}');
    assert.equal(resolveRunQueuePrefix('env:{bull}'), 'env:{bull}');
  });

  it('rejects untagged, empty-tag and malformed prefixes', () => {
    for (const bad of ['bull', '{}', '{bull', 'bull}', '}{bull', 'a{}b', '{bu ll}', `{${'x'.repeat(70)}}`]) {
      assert.throws(() => resolveRunQueuePrefix(bad), RedisConfigError, bad);
    }
  });

  it('Queue and Worker factories refuse an untagged prefix before touching Redis', () => {
    assert.throws(() => createRunQueue(URL, { prefix: 'bull' }), RedisConfigError);
    assert.throws(
      () => createRunWorker(URL, async () => {}, { prefix: 'bull' }),
      RedisConfigError,
    );
  });
});
