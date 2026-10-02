/**
 * `A2A_REMOTE_AGENTS_JSON` 启动期解析（docs/design/a2a-remote-delegation.md D2）：不合法即拒绝启动。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_REMOTE_TIMEOUT_MS,
  RemoteAgentRegistryError,
  parseRemoteAgentRegistry,
} from '../../src/runtime/providers/a2a-remote-registry.js';

const GOOD = {
  id: 'finance-bot',
  name: '财务助手',
  description: '查询报销与预算',
  cardUrl: 'https://finance.example/a2a/agents/x/.well-known/agent-card.json',
  authTokenRef: 'A2A_FINANCE_TOKEN',
};

function env(entries: unknown, extra: Record<string, string> = {}) {
  return { A2A_REMOTE_AGENTS_JSON: JSON.stringify(entries), A2A_FINANCE_TOKEN: 'secret-value', ...extra };
}

describe('parseRemoteAgentRegistry', () => {
  it('returns nothing when unset', () => {
    assert.deepEqual([...parseRemoteAgentRegistry({})], []);
  });

  it('parses an entry, applies the default timeout and never copies the secret', () => {
    const [entry] = parseRemoteAgentRegistry(env([GOOD]));
    assert.equal(entry?.id, 'finance-bot');
    assert.equal(entry?.timeoutMs, DEFAULT_REMOTE_TIMEOUT_MS);
    assert.equal(entry?.authTokenRef, 'A2A_FINANCE_TOKEN');
    assert.equal(JSON.stringify(entry).includes('secret-value'), false);
  });

  it('skips a disabled entry but still rejects its duplicate id', () => {
    assert.deepEqual([...parseRemoteAgentRegistry(env([{ ...GOOD, enabled: false }]))], []);
    assert.throws(
      () => parseRemoteAgentRegistry(env([{ ...GOOD, enabled: false }, GOOD])),
      /duplicate id/,
    );
  });

  for (const [label, bad, pattern] of [
    ['a malformed id', { ...GOOD, id: 'a.b' }, /id must match/],
    ['a relative cardUrl', { ...GOOD, cardUrl: '/card.json' }, /absolute URL/],
    ['credentials in the URL', { ...GOOD, cardUrl: 'https://u:p@finance.example/card.json' }, /embed credentials/],
    ['a missing credential variable', { ...GOOD, authTokenRef: 'NOT_SET_ANYWHERE' }, /is not set/],
    ['an out-of-range timeout', { ...GOOD, timeoutMs: 10 }, /timeoutMs/],
    ['an unknown field', { ...GOOD, headers: {} }, /not a known field/],
  ] as const) {
    it(`refuses to start with ${label}`, () => {
      assert.throws(() => parseRemoteAgentRegistry(env([bad])), (err: Error) =>
        err instanceof RemoteAgentRegistryError && pattern.test(err.message));
    });
  }

  it('refuses plain http in production but allows it in development', () => {
    const http = { ...GOOD, cardUrl: 'http://agent:4100/a2a/agents/x/.well-known/agent-card.json' };
    assert.equal(parseRemoteAgentRegistry(env([http])).length, 1);
    assert.throws(() => parseRemoteAgentRegistry(env([http]), { production: true }), /https in production/);
  });

  it('refuses a non-array document', () => {
    assert.throws(() => parseRemoteAgentRegistry({ A2A_REMOTE_AGENTS_JSON: '{}' }), /JSON array/);
    assert.throws(() => parseRemoteAgentRegistry({ A2A_REMOTE_AGENTS_JSON: '[' }), RemoteAgentRegistryError);
  });
});

describe('parseRemoteAgentRegistry hiagent protocol (H1)', () => {
  const HI = {
    id: 'hi-helper',
    name: '火山助手',
    description: '通用问答',
    protocol: 'hiagent',
    baseUrl: 'https://hiagent.example/app/v1',
    authTokenRef: 'HIAGENT_APP_KEY',
  };

  function hienv(entries: unknown) {
    return {
      A2A_REMOTE_AGENTS_JSON: JSON.stringify(entries),
      HIAGENT_APP_KEY: 'app-key-value',
      // a2a 混用例（baseUrl 写进 a2a 条目）沿用 GOOD 的凭据引用，两种 token 都给。
      A2A_FINANCE_TOKEN: 'secret-value',
    };
  }

  it('defaults a legacy entry to protocol a2a', () => {
    const [entry] = parseRemoteAgentRegistry(env([GOOD]));
    assert.equal(entry?.protocol, 'a2a');
  });

  it('parses a hiagent entry, strips a trailing slash and never copies the secret', () => {
    const [entry] = parseRemoteAgentRegistry(hienv([{ ...HI, baseUrl: 'https://hiagent.example/app/v1/' }]));
    assert.equal(entry?.protocol, 'hiagent');
    if (entry?.protocol !== 'hiagent') throw new Error('unreachable');
    assert.equal(entry.baseUrl, 'https://hiagent.example/app/v1');
    assert.equal(JSON.stringify(entry).includes('app-key-value'), false);
  });

  it('mixes a2a and hiagent entries in one registry', () => {
    const entries = parseRemoteAgentRegistry({
      A2A_REMOTE_AGENTS_JSON: JSON.stringify([GOOD, HI]),
      A2A_FINANCE_TOKEN: 'secret-value',
      HIAGENT_APP_KEY: 'app-key-value',
    });
    assert.deepEqual(entries.map((e) => [e.id, e.protocol]), [['finance-bot', 'a2a'], ['hi-helper', 'hiagent']]);
  });

  for (const [label, bad, pattern] of [
    ['an unknown protocol', { ...HI, protocol: 'grpc' }, /protocol/],
    ['a hiagent entry with cardUrl', { ...HI, cardUrl: 'https://x/card.json' }, /only for protocol "a2a"/],
    ['an a2a entry with baseUrl', { ...GOOD, baseUrl: 'https://x/app' }, /only for protocol "hiagent"/],
    ['a hiagent entry without baseUrl', { ...HI, baseUrl: undefined }, /absolute URL/],
    ['a hiagent entry with a relative baseUrl', { ...HI, baseUrl: '/app/v1' }, /absolute URL/],
    ['a hiagent entry with credentials in the URL', { ...HI, baseUrl: 'https://u:p@hiagent.example/app' }, /embed credentials/],
    ['a hiagent entry with an unknown field', { ...HI, headers: {} }, /not a known field/],
  ] as const) {
    it(`refuses to start with ${label}`, () => {
      // `baseUrl: undefined` means "key absent" for the missing-URL case.
      const doc = { ...bad } as Record<string, unknown>;
      if (doc.baseUrl === undefined && label === 'a hiagent entry without baseUrl') delete doc.baseUrl;
      assert.throws(() => parseRemoteAgentRegistry(hienv([doc])), (err: Error) =>
        err instanceof RemoteAgentRegistryError && pattern.test(err.message));
    });
  }

  it('refuses plain http baseUrl in production but allows it in development', () => {
    const http = { ...HI, baseUrl: 'http://hiagent:8787/app' };
    assert.equal(parseRemoteAgentRegistry(hienv([http])).length, 1);
    assert.throws(() => parseRemoteAgentRegistry(hienv([http]), { production: true }), /https in production/);
  });
});
