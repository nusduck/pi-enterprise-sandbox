import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeReturnTo } from '../src/shared/security/returnTo.ts';

describe('sanitizeReturnTo validation', () => {
  it('accepts valid in-site relative paths', () => {
    assert.equal(sanitizeReturnTo('/'), '/');
    assert.equal(sanitizeReturnTo('/admin/runs'), '/admin/runs');
    assert.equal(sanitizeReturnTo('/c/conv-123?tab=files#preview'), '/c/conv-123?tab=files#preview');
  });

  it('rejects protocol-relative URLs (starts with //)', () => {
    assert.equal(sanitizeReturnTo('//evil.example.com'), '/');
    assert.equal(sanitizeReturnTo('///evil.example.com'), '/');
  });

  it('rejects backslash URLs (starts with /\\)', () => {
    assert.equal(sanitizeReturnTo('/\\evil.example.com'), '/');
    assert.equal(sanitizeReturnTo('/\\/evil.example.com'), '/');
  });

  it('rejects absolute URLs and arbitrary protocols', () => {
    assert.equal(sanitizeReturnTo('https://evil.example.com'), '/');
    assert.equal(sanitizeReturnTo('http://evil.example.com'), '/');
    assert.equal(sanitizeReturnTo('javascript:alert(1)'), '/');
    assert.equal(sanitizeReturnTo('data:text/html,foo'), '/');
  });

  it('rejects empty or nullish inputs', () => {
    assert.equal(sanitizeReturnTo(''), '/');
    assert.equal(sanitizeReturnTo(null), '/');
    assert.equal(sanitizeReturnTo(undefined), '/');
  });
});
