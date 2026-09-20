/**
 * K8s 部署评审 K4（docs/reviews/2026-09-19-k8s-deployment）：Worker 关停必须有界，
 * 且期限**从收到信号起算**、覆盖停后台循环（outbox 在 MySQL 挂起时可无限等待）。
 * 关消费者（停止取新作业）要在任何前置等待之前发起。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_MS,
  resolveDrainTimeout,
  runWorkerShutdown,
  withinDeadline,
} from '../../src/bootstrap/worker-drain.ts';
import { readSource } from '../support/read-source.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const never = () => new Promise(() => {});
const after = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness(overrides = {}) {
  const events = [];
  const steps = {
    markNotReady: () => events.push('notReady'),
    stopIntake: async () => {
      events.push('intake:start');
      await (overrides.intake ?? (() => Promise.resolve()))();
      events.push('intake:done');
    },
    stopBackground: async () => {
      events.push('background:start');
      await (overrides.background ?? (() => Promise.resolve()))();
      events.push('background:done');
    },
    teardown: async () => {
      events.push('teardown:start');
      await (overrides.teardown ?? (() => Promise.resolve()))();
      events.push('teardown:done');
    },
    closeProbe: async () => events.push('probeClosed'),
    exit: (code) => events.push(`exit:${code}`),
    log: () => {},
  };
  return { steps, events };
}

describe('worker bounded shutdown', () => {
  it('clean path: intake + background drain, then teardown, exit 0', async () => {
    const { steps, events } = harness();
    const outcome = await runWorkerShutdown('SIGTERM', steps, { drainTimeoutMs: 1_000 });
    assert.equal(outcome, 'clean');
    assert.equal(events[0], 'notReady');
    assert.ok(events.indexOf('teardown:start') > events.indexOf('intake:done'));
    assert.ok(events.indexOf('teardown:start') > events.indexOf('background:done'));
    assert.equal(events.at(-1), 'exit:0');
  });

  it('a hung outbox does not delay stopping intake and is bounded by the drain deadline', async () => {
    const { steps, events } = harness({ background: never });
    const started = Date.now();
    const outcome = await runWorkerShutdown('SIGTERM', steps, { drainTimeoutMs: 80 });
    assert.equal(outcome, 'drain_deadline');
    assert.ok(Date.now() - started < 1_000);
    // 消费者在后台循环结束之前就已关闭（停止取新作业）。
    assert.ok(events.includes('intake:done'));
    assert.ok(!events.includes('background:done'));
    assert.ok(!events.includes('teardown:start'), 'no teardown while something may still write');
    assert.deepEqual(events.slice(-2), ['probeClosed', 'exit:1']);
  });

  it('a job outliving the window exits 1 without teardown', async () => {
    const { steps, events } = harness({ intake: never });
    const outcome = await runWorkerShutdown('SIGTERM', steps, { drainTimeoutMs: 50 });
    assert.equal(outcome, 'drain_deadline');
    assert.ok(!events.includes('teardown:start'));
    assert.equal(events.at(-1), 'exit:1');
  });

  it('the budget is shared from the signal: steps run in parallel, not back to back', async () => {
    const { steps } = harness({ intake: () => after(60), background: () => after(60) });
    const outcome = await runWorkerShutdown('SIGTERM', steps, { drainTimeoutMs: 100 });
    assert.equal(outcome, 'clean');
  });

  it('intake is started before background work is awaited', async () => {
    const { steps, events } = harness({ background: () => after(30) });
    await runWorkerShutdown('SIGTERM', steps, { drainTimeoutMs: 1_000 });
    assert.ok(events.indexOf('intake:start') < events.indexOf('background:done'));
  });

  it('a hung teardown is bounded too', async () => {
    const { steps, events } = harness({ teardown: never });
    const outcome = await runWorkerShutdown('SIGTERM', steps, {
      drainTimeoutMs: 1_000,
      teardownTimeoutMs: 50,
    });
    assert.equal(outcome, 'teardown_deadline');
    assert.equal(events.at(-1), 'exit:1');
  });

  it('withinDeadline treats a failing step as done', async () => {
    assert.equal(await withinDeadline(async () => { throw new Error('x'); }, 1_000), 'done');
    assert.equal(await withinDeadline(never, 20), 'deadline');
  });

  it('parses the timeout and rejects invalid values', () => {
    assert.equal(resolveDrainTimeout(undefined), DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_MS);
    assert.equal(resolveDrainTimeout(''), DEFAULT_AGENT_WORKER_DRAIN_TIMEOUT_MS);
    assert.equal(resolveDrainTimeout('30000'), 30_000);
    for (const bad of ['0', '999', '3600001', '1e4', '-5', 'abc', '10.5']) {
      assert.throws(() => resolveDrainTimeout(bad), /AGENT_WORKER_DRAIN_TIMEOUT_MS/);
    }
  });

  it('worker-main routes shutdown through the bounded sequence', () => {
    const src = readSource(path.join(__dirname, '../../src/bootstrap/worker-main.js'));
    assert.match(src, /resolveDrainTimeout\(env\.AGENT_WORKER_DRAIN_TIMEOUT_MS\)/);
    assert.match(src, /runWorkerShutdown\(/);
    // 信号处理里不得在关消费者之前串行等待 outbox / cron / 守卫。
    const handler = src.slice(src.indexOf('const shutdown = async'));
    const beforeCall = handler.slice(0, handler.indexOf('runWorkerShutdown('));
    assert.doesNotMatch(beforeCall.replace(/await\s*$/, ''), /await /);
    // 守卫在关停中不得 resume 消费者。
    assert.match(src, /resume: \(\) => \{\s*if \(shuttingDown\) return;/);
  });
});
