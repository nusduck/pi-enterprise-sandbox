/**
 * Durable skill bundles and local materialisation.
 *
 * The point of this machinery is to turn the user-skill volume from state into
 * a cache, so the tests care about exactly that: does a pod that has never seen
 * a user end up with the right files, does a warm pod skip the work, and does a
 * pod stop serving a skill the user uninstalled.
 *
 * Real tar round-trips against a temp directory — mocking the archive would
 * test the mock, and permission/symlink handling is the reason the binary is
 * used in the first place.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  DIGEST_MARKER,
  createSkillBundleStore,
  materialiseUserSkills,
  packSkillBundle,
  readLocalDigest,
  unpackSkillBundle,
} from '../../src/skills/bundle-store.js';

const SCOPE = {
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN51',
};

let tmpRoot;

before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'skill-bundle-'));
});

after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

async function makeSkill(name, files) {
  const dir = path.join(tmpRoot, `src-${name}-${Math.random().toString(36).slice(2)}`);
  await fsp.mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, content, 'utf8');
  }
  return dir;
}

/** In-memory stand-in for the MySQL-backed store. */
function fakeStore(initial = {}) {
  const rows = new Map(Object.entries(initial));
  return {
    rows,
    listCalls: 0,
    bundleCalls: 0,
    async listDigests() {
      this.listCalls += 1;
      return [...rows.entries()].map(([skillName, r]) => ({
        skillName,
        sha256: r.sha256,
      }));
    },
    async getBundle(_scope, skillName) {
      this.bundleCalls += 1;
      return rows.get(skillName) ?? null;
    },
  };
}

