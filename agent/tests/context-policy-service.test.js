/**
 * The Run's compaction policy is built into its SettingsManager, not layered
 * on afterwards.
 *
 * These run against a real `SettingsManager`, because the property being
 * tested is a property of the SDK class: `save()` rebuilds the effective
 * settings from globalSettings/projectSettings, so anything applied only to
 * the merged view is silently dropped the first time a Run persists a setting.
 * A stub that accepts any call would test nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SettingsManager,
  DEFAULT_COMPACTION_SETTINGS,
} from '@earendil-works/pi-coding-agent';

import {
  createRunSettingsManager,
  resolveCompactionSettings,
} from '../src/application/context-policy-service.js';

/** @param {(cwd: string, agentDir: string) => void} fn */
function withDirs(fn) {
  const cwd = mkdtempSync(join(tmpdir(), 'ctxpolicy-cwd-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'ctxpolicy-agent-'));
  try {
    return fn(cwd, agentDir);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
}

test('the AgentVersion policy is what the Run compacts by', () => {
  withDirs((cwd, agentDir) => {
    const manager = createRunSettingsManager(SettingsManager, {
      cwd,
      agentDir,
      policy: { autoCompact: false, reserveTokens: 1234, keepRecentTokens: 5678 },
      defaults: DEFAULT_COMPACTION_SETTINGS,
    });
    assert.deepEqual(manager.getCompactionSettings(), {
      enabled: false,
      reserveTokens: 1234,
      keepRecentTokens: 5678,
    });
  });
});

test('the policy survives a setting being persisted mid-Run', () => {
  // Regression: applying the policy with applyOverrides put it only in the
  // merged view, and SettingsManager.save() — reached from setModel,
  // setThinkingLevel, setAutoCompactionEnabled, setSteeringMode — rebuilds
  // that view from globalSettings, resetting the Run's compaction policy to
  // the shared file's for the rest of the Run, with no error.
  withDirs((cwd, agentDir) => {
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ compaction: { enabled: true, reserveTokens: 99_999 } }),
      'utf8',
    );
    const manager = createRunSettingsManager(SettingsManager, {
      cwd,
      agentDir,
      policy: { autoCompact: false, reserveTokens: 4096 },
      defaults: DEFAULT_COMPACTION_SETTINGS,
    });

    manager.setSteeringMode('all'); // any persisting setter triggers save()

    assert.equal(manager.getCompactionEnabled(), false);
    assert.equal(manager.getCompactionReserveTokens(), 4096);
    assert.equal(
      manager.getCompactionKeepRecentTokens(),
      DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
      'an unset field falls back to the SDK default, not the on-disk value',
    );
  });
});

test('nothing is written back to the shared settings file', async () => {
  const { readFileSync } = await import('node:fs');
  const cwd = mkdtempSync(join(tmpdir(), 'ctxpolicy-cwd-'));
  const agentDir = mkdtempSync(join(tmpdir(), 'ctxpolicy-agent-'));
  try {
    const settingsPath = join(agentDir, 'settings.json');
    const original = JSON.stringify({ compaction: { reserveTokens: 99_999 } });
    writeFileSync(settingsPath, original, 'utf8');

    const manager = createRunSettingsManager(SettingsManager, {
      cwd,
      agentDir,
      policy: { autoCompact: false, reserveTokens: 4096 },
    });
    manager.setSteeringMode('all');
    await manager.flush();

    assert.equal(
      readFileSync(settingsPath, 'utf8'),
      original,
      'the file every tenant Run reads must be untouched',
    );
  } finally {
    // Torn down only after flush() settles; an early rmSync turns a passing
    // assertion into an unhandled ENOENT from the write queue.
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test('operator settings other than compaction still apply', () => {
  withDirs((cwd, agentDir) => {
    writeFileSync(
      join(agentDir, 'settings.json'),
      JSON.stringify({ shellPath: '/bin/dash', compaction: { reserveTokens: 1 } }),
      'utf8',
    );
    const manager = createRunSettingsManager(SettingsManager, {
      cwd,
      agentDir,
      policy: {},
      defaults: DEFAULT_COMPACTION_SETTINGS,
    });
    assert.equal(manager.getShellPath(), '/bin/dash');
    assert.equal(
      manager.getCompactionReserveTokens(),
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      'compaction is replaced in full, including its defaults',
    );
  });
});

test('project settings under a tenant cwd are read but cannot be written', () => {
  withDirs((cwd, agentDir) => {
    mkdirSync(join(cwd, '.pi'), { recursive: true });
    writeFileSync(
      join(cwd, '.pi', 'settings.json'),
      JSON.stringify({ shellPath: '/bin/zsh' }),
      'utf8',
    );
    const manager = createRunSettingsManager(SettingsManager, {
      cwd,
      agentDir,
      policy: { reserveTokens: 4096 },
    });
    assert.equal(manager.getShellPath(), '/bin/zsh');
    assert.equal(manager.getCompactionReserveTokens(), 4096);
  });
});

test('resolveCompactionSettings rejects unusable budgets instead of coercing', () => {
  assert.throws(
    () => resolveCompactionSettings({ reserveTokens: 'lots' }),
    /reserveTokens must be a non-negative number/,
  );
  assert.throws(
    () => resolveCompactionSettings({ keepRecentTokens: -1 }),
    /keepRecentTokens must be a non-negative number/,
  );
});

test('rejects a SettingsManager whose SDK API no longer matches', () => {
  assert.throws(
    () => createRunSettingsManager({}, { cwd: '/tmp' }),
    /SettingsManager.create \/ .inMemory are required/,
  );
});
