/**
 * P1b：认证 mutation 串行闸门。login/register/logout 会写共享的 HttpOnly
 * Cookie，并发时「过期响应被丢弃」并不够——Cookie 已被改写。这里按行为证明：
 * 两个认证操作不会同时进入临界区，且前一个失败不会卡死后续操作。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthMutationGate } from '../src/features/chat/authMutationGate.ts';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('auth mutation gate', () => {
  it('never lets two auth mutations run concurrently', async () => {
    const gate = createAuthMutationGate();
    const releaseFirst = deferred();
    let active = 0;
    let maxActive = 0;
    const events: string[] = [];

    const first = gate.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('login:start');
      await releaseFirst.promise;
      events.push('login:adopt');
      active -= 1;
    });
    const second = gate.run(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      events.push('logout:start');
      active -= 1;
    });

    await tick();
    // 第一个还卡在 API 调用里时，第二个必须连临界区都还没进。
    assert.deepEqual(events, ['login:start']);
    assert.equal(maxActive, 1);
    assert.equal(gate.pending(), 2);

    releaseFirst.resolve();
    await first;
    await second;
    assert.deepEqual(events, ['login:start', 'login:adopt', 'logout:start']);
    assert.equal(maxActive, 1);
    assert.equal(gate.pending(), 0);
  });

  it('keeps running later mutations after an earlier one fails', async () => {
    const gate = createAuthMutationGate();
    const ran: string[] = [];

    const failed = gate.run(async () => {
      ran.push('failed-login');
      throw new Error('login rejected');
    });
    const afterFailure = gate.run(async () => {
      ran.push('logout');
      return 'ok';
    });

    await assert.rejects(() => failed, /login rejected/);
    assert.equal(await afterFailure, 'ok');
    assert.deepEqual(ran, ['failed-login', 'logout']);
    assert.equal(gate.pending(), 0);
  });

  it('preserves FIFO order for queued mutations', async () => {
    const gate = createAuthMutationGate();
    const order: number[] = [];
    const results = await Promise.all([
      gate.run(async () => {
        await tick();
        order.push(1);
        return 'one';
      }),
      gate.run(async () => {
        order.push(2);
        return 'two';
      }),
      gate.run(async () => {
        order.push(3);
        return 'three';
      }),
    ]);
    assert.deepEqual(order, [1, 2, 3]);
    assert.deepEqual(results, ['one', 'two', 'three']);
  });
});
