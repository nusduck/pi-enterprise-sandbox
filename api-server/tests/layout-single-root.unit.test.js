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
    assert.equal(fs.existsSync(path.join(root, 'config.ts')), false);
  });

  it('exposes production modules under src/ and thin server.ts', () => {
    for (const rel of [
      'server.ts',
      'src/config.ts',
      'src/routes/runs.ts',
      'src/services/agent-client.ts',
      'src/application/run-access-service.ts',
      'src/http/response.ts',
    ]) {
      assert.ok(fs.existsSync(path.join(root, rel)), `missing ${rel}`);
    }
  });
});

