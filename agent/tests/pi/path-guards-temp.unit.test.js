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

describe('user skill path guard', () => {
  const systemSkill = '/home/sandbox/skill/hello/SKILL.md';
  const userSkill =
    '/home/sandbox/skill-user/01ORGEXAMPLEULID00000001/01USEREXAMPLEULID00000001/hello/SKILL.md';

  it('permits system and per-user skill reads when allowSkillRead is set', () => {
    assert.deepEqual(normalizeLogicalPath(systemSkill, { allowSkillRead: true }), {
      ok: true,
      path: systemSkill,
      area: 'skill',
    });
    assert.deepEqual(normalizeLogicalPath(userSkill, { allowSkillRead: true }), {
      ok: true,
      path: userSkill,
      area: 'skill',
    });
  });

  it('does not treat skill-user as a child of the system skill root', () => {
    const result = normalizeLogicalPath(userSkill, { allowSkillRead: true });
    assert.equal(result.ok, true);
    assert.equal(result.area, 'skill');
    assert.equal(result.path, userSkill);
  });

  it('denies writes to both skill tiers', () => {
    assert.equal(normalizeWritePath(systemSkill).code, 'PATH_SKILL_WRITE_DENIED');
    assert.equal(normalizeWritePath(userSkill).code, 'PATH_SKILL_WRITE_DENIED');
  });
});
