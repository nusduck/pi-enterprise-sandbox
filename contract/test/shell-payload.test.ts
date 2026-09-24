/**
 * `shell-payload.ts` 的边界行为。
 *
 * 这些断言是 2026-09-16 审查 R4 的回归：当时 exec 路由把
 * `workdir/stdin/env/stdoutMaxBytes` 全部静默丢弃，HTTP 仍返回 200。
 * 现在越界与非法字段必须在执行前拒绝，合法字段必须原样解析出来。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError } from '../src/errors.js';
import {
  DEFAULT_SHELL_PAYLOAD_LIMITS,
  parseShellRunPayload,
  parseShellStartPayload,
  parseShellWorkdir,
} from '../src/shell-payload.js';

function expectInvalid(fn: () => unknown, needle?: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ContractError, `expected ContractError, got ${String(err)}`);
    assert.equal(err.code, 'ENVELOPE_INVALID');
    if (needle !== undefined) assert.match(err.message, new RegExp(needle));
    return true;
  });
}

test('workdir 缺省落在工作区根', () => {
  assert.deepEqual(parseShellWorkdir(undefined), { scope: 'workspace', relative: '' });
  assert.deepEqual(parseShellWorkdir(''), { scope: 'workspace', relative: '' });
  assert.deepEqual(parseShellWorkdir('.'), { scope: 'workspace', relative: '' });
  assert.deepEqual(parseShellWorkdir('/home/sandbox/workspace'), {
    scope: 'workspace',
    relative: '',
  });
});

test('workdir 解析出 scope 与相对段', () => {
  assert.deepEqual(parseShellWorkdir('/home/sandbox/workspace/sub/dir'), {
    scope: 'workspace',
    relative: 'sub/dir',
  });
  assert.deepEqual(parseShellWorkdir('/home/sandbox/workspace/sub/'), {
    scope: 'workspace',
    relative: 'sub',
  });
  assert.deepEqual(parseShellWorkdir('/tmp'), { scope: 'temp', relative: '' });
  assert.deepEqual(parseShellWorkdir('/tmp/build'), { scope: 'temp', relative: 'build' });
});

test('越界 workdir 被拒绝，而不是静默退回根目录', () => {
  expectInvalid(() => parseShellWorkdir('/etc'), 'must stay under');
  expectInvalid(() => parseShellWorkdir('/home/sandbox/skill'), 'must stay under');
  // 前缀相同但不是同一个根：`/tmpfoo` 不属于 `/tmp`
  expectInvalid(() => parseShellWorkdir('/tmpfoo'), 'must stay under');
  expectInvalid(() => parseShellWorkdir('relative/path'), 'absolute');
  expectInvalid(() => parseShellWorkdir('/home/sandbox/workspace/../../etc'), 'relative segments');
  expectInvalid(() => parseShellWorkdir('/home/sandbox/workspace//sub'), 'relative segments');
  expectInvalid(() => parseShellWorkdir(42), 'must be a string');
  expectInvalid(() => parseShellWorkdir('/tmp/a\u0001b'), 'control characters');
});

test('run payload 保留 stdin/env/stdoutMaxBytes/timeoutMs', () => {
  const parsed = parseShellRunPayload({
    command: 'pwd',
    workdir: '/home/sandbox/workspace/subdir',
    stdin: 'hello',
    env: { REVIEW: 'yes' },
    stdoutMaxBytes: 123,
    timeoutMs: 30_000,
  });
  assert.equal(parsed.command, 'pwd');
  assert.deepEqual(parsed.workdir, { scope: 'workspace', relative: 'subdir' });
  assert.equal(parsed.stdin, 'hello');
  assert.deepEqual(parsed.env, { REVIEW: 'yes' });
  assert.equal(parsed.stdoutMaxBytes, 123);
  assert.equal(parsed.timeoutMs, 30_000);
});

test('空字符串 stdin 与缺省 stdin 语义不同', () => {
  assert.equal(parseShellRunPayload({ command: 'cat' }).stdin, undefined);
  assert.equal(parseShellRunPayload({ command: 'cat', stdin: '' }).stdin, '');
});

test('数值字段受服务端上限约束', () => {
  const limits = { ...DEFAULT_SHELL_PAYLOAD_LIMITS, maxTimeoutMs: 1_000, maxStdoutBytes: 10 };
  expectInvalid(() => parseShellRunPayload({ command: 'x', timeoutMs: 1_001 }, limits), '<= 1000');
  expectInvalid(() => parseShellRunPayload({ command: 'x', stdoutMaxBytes: 11 }, limits), '<= 10');
  expectInvalid(() => parseShellRunPayload({ command: 'x', timeoutMs: 0 }), '>= 1');
  expectInvalid(() => parseShellRunPayload({ command: 'x', timeoutMs: 1.5 }), 'finite integer');
  expectInvalid(() => parseShellRunPayload({ command: 'x', timeoutMs: '20' }), 'finite integer');
  // 上限内的合法对照必须通过——不能靠「全部拒绝」假通过
  assert.equal(parseShellRunPayload({ command: 'x', timeoutMs: 1_000 }, limits).timeoutMs, 1_000);
});

test('env 只接受合法变量名与字符串值', () => {
  expectInvalid(() => parseShellRunPayload({ command: 'x', env: { '1BAD': 'v' } }), 'variable name');
  expectInvalid(() => parseShellRunPayload({ command: 'x', env: { OK: 1 } }), 'must be a string');
  expectInvalid(() => parseShellRunPayload({ command: 'x', env: ['OK=1'] }), 'must be an object');
  expectInvalid(
    () => parseShellRunPayload({ command: 'x', env: { A: '1', B: '2' } }, { ...DEFAULT_SHELL_PAYLOAD_LIMITS, maxEnvEntries: 1 }),
    'at most 1 entries',
  );
  assert.deepEqual(parseShellRunPayload({ command: 'x', env: { _OK9: 'v' } }).env, { _OK9: 'v' });
});

test('start payload 拒绝 timeoutMs，接受 id/runId', () => {
  expectInvalid(() => parseShellStartPayload({ command: 'x', timeoutMs: 1000 }), 'not accepted');
  const parsed = parseShellStartPayload({
    command: 'sleep 1',
    workdir: '/tmp/build',
    id: 'bash-abc123',
    runId: 'run_01ARZ3',
    env: { A: 'b' },
  });
  assert.equal(parsed.id, 'bash-abc123');
  assert.equal(parsed.runId, 'run_01ARZ3');
  assert.deepEqual(parsed.workdir, { scope: 'temp', relative: 'build' });
  assert.deepEqual(parsed.env, { A: 'b' });
  expectInvalid(() => parseShellStartPayload({ command: 'x', id: 'bad id!' }), 'must match');
});

test('command 必须是字符串', () => {
  expectInvalid(() => parseShellRunPayload({}), 'command must be a string');
  expectInvalid(() => parseShellRunPayload(null), 'must be an object');
});
