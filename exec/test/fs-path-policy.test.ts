/**
 * `path-policy.ts` 的纯函数单元测试——对应 Python 版
 * `tests/test_path_validation.py::TestPathValidation` 里跟 `parse_sandbox_path`/
 * `normalize_user_path` 直接相关的用例（不依赖磁盘 I/O 的部分）。
 * 涉及真实文件系统（symlink 越界、targetKey 稳定性）的用例放在
 * `fs-workspace-fs.test.ts`，因为那些需要通过 `WorkspaceFileSystem` 才能验证
 * "resolve 之后再 realpath 一次"的完整链路。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { FsError } from '@deepseek-ai/dsh-fs';
import { parseSandboxPath, toDisplayPath } from '../src/fs/path-policy.js';

function assertDenied(fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof FsError, 'expected an FsError');
    assert.equal((err as FsError).code, 'FS_SANDBOX_DENIED');
    return true;
  });
}

describe('parseSandboxPath', () => {
  test('resolves a plain relative path under the workspace scope', () => {
    const parsed = parseSandboxPath('myfile.txt');
    assert.equal(parsed.scope, 'workspace');
    assert.equal(parsed.relative, 'myfile.txt');
  });

  test('resolves a nested relative path', () => {
    const parsed = parseSandboxPath('sub/file.txt');
    assert.equal(parsed.scope, 'workspace');
    assert.equal(parsed.relative, 'sub/file.txt');
  });

  test('"." addresses the workspace root', () => {
    const parsed = parseSandboxPath('.');
    assert.equal(parsed.scope, 'workspace');
    assert.equal(parsed.relative, '.');
  });

  test('empty / whitespace-only input is treated as "."', () => {
    assert.deepEqual(parseSandboxPath(''), { scope: 'workspace', relative: '.' });
    assert.deepEqual(parseSandboxPath('   '), { scope: 'workspace', relative: '.' });
  });

  test('normalizes the legacy absolute workspace path', () => {
    const parsed = parseSandboxPath('/home/sandbox/workspace/notes/a.txt');
    assert.deepEqual(parsed, { scope: 'workspace', relative: 'notes/a.txt' });
    assert.deepEqual(parseSandboxPath('/home/sandbox/workspace'), { scope: 'workspace', relative: '.' });
  });

  test('recognizes the persistent temp root', () => {
    const parsed = parseSandboxPath('/tmp/cache/a.txt');
    assert.deepEqual(parsed, { scope: 'temp', relative: 'cache/a.txt' });
    assert.deepEqual(parseSandboxPath('/tmp'), { scope: 'temp', relative: '.' });
  });

  test('rejects parent traversal', () => {
    assertDenied(() => parseSandboxPath('../etc/passwd'));
    assertDenied(() => parseSandboxPath('sub/../outside.txt'));
    assertDenied(() => parseSandboxPath('/tmp/../etc'));
  });

  test('rejects other absolute roots', () => {
    for (const p of ['/etc/passwd', '/var/sandbox/workspaces/x', '/home/sandbox/skill/x']) {
      assertDenied(() => parseSandboxPath(p));
    }
  });

  test('rejects home expansion', () => {
    assertDenied(() => parseSandboxPath('~/secret'));
    assertDenied(() => parseSandboxPath('~'));
  });

  test('rejects windows drive letters', () => {
    assertDenied(() => parseSandboxPath('C:\\Windows\\system32'));
    assertDenied(() => parseSandboxPath('C:/Windows'));
  });

  test('rejects null bytes', () => {
    assertDenied(() => parseSandboxPath('foo\0bar'));
  });

  test('rejects non-string input at runtime', () => {
    // @ts-expect-error 故意传入错误类型，验证运行时防御（不仅是编译期类型）。
    assertDenied(() => parseSandboxPath(null));
  });

  test('cwd folds a relative path onto a validated base', () => {
    const cwd = parseSandboxPath('sub');
    const parsed = parseSandboxPath('file.txt', cwd);
    assert.deepEqual(parsed, { scope: 'workspace', relative: 'sub/file.txt' });
  });

  test('an absolute logical path ignores cwd entirely', () => {
    const cwd = parseSandboxPath('/tmp/cache');
    const parsed = parseSandboxPath('/home/sandbox/workspace/notes.txt', cwd);
    assert.deepEqual(parsed, { scope: 'workspace', relative: 'notes.txt' });
  });

  test('cwd itself is validated the same way as any path', () => {
    assertDenied(() => parseSandboxPath('file.txt', parseSandboxPath('../escape')));
  });
});

describe('toDisplayPath', () => {
  test('workspace root is "."', () => {
    assert.equal(toDisplayPath({ scope: 'workspace', relative: '.' }), '.');
  });

  test('workspace relative path passes through unchanged', () => {
    assert.equal(toDisplayPath({ scope: 'workspace', relative: 'notes/a.txt' }), 'notes/a.txt');
  });

  test('temp root renders as "/tmp"', () => {
    assert.equal(toDisplayPath({ scope: 'temp', relative: '.' }), '/tmp');
  });

  test('temp relative path renders under "/tmp/"', () => {
    assert.equal(toDisplayPath({ scope: 'temp', relative: 'cache/a.txt' }), '/tmp/cache/a.txt');
  });
});
