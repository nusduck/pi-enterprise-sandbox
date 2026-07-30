/**
 * Two-tier skill roots + low-friction install.
 *
 * Everything here uses local (allowlisted) sources so the suite stays offline;
 * the git path shares the same discovery/naming code after the clone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  detectSourceType,
  discoverSkillPackageDir,
  describeInstalledSkills,
  installSkill,
  readSkillPackageName,
  uninstallSkill,
} from '../src/skills/install.js';
import {
  createSkillManager,
  skillRootsForIdentity,
  SKILLS_MODE,
} from '../src/skills/manager.js';

/** @type {string[]} */
const tempDirs = [];

async function tmpdir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

test.after(async () => {
  for (const dir of tempDirs) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

/**
 * @param {string} dir
 * @param {string} name
 * @param {string} [description]
 */
function writeSkillPackage(dir, name, description = 'Test skill package.') {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody for ${name}.\n`,
    'utf8',
  );
  return dir;
}

test('source type is inferred from the source string', () => {
  assert.equal(detectSourceType('https://example.com/org/repo'), 'git');
  assert.equal(detectSourceType('/srv/sources/my-skill'), 'local');
  // Classified as git so the caller gets the real "HTTPS only" rejection.
  assert.equal(detectSourceType('git@example.com:org/repo.git'), 'git');
  assert.throws(() => detectSourceType('  '), /source is required/);
});

test('package directory is discovered inside a source tree', async () => {
  const root = await tmpdir('skill-src');

  // Package at the root.
  writeSkillPackage(root, 'flat-skill');
  assert.deepEqual(discoverSkillPackageDir(root), {
    dir: path.resolve(root),
    subpath: '',
    candidates: [''],
  });

  // Package nested one level down (the common repo layout).
  const nested = await tmpdir('skill-src-nested');
  writeSkillPackage(path.join(nested, 'skills', 'nested-skill'), 'nested-skill');
  const found = discoverSkillPackageDir(nested);
  assert.equal(found.subpath, 'skills/nested-skill');
  assert.equal(readSkillPackageName(found.dir), 'nested-skill');

  // Ambiguity is an error that names the candidates rather than a silent pick.
  const many = await tmpdir('skill-src-many');
  writeSkillPackage(path.join(many, 'skills', 'a-skill'), 'a-skill');
  writeSkillPackage(path.join(many, 'skills', 'b-skill'), 'b-skill');
  assert.throws(
    () => discoverSkillPackageDir(many),
    /2 skill packages; pass subpath/,
  );

  const none = await tmpdir('skill-src-none');
  fs.mkdirSync(path.join(none, 'docs'), { recursive: true });
  assert.throws(() => discoverSkillPackageDir(none), /No SKILL\.md found/);
});

test('install needs only a source: name and subpath are inferred', async () => {
  const src = await tmpdir('skill-src');
  const userRoot = await tmpdir('skill-user');
  writeSkillPackage(path.join(src, 'packages', 'inferred'), 'inferred', 'Inferred.');

  const result = await installSkill({
    source: src,
    skillRoot: userRoot,
    localAllowlist: [src],
  });

  assert.equal(result.name, 'inferred');
  assert.equal(result.description, 'Inferred.');
  assert.equal(result.source_type, 'local');
  assert.equal(result.subpath, 'packages/inferred');
  assert.ok(fs.existsSync(path.join(userRoot, 'inferred', 'SKILL.md')));
});

test('reinstalling identical content is an explicit no-op', async () => {
  const src = await tmpdir('skill-src');
  const userRoot = await tmpdir('skill-user');
  writeSkillPackage(src, 'idem');

  const first = await installSkill({
    source: src,
    skillRoot: userRoot,
    localAllowlist: [src],
  });
  assert.notEqual(first.idempotent, true);

  const second = await installSkill({
    source: src,
    skillRoot: userRoot,
    localAllowlist: [src],
  });
  assert.equal(second.idempotent, true);
  assert.equal(second.digest, first.digest);
});

test('an explicit name must agree with the package SKILL.md', async () => {
  const src = await tmpdir('skill-src');
  const userRoot = await tmpdir('skill-user');
  writeSkillPackage(src, 'real-name');

  await assert.rejects(
    installSkill({
      source: src,
      name: 'wrong-name',
      skillRoot: userRoot,
      localAllowlist: [src],
    }),
    /does not match requested name/,
  );
});

test('an install cannot shadow a bundled system skill', async () => {
  const src = await tmpdir('skill-src');
  const userRoot = await tmpdir('skill-user');
  writeSkillPackage(src, 'pdf');

  await assert.rejects(
    installSkill({
      source: src,
      skillRoot: userRoot,
      localAllowlist: [src],
      systemSkillNames: ['pdf'],
    }),
    /bundled system skill and cannot be replaced/,
  );
});

test('uninstall removes user packages and refuses unknown ones', async () => {
  const src = await tmpdir('skill-src');
  const userRoot = await tmpdir('skill-user');
  writeSkillPackage(src, 'removable');
  await installSkill({ source: src, skillRoot: userRoot, localAllowlist: [src] });

  const removed = await uninstallSkill({ name: 'removable', skillRoot: userRoot });
  assert.equal(removed.name, 'removable');
  assert.equal(fs.existsSync(path.join(userRoot, 'removable')), false);

  await assert.rejects(
    uninstallSkill({ name: 'removable', skillRoot: userRoot }),
    /is not installed in the user skill root/,
  );
});

test('listing tags each package with its tier, system shadowing user', async () => {
  const systemRoot = await tmpdir('skill-system');
  const userRoot = await tmpdir('skill-user');
  writeSkillPackage(path.join(systemRoot, 'bundled'), 'bundled', 'From the image.');
  writeSkillPackage(path.join(userRoot, 'installed'), 'installed', 'From an install.');
  // Same name in both tiers: the system copy is what actually loads.
  writeSkillPackage(path.join(systemRoot, 'shared'), 'shared', 'System copy.');
  writeSkillPackage(path.join(userRoot, 'shared'), 'shared', 'User copy.');

  const listed = describeInstalledSkills([systemRoot, userRoot], {
    writableRoot: userRoot,
  });
  const byName = Object.fromEntries(listed.map((s) => [s.name, s]));

  assert.equal(byName.bundled.tier, 'system');
  assert.equal(byName.bundled.editable, false);
  assert.equal(byName.installed.tier, 'user');
  assert.equal(byName.installed.editable, true);
  assert.equal(byName.shared.tier, 'system');
  assert.equal(byName.shared.description, 'System copy.');
  assert.equal(listed.length, 3, 'shadowed duplicate is reported once');
});

test('SkillManager writes only to the caller\'s own directory', async () => {
  const systemRoot = await tmpdir('skill-system');
  const userRoot = await tmpdir('skill-user');
  const src = await tmpdir('skill-src');
  writeSkillPackage(path.join(systemRoot, 'bundled'), 'bundled');
  writeSkillPackage(src, 'from-manager');

  // readonly is the kill switch, not the default.
  const readonly = createSkillManager({
    mode: SKILLS_MODE.READONLY,
    skillRoots: [systemRoot, userRoot],
    localAllowlist: [src],
  });
  await assert.rejects(
    readonly.install({ source: src }),
    /disables skill installation/,
  );

  const dev = createSkillManager({
    mode: SKILLS_MODE.ENABLED,
    skillRoots: [systemRoot, userRoot],
    localAllowlist: [src],
  });
  assert.equal(dev.userSkillRoot, path.resolve(userRoot));

  const installed = await dev.install({ source: src });
  assert.equal(installed.name, 'from-manager');
  assert.ok(fs.existsSync(path.join(userRoot, 'from-manager', 'SKILL.md')));
  assert.equal(
    fs.existsSync(path.join(systemRoot, 'from-manager')),
    false,
    'system root must stay untouched',
  );

  // A bundled package cannot be replaced through the manager either.
  const shadow = await tmpdir('skill-src-shadow');
  writeSkillPackage(shadow, 'bundled');
  const devShadow = createSkillManager({
    mode: SKILLS_MODE.ENABLED,
    skillRoots: [systemRoot, userRoot],
    localAllowlist: [shadow],
  });
  await assert.rejects(
    devShadow.install({ source: shadow }),
    /bundled system skill/,
  );

  // Edits resolve under the user root, so a system path is out of bounds.
  await dev.edit({
    path: 'from-manager/notes.md',
    content: '# notes\n',
  });
  assert.ok(fs.existsSync(path.join(userRoot, 'from-manager', 'notes.md')));
  await assert.rejects(
    dev.edit({ path: path.join(systemRoot, 'bundled', 'SKILL.md'), content: 'x' }),
    /escape|outside/i,
  );
});

test('no resolvable per-user directory refuses writes instead of using a shared root', async () => {
  const systemRoot = await tmpdir('skill-system');
  for (const roots of [
    // Only the canonical system root.
    ['/home/sandbox/skill'],
    // Only the shared user *base* — a package there would belong to nobody.
    ['/home/sandbox/skill', '/home/sandbox/skill-user'],
  ]) {
    const manager = createSkillManager({ mode: SKILLS_MODE.ENABLED, skillRoots: roots });
    assert.equal(manager.userSkillRoot, null, roots.join());
    await assert.rejects(
      manager.install({ source: systemRoot }),
      /no per-user skill directory resolved/,
    );
  }
});

test('an identity gives each user their own directory, and only their own', async () => {
  const systemRoot = await tmpdir('skill-system');
  const userBase = await tmpdir('skill-user-base');
  const src = await tmpdir('skill-src');
  writeSkillPackage(src, 'mine');

  const alice = { orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z', userId: '01K0G2PAV8FPMVC9QHJG7JPN50' };
  const bob = { orgId: '01K0G2PAV8FPMVC9QHJG7JPN4Z', userId: '01K0G2PAV8FPMVC9QHJG7JPN51' };

  const managerFor = (identity) =>
    createSkillManager({
      mode: SKILLS_MODE.ENABLED,
      identity,
      skillRoots: skillRootsForIdentity(identity, {
        systemRoot,
        userRootBase: userBase,
      }),
      localAllowlist: [src],
    });

  const aliceManager = managerFor(alice);
  await aliceManager.install({ source: src });

  assert.ok(
    fs.existsSync(path.join(userBase, alice.orgId, alice.userId, 'mine', 'SKILL.md')),
  );
  assert.deepEqual(
    aliceManager.describeInstalled().map((s) => s.name),
    ['mine'],
  );

  // Bob shares the org but sees none of Alice's packages.
  assert.deepEqual(managerFor(bob).describeInstalled(), []);
  assert.equal(
    fs.existsSync(path.join(userBase, bob.orgId, bob.userId, 'mine')),
    false,
  );
});
