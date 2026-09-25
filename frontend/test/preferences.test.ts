import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PREFERENCE_DEFAULTS, readPreference } from '../src/shared/ui/preferences.ts';

const store = (entries: Record<string, string>) => ({ getItem: (k: string) => entries[k] ?? null });

describe('readPreference', () => {
  it('reads stored values under their keys, including the legacy theme key', () => {
    const s = store({ 'app-theme': 'light', 'pref-density': 'expanded', 'pref-enter-while-running': 'steer' });
    assert.equal(readPreference('theme', s), 'light');
    assert.equal(readPreference('density', s), 'expanded');
    assert.equal(readPreference('enterWhileRunning', s), 'steer');
  });

  it('falls back to defaults for missing, unknown or unreadable values', () => {
    assert.equal(readPreference('theme', store({})), PREFERENCE_DEFAULTS.theme);
    assert.equal(readPreference('density', store({ 'pref-density': 'huge' })), 'compact');
    const throwing = { getItem: () => { throw new Error('SecurityError'); } };
    assert.equal(readPreference('enterWhileRunning', throwing), 'queue');
    assert.equal(readPreference('theme', null), 'system');
  });
});
