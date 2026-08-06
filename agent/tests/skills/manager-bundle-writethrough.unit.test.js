/**
 * Skill manager write-through to the durable store.
 *
 * Real installs against a temp directory — the point is that the durable copy
 * tracks what actually landed on disk, so stubbing the installer would test the
 * stub. Equally important: a store problem must degrade to "installed but not
 * yet durable" rather than discarding an install that already succeeded.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSkillManager } from '../../src/skills/manager.js';

const IDENTITY = {
  orgId: '01K0G2PAV8FPMVC9QHJG7JPN50',
  userId: '01K0G2PAV8FPMVC9QHJG7JPN51',
};

const tempDirs = [];

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );
});

async function tmpdir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

/** A minimal valid skill package the installer will accept. */
async function skillSource(name, body = 'Body.') {
  const dir = await tmpdir(`skill-src-${name}`);
  await fsp.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n${body}\n`,
    'utf8',
  );
  return dir;
}

function recordingStore({ failPut = false, failRemove = false } = {}) {
  return {
    puts: [],
    removes: [],
    async put(scope, skillName, payload) {
      if (failPut) throw new Error('store down');
      this.puts.push({ scope, skillName, payload });
    },
    async remove(scope, skillName) {
      if (failRemove) throw new Error('store down');
      this.removes.push({ scope, skillName });
    },
  };
}

async function makeManager({ store = null, source } = {}) {
  const userRoot = await tmpdir('skill-user-root');
  const audits = [];
  const manager = createSkillManager({
    mode: 'enabled',
    identity: IDENTITY,
    skillRoots: [userRoot],
    userSkillRoot: userRoot,
    localAllowlist: source ? [source] : [],
    bundleStore: store,
    auditSink: (entry) => audits.push(entry),
  });
  return { manager, audits, userRoot };
}

describe('skill manager durable write-through', () => {
  it('stores the installed directory after a successful install', async () => {
    const source = await skillSource('demo');
    const store = recordingStore();
    const { manager, userRoot } = await makeManager({ store, source });

    const result = await manager.install({ source });

    assert.equal(result.name, 'demo');
    assert.equal(fs.existsSync(path.join(userRoot, 'demo', 'SKILL.md')), true);

    assert.equal(store.puts.length, 1);
    const [put] = store.puts;
    assert.equal(put.skillName, 'demo');
    assert.deepEqual(put.scope, IDENTITY);
    assert.match(put.payload.sha256, /^[0-9a-f]{64}$/);
    assert.ok(put.payload.bundle.byteLength > 0);
    assert.equal(put.payload.source.sourceType, 'local');
  });

  it('reports a store failure without failing the install', async () => {
    const source = await skillSource('flaky');
    const store = recordingStore({ failPut: true });
    const { manager, audits, userRoot } = await makeManager({ store, source });

    // The skill works on this pod; it just is not durable yet. Failing here
    // would discard a completed install over a transient database problem.
    const result = await manager.install({ source });

    assert.equal(result.name, 'flaky');
    assert.equal(fs.existsSync(path.join(userRoot, 'flaky', 'SKILL.md')), true);

    const partial = audits.find((a) => a.result === 'partial');
    assert.ok(partial, 'the degraded outcome must be visible, not silent');
    assert.match(partial.error, /durable store write failed/);
    assert.ok(audits.some((a) => a.action === 'install' && a.result === 'success'));
  });

  it('removes the durable row on uninstall', async () => {
    const source = await skillSource('gone');
    const store = recordingStore();
    const { manager } = await makeManager({ store, source });
    await manager.install({ source });

    await manager.uninstall({ name: 'gone' });

    // Otherwise every other pod keeps materialising a skill the user removed.
    assert.deepEqual(store.removes, [{ scope: IDENTITY, skillName: 'gone' }]);
  });

  it('surfaces a failed durable delete', async () => {
    const source = await skillSource('stuck');
    const store = recordingStore({ failRemove: true });
    const { manager, audits } = await makeManager({ store, source });
    await manager.install({ source });

    await manager.uninstall({ name: 'stuck' });

    const partial = audits.find(
      (a) => a.action === 'uninstall' && a.result === 'partial',
    );
    assert.ok(partial);
    assert.match(partial.error, /durable store delete failed/);
  });

  it('re-stores the new content when a skill is reinstalled', async () => {
    const first = await skillSource('evolve', 'Version one.');
    const store = recordingStore();
    const { manager, userRoot } = await makeManager({ store, source: first });
    await manager.install({ source: first });

    const second = await skillSource('evolve', 'Version two.');
    const reinstalled = createSkillManager({
      mode: 'enabled',
      identity: IDENTITY,
      skillRoots: [userRoot],
      userSkillRoot: userRoot,
      localAllowlist: [second],
      bundleStore: store,
      auditSink: () => {},
    });
    await reinstalled.install({ source: second });

    assert.equal(store.puts.length, 2);
    // Different content must produce a different digest, or pods with a warm
    // cache would never pick up the update.
    assert.notEqual(store.puts[0].payload.sha256, store.puts[1].payload.sha256);
  });

  it('works without a store, so single-node development is unchanged', async () => {
    const source = await skillSource('plain');
    const { manager, audits } = await makeManager({ source });

    const result = await manager.install({ source });

    assert.equal(result.name, 'plain');
    assert.equal(
      audits.some((a) => a.result === 'partial'),
      false,
    );
  });
});
