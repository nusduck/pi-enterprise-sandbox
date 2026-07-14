import assert from 'node:assert/strict';
import test from 'node:test';

import { applyContextPolicy } from '../application/context-policy-service.js';

test('Agent Profile compaction policy overrides runtime settings without saving files', () => {
  let saved = false;
  const manager = {
    save() { saved = true; },
  };
  applyContextPolicy(manager, {
    autoCompact: false,
    reserveTokens: 1234,
    keepRecentTokens: 5678,
  });
  assert.deepEqual(manager.getCompactionSettings(), {
    enabled: false,
    reserveTokens: 1234,
    keepRecentTokens: 5678,
  });
  assert.equal(saved, false);
});
