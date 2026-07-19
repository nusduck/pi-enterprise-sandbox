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
      assert.equal(
        fs.existsSync(path.join(root, name)),
        false,
        `unexpected dual-tree directory agent/${name}`,
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

  it('parks approval-waiter under legacy/ only', () => {
    assert.ok(fs.existsSync(path.join(root, 'legacy/approval-waiter.js')));
    assert.equal(fs.existsSync(path.join(root, 'services/approval-waiter.js')), false);
  });
});
