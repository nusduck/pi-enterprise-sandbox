/**
 * `errors.ts` 的测试：错误映射之后，物理路径必须已经被替换成
 * `<workspace>`——这是设计文档里的硬要求，泄漏物理路径是安全问题，
 * 不是格式问题。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FsError } from '@deepseek-ai/dsh-fs';

import { ContractError, redactPhysicalPaths, toWireError } from '../src/errors.js';

const PHYSICAL_ROOT = '/var/lib/pi-exec/workspaces/01K0G2PAV8FPMVC9QHJG7JPN4Z';

// `physicalRoots` is REQUIRED (no default value) on both `redactPhysicalPaths`
// and `ToWireErrorOptions` — this is deliberate fail-closed design, not an
// oversight. `redactPhysicalPaths(message)` or `toWireError(error, {})` must
// not compile: TypeScript strict makes a forgotten roots argument a build
// failure instead of a silent "nothing got redacted" at runtime. Every call
// site below passes an explicit array (possibly `[]`) precisely to keep that
// property intact — do not add a default back to make a call site shorter.

describe('redactPhysicalPaths', () => {
  it('replaces every occurrence of a physical root with <workspace>', () => {
    const message = `ENOENT: no such file or directory, open '${PHYSICAL_ROOT}/notes/report.txt' (also see ${PHYSICAL_ROOT}/notes)`;
    const redacted = redactPhysicalPaths(message, [PHYSICAL_ROOT]);
    assert.ok(!redacted.includes(PHYSICAL_ROOT), 'physical root must not survive redaction');
    assert.equal(
      redacted,
      "ENOENT: no such file or directory, open '<workspace>/notes/report.txt' (also see <workspace>/notes)",
    );
  });

  it('is a no-op for text containing no known root when an empty roots array is passed', () => {
    const message = `path is ${PHYSICAL_ROOT}/x`;
    assert.equal(redactPhysicalPaths(message, []), message);
  });

  it('redacts the longest matching root first so nested roots do not half-substitute', () => {
    const outer = '/var/lib/pi-exec';
    const inner = '/var/lib/pi-exec/workspaces/ws-1';
    const message = `${inner}/file.txt and ${outer}/shared.log`;
    const redacted = redactPhysicalPaths(message, [outer, inner]);
    assert.equal(redacted, '<workspace>/file.txt and <workspace>/shared.log');
  });

  it('redacts the hardcoded default physical prefixes even with an empty roots array (fail-closed safety net)', () => {
    const message =
      'ENOENT: /var/sandbox/workspaces/ws-1/notes.txt and /sandbox/workspaces/ws-2/other.txt';
    const redacted = redactPhysicalPaths(message, []);
    assert.ok(!redacted.includes('/var/sandbox/workspaces'));
    assert.ok(!redacted.includes('/sandbox/workspaces'));
    assert.equal(redacted, 'ENOENT: <workspace>/ws-1/notes.txt and <workspace>/ws-2/other.txt');
  });

  it('collapses accidental repeated <workspace> tokens produced by overlapping/nested roots', () => {
    // /a/b and /a/b/c both match a path that starts with /a/b/c — redacting
    // the outer root after the inner one has already fired can otherwise
    // leave a doubled token behind.
    const message = '/a/b/c is inside /a/b';
    const redacted = redactPhysicalPaths(message, ['/a/b', '/a/b/c']);
    assert.ok(!redacted.includes('<workspace><workspace>'));
    assert.equal(redacted, '<workspace> is inside <workspace>');
  });

  it('normalizes trailing slashes so a root with a trailing slash still matches text without one', () => {
    const message = `${PHYSICAL_ROOT}/report.txt`;
    const redacted = redactPhysicalPaths(message, [`${PHYSICAL_ROOT}/`]);
    assert.ok(!redacted.includes(PHYSICAL_ROOT));
    assert.equal(redacted, '<workspace>/report.txt');
  });

  it('deduplicates roots that only differ by a trailing slash without corrupting the sort order', () => {
    const message = `${PHYSICAL_ROOT}/a and /sandbox/workspaces/b`;
    const redacted = redactPhysicalPaths(message, [PHYSICAL_ROOT, `${PHYSICAL_ROOT}/`]);
    assert.equal(redacted, '<workspace>/a and <workspace>/b');
  });
});

describe('toWireError', () => {
  it('maps a ContractError, preserving its transport code, with redaction applied', () => {
    const error = new ContractError('WORKSPACE_NOT_FOUND', `workspace missing under ${PHYSICAL_ROOT}`);
    const wire = toWireError(error, { physicalRoots: [PHYSICAL_ROOT] });
    assert.equal(wire.code, 'WORKSPACE_NOT_FOUND');
    assert.ok(!wire.message.includes(PHYSICAL_ROOT));
    assert.ok(wire.message.includes('<workspace>'));
  });

  it('maps an FsError, preserving its FS_* code, with redaction applied', () => {
    const error = new FsError(`ENOENT: ${PHYSICAL_ROOT}/report.txt`, 'FS_NOT_FOUND');
    const wire = toWireError(error, { physicalRoots: [PHYSICAL_ROOT] });
    assert.equal(wire.code, 'FS_NOT_FOUND');
    assert.ok(!wire.message.includes(PHYSICAL_ROOT));
  });

  it('falls back to INTERNAL_ERROR for a plain Error, still redacted', () => {
    const error = new Error(`boom at ${PHYSICAL_ROOT}`);
    const wire = toWireError(error, { physicalRoots: [PHYSICAL_ROOT] });
    assert.equal(wire.code, 'INTERNAL_ERROR');
    assert.ok(!wire.message.includes(PHYSICAL_ROOT));
  });

  it('falls back to INTERNAL_ERROR for a non-Error thrown value', () => {
    const wire = toWireError(`raw string with ${PHYSICAL_ROOT}`, { physicalRoots: [PHYSICAL_ROOT] });
    assert.equal(wire.code, 'INTERNAL_ERROR');
    assert.ok(!wire.message.includes(PHYSICAL_ROOT));
  });

  it('never leaks a physical root when roots are supplied, across every error kind', () => {
    const candidates: unknown[] = [
      new ContractError('AUTH_FAILED', `auth failed for ${PHYSICAL_ROOT}`),
      new FsError(`stale version at ${PHYSICAL_ROOT}/x`, 'FS_STALE_VERSION'),
      new Error(`unexpected failure touching ${PHYSICAL_ROOT}`),
    ];
    for (const candidate of candidates) {
      const wire = toWireError(candidate, { physicalRoots: [PHYSICAL_ROOT] });
      assert.ok(
        !wire.message.includes(PHYSICAL_ROOT),
        `expected no physical root leak for ${String(candidate)}`,
      );
    }
  });
});
