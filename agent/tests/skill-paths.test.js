import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SKILL_ROOTS,
  commandTouchesSkillRoot,
  isUnderSkillRoot,
  isReadonlySkillExecution,
  normalizeSkillRoots,
  resolveSkillPath,
  skillRootsForIdentity,
  userSkillRootFor,
  writableSkillRoot,
} from '../src/skills/paths.js';
import { resolveSkillRoots } from '../src/skills/manager.js';
import {
  LOGICAL_SKILL_ROOTS,
  redactEmbeddedHostPaths,
} from '../src/lib/text-redaction.js';

const CANONICAL_SKILL_ROOT = '/home/sandbox/skill';
const CANONICAL_USER_SKILL_ROOT = '/home/sandbox/skill-user';
const CANONICAL_ROOTS = [CANONICAL_SKILL_ROOT, CANONICAL_USER_SKILL_ROOT];
const REMOVED_COMPATIBILITY_ROOTS = ['/sandbox/skills', '/app/.pi/skills'];
const ORG = '01K0G2PAV8FPMVC9QHJG7JPN4Z';
const USER = '01K0G2PAV8FPMVC9QHJG7JPN50';

test('Skill path policy exposes only the canonical logical roots', () => {
  assert.deepEqual(DEFAULT_SKILL_ROOTS, CANONICAL_ROOTS);
  assert.deepEqual(normalizeSkillRoots(), CANONICAL_ROOTS);
  assert.deepEqual(resolveSkillRoots({}), CANONICAL_ROOTS);
  assert.deepEqual(LOGICAL_SKILL_ROOTS, CANONICAL_ROOTS);

  for (const root of CANONICAL_ROOTS) {
    assert.equal(isUnderSkillRoot(`${root}/pdf/SKILL.md`), true, root);
    assert.equal(commandTouchesSkillRoot(`python ${root}/pdf/run.py`), true, root);
  }

  for (const root of REMOVED_COMPATIBILITY_ROOTS) {
    assert.equal(isUnderSkillRoot(`${root}/pdf/SKILL.md`), false);
    assert.equal(commandTouchesSkillRoot(`python ${root}/pdf/run.py`), false);
    assert.throws(
      () => resolveSkillPath(`${root}/pdf/SKILL.md`, CANONICAL_SKILL_ROOT),
      /outside skill root/,
    );
  }
});

test('only a per-user directory is writable; system root and user base never are', () => {
  // The mount roots alone give no install target: the base only holds
  // per-user directories, so a package written there would belong to nobody.
  assert.equal(writableSkillRoot(), null);
  assert.equal(writableSkillRoot([CANONICAL_SKILL_ROOT]), null);
  assert.equal(writableSkillRoot([CANONICAL_USER_SKILL_ROOT]), null);

  const mine = `${CANONICAL_USER_SKILL_ROOT}/${ORG}/${USER}`;
  assert.equal(writableSkillRoot([CANONICAL_SKILL_ROOT, mine]), mine);
});

test('per-user skill directories are identity-scoped and traversal-proof', () => {
  assert.equal(
    userSkillRootFor({ orgId: ORG, userId: USER }),
    `${CANONICAL_USER_SKILL_ROOT}/${ORG}/${USER}`,
  );
  assert.deepEqual(skillRootsForIdentity({ orgId: ORG, userId: USER }), [
    CANONICAL_SKILL_ROOT,
    `${CANONICAL_USER_SKILL_ROOT}/${ORG}/${USER}`,
  ]);

  // No identity → system tier only; never the shared base.
  assert.deepEqual(skillRootsForIdentity(null), [CANONICAL_SKILL_ROOT]);
  assert.deepEqual(skillRootsForIdentity({ orgId: ORG }), [CANONICAL_SKILL_ROOT]);

  for (const bad of ['../..', 'a/b', '', '.', 'x'.repeat(80)]) {
    assert.throws(
      () => userSkillRootFor({ orgId: ORG, userId: bad }),
      /Invalid userId/,
      JSON.stringify(bad),
    );
  }

  // A per-user directory is still under the canonical user root, so the
  // existing write guards and host-path redaction keep covering it.
  const mine = userSkillRootFor({ orgId: ORG, userId: USER });
  assert.equal(isUnderSkillRoot(`${mine}/my-skill/SKILL.md`), true);
  assert.equal(commandTouchesSkillRoot(`python ${mine}/my-skill/scripts/x.py`), true);
  assert.equal(
    redactEmbeddedHostPaths(`${mine}/my-skill/SKILL.md`),
    `${mine}/my-skill/SKILL.md`,
  );
});

test('only simple Skill scripts are executable through bash/process tools', () => {
  const script = `${CANONICAL_SKILL_ROOT}/pdf/scripts/render.py`;
  assert.equal(isReadonlySkillExecution(`python3 ${script} --input report.md`), true);
  assert.equal(isReadonlySkillExecution(`bash ${CANONICAL_SKILL_ROOT}/pdf/scripts/render.sh`), true);
  assert.equal(isReadonlySkillExecution(`python3 ${CANONICAL_SKILL_ROOT}/pdf/render.py`), false);
  assert.equal(isReadonlySkillExecution(`python3 ${script}; rm -rf /tmp/x`), false);
  assert.equal(isReadonlySkillExecution(`python3 ${script} $(whoami)`), false);
});

test('host-path redaction preserves only the canonical Skill roots', () => {
  for (const root of CANONICAL_ROOTS) {
    const canonical = `${root}/pdf/SKILL.md`;
    assert.equal(redactEmbeddedHostPaths(canonical), canonical, root);
  }
  for (const root of REMOVED_COMPATIBILITY_ROOTS) {
    const output = redactEmbeddedHostPaths(`${root}/pdf/SKILL.md`);
    assert.ok(!output.includes(root));
    assert.match(output, /\[redacted-path\]/);
  }
});

test('ADR 0009 D7 / H6.3：草稿根不在发现清单里——进去就等于取消闸门', async () => {
  const { DEFAULT_SKILL_ROOTS, DRAFT_SKILL_ROOT, SYSTEM_SKILL_ROOT, USER_SKILL_ROOT } =
    await import('../src/skills/paths.js');

  assert.equal(
    DEFAULT_SKILL_ROOTS.includes(DRAFT_SKILL_ROOT),
    false,
    '草稿根进了发现清单，模型写完一个包的下一轮就自动拥有它，闸门形同虚设',
  );
  // 三个根必须是三条不同的路径：可写的那个与进 prompt 的那两个不能重合。
  assert.equal(new Set([SYSTEM_SKILL_ROOT, USER_SKILL_ROOT, DRAFT_SKILL_ROOT]).size, 3);
  // 而且草稿根不能落在已启用根下面——否则逐包 ro_bind 会把它一起挂进去。
  assert.equal(DRAFT_SKILL_ROOT.startsWith(`${USER_SKILL_ROOT}/`), false);
  assert.equal(DRAFT_SKILL_ROOT.startsWith(`${SYSTEM_SKILL_ROOT}/`), false);
});
