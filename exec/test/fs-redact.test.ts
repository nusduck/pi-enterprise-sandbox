/**
 * `redact.ts` 单元测试——对应 Python 版
 * `tests/test_path_validation.py::TestSanitizePathError`。
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { REDACTED_ROOT_TOKEN, redactPhysicalRoots } from '../src/fs/redact.js';

describe('redactPhysicalRoots', () => {
  test('replaces a single physical root', () => {
    const physical = '/var/data/workspaces/conv_abc';
    const msg = `failed under ${physical}/file.txt`;
    const out = redactPhysicalRoots(msg, [physical]);
    assert.ok(!out.includes(physical));
    assert.ok(out.includes(REDACTED_ROOT_TOKEN));
    assert.equal(out, `failed under ${REDACTED_ROOT_TOKEN}/file.txt`);
  });

  test('replaces every configured root, none left over', () => {
    const workspaceRoot = '/var/data/workspaces/conv_abc';
    const tempRoot = '/var/data/temp/tmp_conv_abc';
    const skillRoot = '/opt/skills/system';
    const msg = `EACCES: permission denied, open '${workspaceRoot}/a.txt'; also saw ${tempRoot}/b and ${skillRoot}/pkg`;
    const out = redactPhysicalRoots(msg, [workspaceRoot, tempRoot, skillRoot]);
    assert.ok(!out.includes(workspaceRoot));
    assert.ok(!out.includes(tempRoot));
    assert.ok(!out.includes(skillRoot));
  });

  test('longer nested roots are replaced before their shorter prefixes', () => {
    const outer = '/var/data/workspaces';
    const inner = '/var/data/workspaces/conv_abc';
    const msg = `path ${inner}/file.txt is under ${outer}`;
    const out = redactPhysicalRoots(msg, [outer, inner]);
    assert.ok(!out.includes(inner));
    assert.ok(!out.includes(outer));
    // 不应该出现 "<workspace>/file.txt" 之外还残留 outer 的前缀片段。
    assert.ok(!out.includes('conv_abc'));
  });

  test('collapses doubled tokens produced by overlapping roots', () => {
    const root = '/var/data/workspaces/conv_abc';
    const msg = `${root}${root}/file.txt`;
    const out = redactPhysicalRoots(msg, [root]);
    assert.equal(out, `${REDACTED_ROOT_TOKEN}/file.txt`);
  });

  test('ignores empty/undefined root entries and trailing slashes', () => {
    const root = '/var/data/workspaces/conv_abc';
    const msg = `under ${root}/x`;
    const out = redactPhysicalRoots(msg, ['', `${root}/`]);
    assert.equal(out, `under ${REDACTED_ROOT_TOKEN}/x`);
  });

  test('leaves text without any physical root untouched', () => {
    const msg = 'cannot edit "notes/a.txt": no match for oldString';
    assert.equal(redactPhysicalRoots(msg, ['/var/data/workspaces/conv_abc']), msg);
  });

  test('passes through empty text', () => {
    assert.equal(redactPhysicalRoots('', ['/var/data/workspaces/conv_abc']), '');
  });
});
