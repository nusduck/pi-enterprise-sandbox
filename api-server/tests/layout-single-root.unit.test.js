/**
 * Layout gate: BFF production code lives under api-server/src only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('api-server single production source root', () => {
  it('keeps package-root application/routes/services/http absent', () => {
    for (const name of ['application', 'routes', 'services', 'http']) {
      assert.equal(
        fs.existsSync(path.join(root, name)),
        false,
        `unexpected dual-tree directory api-server/${name}`,
      );
    }
    assert.equal(fs.existsSync(path.join(root, 'config.js')), false);
  });

  it('exposes production modules under src/ and thin server.js', () => {
    for (const rel of [
      'server.js',
      'src/config.js',
      'src/routes/runs.js',
      'src/services/agent-client.js',
      'src/application/run-access-service.js',
      'src/http/response.js',
    ]) {
      assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
    }
  });
});
