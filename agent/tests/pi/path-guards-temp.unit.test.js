import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeLogicalPath,
  normalizeWritePath,
} from '../../src/extensions/sandbox-bridge/path-guards.js';

describe('sandbox temporary path guard', () => {
  it('permits session /tmp reads and only explicitly opted-in writes', () => {
    assert.deepEqual(normalizeLogicalPath('/tmp/report.txt', { allowSkillRead: true }), {
      ok: true,
      path: '/tmp/report.txt',
      area: 'temp',
    });
    assert.deepEqual(normalizeWritePath('/tmp/report.txt', { allowTemp: true }), {
      ok: true,
      path: '/tmp/report.txt',
      area: 'temp',
    });
    assert.deepEqual(normalizeWritePath('/tmp/report.txt'), {
      ok: false,
      code: 'PATH_OUTSIDE_WORKSPACE',
      reason: 'path must be under workspace for writes',
    });
  });
});
