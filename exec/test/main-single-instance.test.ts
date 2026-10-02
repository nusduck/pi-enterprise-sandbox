/**
 * exec 启动入口必须执行单实例断言（ADR 0008 D5；`deploy/vm/dsh-exec.service` 依赖它拒绝多实例）。
 *
 * `assertSingleInstance` 曾经只实现、没接线：EXEC_CONCURRENCY=2 照样启动，进程内的工作区锁
 * 在多实例之间不成立。这里起真实的 `src/main.ts` 子进程，只看它在哪一步、以什么理由退出：
 * 断言排在取密之前，所以不需要数据库或 DBPM。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const EXEC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function startExec(env: Record<string, string>) {
  const baseEnv: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/tmp' };
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: EXEC_ROOT,
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('exec main enforces the single-instance assertion before anything else', () => {
  test('EXEC_CONCURRENCY=2 without EXEC_ALLOW_MULTI_INSTANCE refuses to start', () => {
    const result = startExec({ EXEC_CONCURRENCY: '2' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /single-instance check failed, refusing to start/);
    assert.match(result.stderr, /EXEC_ALLOW_MULTI_INSTANCE=true/);
    assert.doesNotMatch(result.stderr, /credential fetch failed/, 'the guard runs before credential fetch');
  });

  test('a non-integer EXEC_CONCURRENCY refuses to start', () => {
    const result = startExec({ EXEC_CONCURRENCY: 'two' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /invalid EXEC_CONCURRENCY/);
  });

  test('explicit EXEC_ALLOW_MULTI_INSTANCE=true passes the guard (fails later, at credential fetch)', () => {
    const result = startExec({ EXEC_CONCURRENCY: '2', EXEC_ALLOW_MULTI_INSTANCE: 'true' });
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stderr, /single-instance check failed/);
    assert.match(result.stderr, /refusing to start/);
  });

  test('the default (EXEC_CONCURRENCY unset) passes the guard', () => {
    const result = startExec({});
    assert.doesNotMatch(result.stderr, /single-instance check failed/);
  });
});
