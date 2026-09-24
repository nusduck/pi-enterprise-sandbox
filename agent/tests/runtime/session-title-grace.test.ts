/**
 * 会话 dispose 前给在途模型标题的有界窗口（infrastructure/dsh/session-title-grace.ts）。
 * 事件序列照抄 2026-09-25 dev 真实链路里短回答 Run 的会话日志。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  titleRequestPending,
  waitForPendingTitle,
} from '../../src/infrastructure/dsh/session-title-grace.js';

const FALLBACK = { type: 'session/title', data: { title: '帮我比较一下', source: { kind: 'fallback' } } };
const REQUEST = { type: 'session/title-llm-request', data: {} };
const PROVIDER = { type: 'session/title', data: { title: 'Python 与 Go 对比', source: { kind: 'provider' } } };
const TURN_END = { type: 'turn/end', data: {} };

/** 只推进虚拟时钟，不真睡。 */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('titleRequestPending', () => {
  it('is pending after a request with no model title yet (the short-answer case)', () => {
    assert.equal(titleRequestPending([FALLBACK, REQUEST, TURN_END]), true);
  });
  it('is settled once the model title landed, and on later turns', () => {
    assert.equal(titleRequestPending([FALLBACK, REQUEST, PROVIDER, TURN_END]), false);
    assert.equal(titleRequestPending([FALLBACK, REQUEST, PROVIDER, TURN_END, { type: 'turn/start' }, TURN_END]), false);
  });
  it('never waits when no title was requested', () => {
    assert.equal(titleRequestPending([FALLBACK, TURN_END]), false);
    assert.equal(titleRequestPending([]), false);
  });
});

describe('waitForPendingTitle', () => {
  it('returns immediately when nothing is in flight', async () => {
    const clock = fakeClock();
    assert.equal(await waitForPendingTitle(() => [FALLBACK, TURN_END], clock), 'none');
    assert.equal(clock.now(), 0);
  });

  it('waits until the model title lands', async () => {
    const clock = fakeClock();
    const log: Array<Record<string, unknown>> = [FALLBACK, REQUEST, TURN_END];
    const sleep = async (ms: number) => {
      await clock.sleep(ms);
      if (clock.now() >= 800) log.push(PROVIDER);
    };
    assert.equal(await waitForPendingTitle(() => log, { now: clock.now, sleep }), 'landed');
    assert.ok(clock.now() >= 800 && clock.now() < 1_000);
  });

  it('gives up at the grace limit instead of holding the Run', async () => {
    const clock = fakeClock();
    assert.equal(await waitForPendingTitle(() => [REQUEST], { ...clock, graceMs: 2_000 }), 'gave-up');
    assert.ok(clock.now() >= 2_000 && clock.now() < 2_200);
  });
});
