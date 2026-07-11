/**
 * SessionManager / auth surface used by chat.js — importable without live LLM.
 * Covers JSONL-style entries, branch, and custom entries for upgrade awareness.
 * Run: node --test api-server/tests/sdk-compat/session-api.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionManager,
  AuthStorage,
  ModelRegistry,
  SettingsManager,
  getAgentDir,
  CURRENT_SESSION_VERSION,
  createAgentSession,
  parseSessionEntries,
  migrateSessionEntries,
} from '@earendil-works/pi-coding-agent';

function assistantMessage(text) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    timestamp: Date.now(),
    api: 'openai-completions',
    provider: 'test',
    model: 'test-model',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
  };
}

describe('SessionManager API shape', () => {
  it('exposes static factories used by the BFF', () => {
    assert.equal(typeof SessionManager.inMemory, 'function');
    assert.equal(typeof SessionManager.create, 'function');
    assert.equal(typeof SessionManager.open, 'function');
  });

  it('inMemory session supports append/build context', () => {
    const sm = SessionManager.inMemory('/tmp');
    assert.equal(typeof sm.appendMessage, 'function');
    assert.equal(typeof sm.buildSessionContext, 'function');
    assert.equal(typeof sm.getEntries, 'function');
    assert.equal(typeof sm.getSessionId, 'function');
    assert.equal(typeof sm.branch, 'function');
    assert.equal(typeof sm.appendCustomEntry, 'function');

    sm.appendMessage({
      role: 'user',
      content: 'hello',
      timestamp: Date.now(),
    });
    const ctx = sm.buildSessionContext();
    assert.ok(ctx);
    assert.ok(Array.isArray(ctx.messages));
    assert.ok(ctx.messages.length >= 1);
  });

  it('appendCustomEntry stores non-context enterprise metadata', () => {
    const sm = SessionManager.inMemory('/tmp');
    sm.appendMessage({ role: 'user', content: 'u1', timestamp: Date.now() });
    sm.appendCustomEntry('enterprise_meta', { run_id: 'r1', pin: '0.80.3' });

    const custom = sm.getEntries().filter((e) => e.type === 'custom');
    assert.equal(custom.length, 1);
    assert.equal(custom[0].customType, 'enterprise_meta');
    assert.deepEqual(custom[0].data, { run_id: 'r1', pin: '0.80.3' });

    // Custom entries must not appear as LLM messages
    const roles = sm.buildSessionContext().messages.map((m) => m.role);
    assert.deepEqual(roles, ['user']);
  });

  it('branch moves leaf and allows alternate continuation', () => {
    const sm = SessionManager.inMemory('/tmp');
    sm.appendMessage({ role: 'user', content: 'u1', timestamp: Date.now() });
    const firstLeaf = sm.getLeafId();
    sm.appendMessage(assistantMessage('a1'));
    sm.appendMessage({ role: 'user', content: 'u2', timestamp: Date.now() });

    assert.equal(sm.buildSessionContext().messages.length, 3);

    sm.branch(firstLeaf);
    const afterBranch = sm.buildSessionContext().messages;
    assert.equal(afterBranch.length, 1);
    assert.equal(afterBranch[0].role, 'user');
    assert.equal(afterBranch[0].content, 'u1');

    sm.appendMessage({ role: 'user', content: 'u1-alt', timestamp: Date.now() });
    const children = sm.getChildren(firstLeaf);
    assert.ok(children.length >= 2, 'branched tree should keep prior child + new leaf');
    const ctx = sm.buildSessionContext().messages;
    assert.equal(ctx.length, 2);
    assert.equal(ctx[1].content, 'u1-alt');
  });
});

describe('Session JSONL helpers', () => {
  it('exports parseSessionEntries and migrateSessionEntries', () => {
    assert.equal(typeof parseSessionEntries, 'function');
    assert.equal(typeof migrateSessionEntries, 'function');
  });

  it('parseSessionEntries accepts empty / header-only style content safely', () => {
    // Empty input should not throw; return shape is array-like or object depending on SDK.
    const empty = parseSessionEntries('');
    assert.ok(empty == null || typeof empty === 'object');
  });
});

describe('AuthStorage / ModelRegistry / SettingsManager', () => {
  it('create factories exist and return objects', () => {
    assert.equal(typeof AuthStorage.create, 'function');
    const auth = AuthStorage.create();
    assert.equal(typeof auth.set, 'function');

    assert.equal(typeof ModelRegistry.create, 'function');
    const registry = ModelRegistry.create(auth);
    assert.ok(registry);

    assert.equal(typeof SettingsManager.create, 'function');
    assert.equal(typeof getAgentDir, 'function');
    const agentDir = getAgentDir();
    assert.equal(typeof agentDir, 'string');
  });
});

describe('SDK session schema version', () => {
  it('CURRENT_SESSION_VERSION is a positive number', () => {
    assert.equal(typeof CURRENT_SESSION_VERSION, 'number');
    assert.ok(CURRENT_SESSION_VERSION >= 1);
  });
});

describe('createAgentSession export', () => {
  it('is a function (construction with live model is out of suite scope)', () => {
    assert.equal(typeof createAgentSession, 'function');
  });
});