describe('skill bundle packing', () => {
  it('round-trips a package directory through tar', async () => {
    const src = await makeSkill('alpha', {
      'SKILL.md': '# alpha\n',
      'scripts/run.sh': '#!/bin/sh\necho hi\n',
    });
    const packed = await packSkillBundle(src);
    assert.match(packed.sha256, /^[0-9a-f]{64}$/);
    assert.ok(packed.sizeBytes > 0);

    const dest = path.join(tmpRoot, 'unpacked-alpha');
    await unpackSkillBundle(packed.bundle, dest, { digest: packed.sha256 });

    assert.equal(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8'), '# alpha\n');
    assert.equal(
      await fsp.readFile(path.join(dest, 'scripts/run.sh'), 'utf8'),
      '#!/bin/sh\necho hi\n',
    );
    assert.equal(await readLocalDigest(dest), packed.sha256);
  });

  it('produces a stable digest for identical content', async () => {
    // Reinstalling an unchanged skill must not invalidate every pod's cache.
    const a = await makeSkill('same', { 'SKILL.md': 'x\n' });
    const b = await makeSkill('same', { 'SKILL.md': 'x\n' });
    const packedA = await packSkillBundle(a);
    const packedB = await packSkillBundle(b);
    assert.equal(packedA.sha256, packedB.sha256);
  });

  it('changes the digest when content changes', async () => {
    const a = await makeSkill('diff', { 'SKILL.md': 'one\n' });
    const b = await makeSkill('diff', { 'SKILL.md': 'two\n' });
    assert.notEqual(
      (await packSkillBundle(a)).sha256,
      (await packSkillBundle(b)).sha256,
    );
  });

  it('rejects a directory that does not exist', async () => {
    await assert.rejects(
      packSkillBundle(path.join(tmpRoot, 'nope')),
      /not found/,
    );
  });

  it('replaces an existing directory atomically', async () => {
    const dest = path.join(tmpRoot, 'replaced');
    await fsp.mkdir(dest, { recursive: true });
    await fsp.writeFile(path.join(dest, 'stale.txt'), 'old', 'utf8');

    const src = await makeSkill('fresh', { 'SKILL.md': 'new\n' });
    const packed = await packSkillBundle(src);
    await unpackSkillBundle(packed.bundle, dest, { digest: packed.sha256 });

    assert.equal(fs.existsSync(path.join(dest, 'stale.txt')), false);
    assert.equal(await fsp.readFile(path.join(dest, 'SKILL.md'), 'utf8'), 'new\n');
  });
});

describe('materialising a user directory', () => {
  it('extracts everything on a pod that has never seen this user', async () => {
    const one = await packSkillBundle(await makeSkill('one', { 'SKILL.md': '1\n' }));
    const two = await packSkillBundle(await makeSkill('two', { 'SKILL.md': '2\n' }));
    const store = fakeStore({ one, two });
    const dir = path.join(tmpRoot, 'cold-pod');

    const result = await materialiseUserSkills({
      store,
      scope: SCOPE,
      userSkillDir: dir,
      logger: { warn: () => {} },
    });

    assert.deepEqual(result.materialised.sort(), ['one', 'two']);
    assert.equal(await fsp.readFile(path.join(dir, 'one/SKILL.md'), 'utf8'), '1\n');
    assert.equal(await fsp.readFile(path.join(dir, 'two/SKILL.md'), 'utf8'), '2\n');
  });

  it('skips extraction when the local digest already matches', async () => {
    const one = await packSkillBundle(await makeSkill('warm', { 'SKILL.md': 'w\n' }));
    const store = fakeStore({ warm: one });
    const dir = path.join(tmpRoot, 'warm-pod');

    await materialiseUserSkills({ store, scope: SCOPE, userSkillDir: dir });
    const bundleCallsAfterFirst = store.bundleCalls;

    const second = await materialiseUserSkills({
      store,
      scope: SCOPE,
      userSkillDir: dir,
    });

    // A warm cache should cost one small query, not an extraction.
    assert.deepEqual(second.materialised, []);
    assert.equal(store.bundleCalls, bundleCallsAfterFirst);
  });

  it('re-extracts when the stored bundle changed', async () => {
    const before = await packSkillBundle(await makeSkill('v', { 'SKILL.md': 'v1\n' }));
    const store = fakeStore({ v: before });
    const dir = path.join(tmpRoot, 'updated-pod');
    await materialiseUserSkills({ store, scope: SCOPE, userSkillDir: dir });

    const after = await packSkillBundle(await makeSkill('v', { 'SKILL.md': 'v2\n' }));
    store.rows.set('v', after);

    const result = await materialiseUserSkills({
      store,
      scope: SCOPE,
      userSkillDir: dir,
    });

    assert.deepEqual(result.materialised, ['v']);
    assert.equal(await fsp.readFile(path.join(dir, 'v/SKILL.md'), 'utf8'), 'v2\n');
  });

  it('removes a skill the user uninstalled', async () => {
    const keep = await packSkillBundle(await makeSkill('keep', { 'SKILL.md': 'k\n' }));
    const drop = await packSkillBundle(await makeSkill('drop', { 'SKILL.md': 'd\n' }));
    const store = fakeStore({ keep, drop });
    const dir = path.join(tmpRoot, 'uninstall-pod');
    await materialiseUserSkills({ store, scope: SCOPE, userSkillDir: dir });

    store.rows.delete('drop');
    const result = await materialiseUserSkills({
      store,
      scope: SCOPE,
      userSkillDir: dir,
    });

    // Otherwise this pod keeps serving a skill that exists nowhere else.
    assert.deepEqual(result.removed, ['drop']);
    assert.equal(fs.existsSync(path.join(dir, 'drop')), false);
    assert.equal(fs.existsSync(path.join(dir, 'keep')), true);
  });

  it('reports a database failure instead of failing the run', async () => {
    const store = {
      async listDigests() {
        throw new Error('mysql gone');
      },
    };
    const dir = path.join(tmpRoot, 'degraded-pod');

    const result = await materialiseUserSkills({
      store,
      scope: SCOPE,
      userSkillDir: dir,
      logger: { warn: () => {} },
    });

    // Skills enhance a run; losing them must not stop it executing.
    assert.deepEqual(result, { materialised: [], removed: [], failed: [] });
  });

  it('keeps going when one skill fails to extract', async () => {
    const good = await packSkillBundle(await makeSkill('good', { 'SKILL.md': 'g\n' }));
    const store = fakeStore({
      good,
      broken: { bundle: Buffer.from('not a tar'), sha256: 'f'.repeat(64) },
    });
    const dir = path.join(tmpRoot, 'partial-pod');

    const result = await materialiseUserSkills({
      store,
      scope: SCOPE,
      userSkillDir: dir,
      logger: { warn: () => {} },
    });

    assert.deepEqual(result.materialised, ['good']);
    assert.deepEqual(result.failed, ['broken']);
  });

  it('ignores the digest marker when reconciling directories', async () => {
    const only = await packSkillBundle(await makeSkill('only', { 'SKILL.md': 'o\n' }));
    const store = fakeStore({ only });
    const dir = path.join(tmpRoot, 'marker-pod');
    await materialiseUserSkills({ store, scope: SCOPE, userSkillDir: dir });

    assert.equal(fs.existsSync(path.join(dir, 'only', DIGEST_MARKER)), true);
    const result = await materialiseUserSkills({
      store,
      scope: SCOPE,
      userSkillDir: dir,
    });
    assert.deepEqual(result.removed, []);
  });
});

describe('bundle store scoping', () => {
  it('requires a database', () => {
    assert.throws(() => createSkillBundleStore({}), /knex executor/);
  });

  it('refuses an unscoped write', async () => {
    const store = createSkillBundleStore({ db: () => ({}) });
    // Skills are per-user; an unscoped write would put one user's install into
    // every user's agent context.
    await assert.rejects(
      store.listDigests({ orgId: '', userId: '' }),
      /orgId and userId/,
    );
  });
});
