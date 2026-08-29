/**
 * Layout gate: production Agent code lives under agent/src only.
 * Package-root dual trees (application/runtime/services/lib/infrastructure/skills)
 * must not reappear for production modules.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Relative paths of every file under `dir`, skipping node_modules. */
function collectFiles(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectFiles(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

describe('agent single production source root', () => {
  it('keeps dual-tree package-root dirs absent', () => {
    for (const name of [
      'application',
      'runtime',
      'services',
      'lib',
      'infrastructure',
      'skills',
    ]) {
      const dir = path.join(root, name);
      if (!fs.existsSync(dir)) continue;
      // One narrow exception: a nested npm package (its own package.json, its
      // own build) is not a dual tree. `agent/runtime/` is `@pi/runtime`, the
      // TypeScript DSH composition layer that only agent consumes. The gate
      // still has to hold, so prove it is a package and that it contributes no
      // production JS that could shadow agent/src/<name>/.
      assert.ok(
        fs.existsSync(path.join(dir, 'package.json')),
        `unexpected dual-tree directory agent/${name}`,
      );
      const strays = collectFiles(dir).filter(
        (rel) => rel.endsWith('.js') && !rel.startsWith('node_modules/') && !rel.startsWith('dist/'),
      );
      assert.deepEqual(
        strays,
        [],
        `agent/${name} is a nested package and must ship no production .js: ${strays.join(', ')}`,
      );
    }
  });

  it('exposes production modules under src/', () => {
    for (const rel of [
      'src/lib/text-redaction.js',
      'src/infrastructure/model-registry.js',
      'src/infrastructure/sandbox/sandbox-client.js',
      'src/skills/paths.js',
      'src/bootstrap/http-main.js',
      'server.js',
      'worker.js',
      'config.js',
    ]) {
      assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
    }
  });

  it('does not retain the obsolete approval-waiter implementation', () => {
    assert.equal(fs.existsSync(path.join(root, 'legacy')), false);
    assert.equal(fs.existsSync(path.join(root, 'services/approval-waiter.js')), false);
  });
});
