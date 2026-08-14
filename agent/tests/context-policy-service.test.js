/**
 * Compaction policy is applied through the SDK's own SettingsManager API.
 *
 * These tests run against a real `SettingsManager` rather than a stub object:
 * the whole point of the change is that the policy now goes through a supported
 * entry point, so a stub that accepts anything would test nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SettingsManager,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-coding-agent';

import { applyContextPolicy } from '../src/application/context-policy-service.js';

test('Agent Profile compaction policy overrides runtime settings without saving files', async () => {
  const manager = SettingsManager.inMemory();
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

  // The manager writes on flush() only for fields it recorded as modified.
  // applyOverrides records none, so the shared settings file is never touched.
  await manager.flush();
  assert.deepEqual(manager.drainErrors(), []);
  assert.deepEqual(
    manager.getGlobalSettings().compaction,
    undefined,
    'the override must not leak into persisted global settings',
  );
});

test('an absent policy resolves to the SDK compaction defaults', () => {
  const manager = SettingsManager.inMemory();
  applyContextPolicy(manager, {}, { defaults: DEFAULT_COMPACTION_SETTINGS });
  assert.deepEqual(manager.getCompactionSettings(), {
    enabled: DEFAULT_COMPACTION_SETTINGS.enabled,
    reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    keepRecentTokens: DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
  });
});

test('AgentVersion policy wins over settings already loaded from disk', () => {
  // A Run's compaction behaviour must follow its AgentVersion, not whatever
  // settings.json shipped in the image or sits in the agent home directory.
  const manager = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 99_999, keepRecentTokens: 99_999 },
  });
  applyContextPolicy(manager, { autoCompact: false, reserveTokens: 4_096 });
  assert.equal(manager.getCompactionEnabled(), false);
  assert.equal(manager.getCompactionReserveTokens(), 4_096);
  assert.equal(
    manager.getCompactionKeepRecentTokens(),
    DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
    'an unset field falls back to the SDK default, not the on-disk value',
  );
});

test('rejects a settingsManager whose SDK API no longer matches', () => {
  assert.throws(
    () => applyContextPolicy({}, {}),
    /applyOverrides is required/,
  );
  assert.throws(() => applyContextPolicy(null, {}), /settingsManager is required/);
});

test('rejects non-numeric token budgets instead of silently coercing', () => {
  const manager = SettingsManager.inMemory();
  assert.throws(
    () => applyContextPolicy(manager, { reserveTokens: 'lots' }),
    /reserveTokens must be a non-negative number/,
  );
  assert.throws(
    () => applyContextPolicy(manager, { keepRecentTokens: -1 }),
    /keepRecentTokens must be a non-negative number/,
  );
});
