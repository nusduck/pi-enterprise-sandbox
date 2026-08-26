/**
 * Model picker must be per-conversation, not a single global localStorage key.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONVERSATION_MODEL_PREFS_KEY,
  LEGACY_MODEL_PREF_KEY,
  lastRunModelIdForConversation,
  readConversationModelId,
  resolveConversationModelId,
  writeConversationModelId,
} from '../src/shared/state/conversationModelPref.ts';

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  const ls = {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    setItem(key: string, value: string) {
      store.set(key, String(value));
    },
    removeItem(key: string) {
      store.delete(key);
    },
    clear() {
      store.clear();
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: ls,
    configurable: true,
    writable: true,
  });
  return store;
}

describe('conversation model preference', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = installLocalStorage();
  });

  it('keeps independent picker values for two conversations', () => {
    writeConversationModelId('conv-a', 'claude-opus');
    writeConversationModelId('conv-b', 'gpt-5');

    assert.equal(readConversationModelId('conv-a'), 'claude-opus');
    assert.equal(readConversationModelId('conv-b'), 'gpt-5');
    assert.equal(readConversationModelId(null), null);
    assert.equal(store.has(LEGACY_MODEL_PREF_KEY), false);
    assert.equal(store.has(CONVERSATION_MODEL_PREFS_KEY), true);
  });

  it('does not let a new-chat draft overwrite an existing conversation', () => {
    writeConversationModelId('conv-a', 'claude-opus');
    writeConversationModelId(null, 'gpt-5');

    assert.equal(readConversationModelId('conv-a'), 'claude-opus');
    assert.equal(readConversationModelId(null), 'gpt-5');
  });

  it('migrates the legacy global key only onto the new-chat draft', () => {
    store.set(LEGACY_MODEL_PREF_KEY, 'global-model');

    assert.equal(readConversationModelId(null), 'global-model');
    assert.equal(readConversationModelId('conv-a'), null);
    assert.equal(store.has(LEGACY_MODEL_PREF_KEY), false);
  });

  it('prefers the stored conversation choice over the last run', () => {
    assert.equal(
      resolveConversationModelId({
        stored: 'claude-opus',
        lastRunModelId: 'gpt-5',
        enabledIds: ['claude-opus', 'gpt-5'],
      }),
      'claude-opus',
    );
  });

  it('falls back to the latest run model when this chat has no picker pref', () => {
    const modelId = lastRunModelIdForConversation(
      {
        older: {
          conversationId: 'conv-a',
          modelId: 'gpt-5',
          startedAt: '2026-01-01T00:00:00Z',
        },
        newer: {
          conversationId: 'conv-a',
          modelId: 'claude-opus',
          startedAt: '2026-01-02T00:00:00Z',
        },
        other: {
          conversationId: 'conv-b',
          modelId: 'ignored',
          startedAt: '2026-01-03T00:00:00Z',
        },
      },
      'conv-a',
    );
    assert.equal(modelId, 'claude-opus');
    assert.equal(
      resolveConversationModelId({
        stored: null,
        lastRunModelId: modelId,
        enabledIds: ['claude-opus', 'gpt-5'],
      }),
      'claude-opus',
    );
  });

  it('drops a stored id that is no longer in the catalog', () => {
    assert.equal(
      resolveConversationModelId({
        stored: 'retired',
        lastRunModelId: 'gpt-5',
        enabledIds: ['gpt-5'],
      }),
      'gpt-5',
    );
  });
});
