/**
 * createPromiseTail first-error latch (PR-06 review).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPromiseTail } from '../../src/application/promise-tail.js';

describe('createPromiseTail', () => {
  it('runs subsequent work after a failure and flush rethrows first error', async () => {
    const tail = createPromiseTail();
    const order = [];
    tail.enqueue(async () => {
      order.push(1);
      throw new Error('first-boom');
    });
    tail.enqueue(async () => {
      order.push(2);
    });
    tail.enqueue(async () => {
      order.push(3);
    });
    await assert.rejects(() => tail.flush(), /first-boom/);
    assert.deepEqual(order, [1, 2, 3]);
    // Subsequent flush still throws the latched first error
    await assert.rejects(() => tail.flush(), /first-boom/);
  });

  it('flush succeeds when no errors', async () => {
    const tail = createPromiseTail();
    let n = 0;
    tail.enqueue(async () => {
      n += 1;
    });
    await tail.flush();
    assert.equal(n, 1);
  });
});
