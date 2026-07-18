/**
 * Canonical JSON + request hashing unit tests (PR-04 T2).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  stableStringify,
  hashCanonical,
  hashCreateRunRequest,
  sha256Hex,
} from '../../src/application/canonical-json.js';
import { CanonicalJsonError } from '../../src/application/errors.js';

describe('canonical-json', () => {
  it('sorts object keys for stable stringify', () => {
    const a = stableStringify({ b: 1, a: 2 });
    const b = stableStringify({ a: 2, b: 1 });
    assert.equal(a, b);
    assert.equal(a, '{"a":2,"b":1}');
  });

  it('rejects true circular references and non-finite numbers', () => {
    /** @type {any} */
    const o = { a: 1 };
    o.self = o;
    assert.throws(() => canonicalize(o), CanonicalJsonError);
    assert.throws(() => canonicalize(Number.NaN), CanonicalJsonError);
    assert.throws(() => canonicalize(Infinity), CanonicalJsonError);
    assert.throws(() => canonicalize(undefined), CanonicalJsonError);
    assert.throws(() => canonicalize(() => {}), CanonicalJsonError);
  });

  it('allows shared (acyclic) object references without false circular', () => {
    const shared = { x: 1 };
    const graph = { left: shared, right: shared };
    const out = canonicalize(graph);
    assert.deepEqual(out, { left: { x: 1 }, right: { x: 1 } });
    // Stable hash must succeed
    assert.match(hashCanonical(graph), /^[0-9a-f]{64}$/);
  });

  it('hashCanonical is sha256 of stable JSON', () => {
    const h = hashCanonical({ z: true, a: [1, 2] });
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(h, sha256Hex(stableStringify({ z: true, a: [1, 2] })));
  });

  it('hashCreateRunRequest excludes auth secrets and is body-stable', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const h1 = hashCreateRunRequest({
      messages,
      externalConversationId: 'conv-ext',
      agentProfileId: 'profile-1',
      budget: { maxTokens: 10 },
    });
    const h2 = hashCreateRunRequest({
      messages,
      externalConversationId: 'conv-ext',
      agentProfileId: 'profile-1',
      budget: { maxTokens: 10 },
    });
    assert.equal(h1, h2);

    const h3 = hashCreateRunRequest({
      messages: [{ role: 'user', content: 'different' }],
      externalConversationId: 'conv-ext',
    });
    assert.notEqual(h1, h3);
  });

  it('hashCreateRunRequest bounds empty/missing messages', () => {
    assert.throws(() => hashCreateRunRequest({ messages: [] }), CanonicalJsonError);
    assert.throws(
      () => hashCreateRunRequest({ messages: null }),
      CanonicalJsonError,
    );
  });
});
