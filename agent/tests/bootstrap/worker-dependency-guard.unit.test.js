/**
 * Worker 依赖守卫：依赖连续失败时暂停取任务，连续恢复后继续；只恢复自己造成的暂停。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS,
  FAILURES_BEFORE_PAUSE,
  SUCCESSES_BEFORE_RESUME,
  resolveDependencyCheckInterval,
  startWorkerDependencyGuard,
} from '../../src/bootstrap/worker-dependency-guard.js';

const UP = { mysql: true, redis: true };
const MYSQL_DOWN = { mysql: false, redis: true };
const REDIS_DOWN = { mysql: true, redis: false };

/** 定时器间隔设成 1 小时，全部探测由 checkNow 驱动，结果确定。 */
function harness(sequence, overrides = {}) {
  const calls = { pause: 0, resume: 0, logs: [] };
  let index = 0;
  const guard = startWorkerDependencyGuard({
    intervalMs: 3_600_000,
    check: async () => {
      const next = sequence[Math.min(index, sequence.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    pause: async () => {
      calls.pause += 1;
    },
    resume: () => {
      calls.resume += 1;
    },
    log: (level, message) => calls.logs.push(`${level}:${message}`),
    ...overrides,
  });
  return { guard, calls };
}

async function checks(guard, n) {
  for (let i = 0; i < n; i += 1) await guard.checkNow();
}

describe('resolveDependencyCheckInterval', () => {
  it('defaults when empty and rejects invalid values', () => {
    assert.equal(resolveDependencyCheckInterval(undefined), DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS);
    assert.equal(resolveDependencyCheckInterval(''), DEFAULT_DEPENDENCY_CHECK_INTERVAL_MS);
    assert.equal(resolveDependencyCheckInterval('1500'), 1500);
    for (const bad of ['0', '499', '600001', 'fast', '1e4', '-5']) {
      assert.throws(() => resolveDependencyCheckInterval(bad), /AGENT_WORKER_DEPENDENCY_CHECK_INTERVAL_MS/, bad);
    }
  });
});

describe('startWorkerDependencyGuard', () => {
  it('thresholds are two consecutive checks each way', () => {
    assert.equal(FAILURES_BEFORE_PAUSE, 2);
    assert.equal(SUCCESSES_BEFORE_RESUME, 2);
  });

  it('a single failure does not pause; two consecutive failures do', async () => {
    const { guard, calls } = harness([MYSQL_DOWN, UP, MYSQL_DOWN, REDIS_DOWN]);
    await checks(guard, 2);
    assert.equal(calls.pause, 0, 'failure then success must not pause');
    await checks(guard, 2);
    assert.equal(calls.pause, 1);
    assert.equal(guard.pausedByGuard(), true);
    assert.ok(calls.logs.some((l) => l.startsWith('warn:') && l.includes('redis')), calls.logs.join('|'));
    await guard.stop();
  });

  it('flapping recovery does not resume; two consecutive successes do', async () => {
    const { guard, calls } = harness([MYSQL_DOWN, MYSQL_DOWN, UP, MYSQL_DOWN, UP, UP]);
    await checks(guard, 2);
    assert.equal(calls.pause, 1);
    await checks(guard, 2);
    assert.equal(calls.resume, 0, 'one success between failures must not resume');
    await checks(guard, 2);
    assert.equal(calls.resume, 1);
    assert.equal(guard.pausedByGuard(), false);
    await guard.stop();
  });

  it('never resumes a consumer it did not pause, and pauses only once while down', async () => {
    const { guard, calls } = harness([UP, UP, UP, MYSQL_DOWN, MYSQL_DOWN, MYSQL_DOWN, MYSQL_DOWN]);
    await checks(guard, 3);
    assert.equal(calls.resume, 0);
    await checks(guard, 4);
    assert.equal(calls.pause, 1, 'stays paused without re-calling pause');
    await guard.stop();
  });

  it('a throwing check counts as unavailable', async () => {
    const { guard, calls } = harness([new Error('boom'), new Error('boom')]);
    await checks(guard, 2);
    assert.equal(calls.pause, 1);
    await guard.stop();
  });

  it('a failed pause stays unpaused and retries on the next failing check', async () => {
    let attempts = 0;
    const { guard } = harness([MYSQL_DOWN], {
      pause: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('redis gone');
      },
    });
    await checks(guard, 2);
    assert.equal(guard.pausedByGuard(), false);
    await checks(guard, 1);
    assert.equal(attempts, 2);
    assert.equal(guard.pausedByGuard(), true);
    await guard.stop();
  });

  it('checks never overlap, and stop ends scheduling without resuming', async () => {
    let active = 0;
    let maxActive = 0;
    let resumed = 0;
    const guard = startWorkerDependencyGuard({
      intervalMs: 500,
      check: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 20));
        active -= 1;
        return MYSQL_DOWN;
      },
      pause: async () => {},
      resume: () => {
        resumed += 1;
      },
    });
    await Promise.all([guard.checkNow(), guard.checkNow(), guard.checkNow()]);
    assert.equal(maxActive, 1);
    assert.equal(guard.pausedByGuard(), true);
    await guard.stop();
    assert.equal(resumed, 0);
  });
});
