import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SKILL_ROOTS,
  commandTouchesSkillRoot,
  isUnderSkillRoot,
  normalizeSkillRoots,
  resolveSkillPath,
} from '../skills/paths.js';
import { resolveSkillRoots } from '../skills/manager.js';
import {
  LOGICAL_SKILL_ROOTS,
  redactEmbeddedHostPaths,
} from '../lib/text-redaction.js';

const CANONICAL_SKILL_ROOT = '/home/sandbox/skill';
const REMOVED_COMPATIBILITY_ROOTS = ['/sandbox/skills', '/app/.pi/skills'];

test('Skill path policy exposes only the canonical logical root', () => {
  assert.deepEqual(DEFAULT_SKILL_ROOTS, [CANONICAL_SKILL_ROOT]);
  assert.deepEqual(normalizeSkillRoots(), [CANONICAL_SKILL_ROOT]);
  assert.deepEqual(resolveSkillRoots({ SKILLS_ROOT: CANONICAL_SKILL_ROOT }), [
    CANONICAL_SKILL_ROOT,
  ]);
  assert.deepEqual(LOGICAL_SKILL_ROOTS, [CANONICAL_SKILL_ROOT]);

  assert.equal(isUnderSkillRoot(`${CANONICAL_SKILL_ROOT}/pdf/SKILL.md`), true);
  assert.equal(
    commandTouchesSkillRoot(`python ${CANONICAL_SKILL_ROOT}/pdf/run.py`),
    true,
  );

  for (const root of REMOVED_COMPATIBILITY_ROOTS) {
    assert.equal(isUnderSkillRoot(`${root}/pdf/SKILL.md`), false);
    assert.equal(commandTouchesSkillRoot(`python ${root}/pdf/run.py`), false);
    assert.throws(
      () => resolveSkillPath(`${root}/pdf/SKILL.md`, CANONICAL_SKILL_ROOT),
      /outside skill root/,
    );
  }
});

test('host-path redaction preserves only the canonical Skill root', () => {
  const canonical = `${CANONICAL_SKILL_ROOT}/pdf/SKILL.md`;
  assert.equal(redactEmbeddedHostPaths(canonical), canonical);
  for (const root of REMOVED_COMPATIBILITY_ROOTS) {
    const output = redactEmbeddedHostPaths(`${root}/pdf/SKILL.md`);
    assert.ok(!output.includes(root));
    assert.match(output, /\[redacted-path\]/);
  }
});
