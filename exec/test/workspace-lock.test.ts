/**
 * `exec/src/workspace/lock.ts` 单测——`InProcessWorkspaceLock` 是
 * `WorkspaceLock` 接口（ADR 0008 D5 预留扩展点）的默认实现。
 *
 * 没有对应的 Python 用例：Python 版的等价物是 `fcntl.flock`（同机多进程
 * 安全），我们这里换成了一个纯进程内的接口 + 默认实现，这是移植过程中
 * 主动做的架构调整（不是遗漏），见任务报告。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InProcessWorkspaceLock } from '../src/workspace/lock.js';

test('same key: critical sections never overlap, run in call order', async () => {
  const lock = new InProcessWorkspaceLock();
  const events: string[] = [];

  async function section(label: string, delayMs: number): Promise<void> {
    await lock.withLock('ws_a', async () => {
      events.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push(`${label}:end`);
    });
  }

  await Promise.all([section('first', 20), section('second', 0)]);

  assert.deepEqual(events, ['first:start', 'first:end', 'second:start', 'second:end']);
});

test('different keys: critical sections run concurrently, not serialized', async () => {
  const lock = new InProcessWorkspaceLock();
  const events: string[] = [];

  async function section(key: string, label: string, delayMs: number): Promise<void> {
    await lock.withLock(key, async () => {
      events.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      events.push(`${label}:end`);
    });
  }

  await Promise.all([section('ws_a', 'a', 20), section('ws_b', 'b', 0)]);

  // 不同 key 互不阻塞：b 的 start/end 应该都发生在 a 结束之前。
  assert.deepEqual(events, ['a:start', 'b:start', 'b:end', 'a:end']);
});

test('a failed critical section does not deadlock the key: the next queued call still runs', async () => {
  const lock = new InProcessWorkspaceLock();
  const events: string[] = [];

  const failing = lock
    .withLock('ws_c', async () => {
      events.push('failing');
      throw new Error('boom');
    })
    .catch((err: unknown) => {
      events.push(`caught:${(err as Error).message}`);
    });

  const following = lock.withLock('ws_c', async () => {
    events.push('following');
  });

  await Promise.all([failing, following]);

  // 锁的释放发生在临界区 settle 时，不等待调用方的 .catch。
  // `following` 与 `caught:boom` 都是对同一拒绝的微任务反应，谁先注册谁先执行；
  // `following` 的排队（nextTail）注册早于调用方后加的 .catch，因此它先于 catch。
  // 这是正确的并发语义——锁不应等待业务层的错误处理完成才释放。
  assert.deepEqual(events, ['failing', 'following', 'caught:boom']);
});

test('withLock returns the callback result and propagates its rejection', async () => {
  const lock = new InProcessWorkspaceLock();
  const value = await lock.withLock('ws_d', async () => 42);
  assert.equal(value, 42);

  await assert.rejects(
    lock.withLock('ws_e', async () => {
      throw new Error('nope');
    }),
    /nope/,
  );
});
