/**
 * Security helpers — URL allowlist.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedApiUrl, safeApiUrl } from '../src/shared/security/url.ts';

describe('isAllowedApiUrl', () => {
  it('accepts relative /api/ paths', () => {
    assert.equal(
      isAllowedApiUrl('/api/files/download?session_id=s&path=x'),
      true,
    );
    assert.equal(
      isAllowedApiUrl('/api/files/artifact-download?session_id=s&artifact_id=a'),
      true,
    );
  });

  it('rejects absolute and protocol-relative URLs', () => {
    assert.equal(isAllowedApiUrl('https://evil.com/api/x'), false);
    assert.equal(isAllowedApiUrl('//evil.com/api/x'), false);
    assert.equal(isAllowedApiUrl('http://localhost/api/x'), false);
  });

  it('rejects javascript and data schemes', () => {
    assert.equal(isAllowedApiUrl('javascript:alert(1)'), false);
    assert.equal(isAllowedApiUrl('data:text/html,hi'), false);
  });

  it('rejects path traversal out of /api/', () => {
    assert.equal(isAllowedApiUrl('/api/../admin'), false);
    assert.equal(isAllowedApiUrl('/api/files/../../etc/passwd'), false);
  });

  it('rejects empty / non-string', () => {
    assert.equal(isAllowedApiUrl(''), false);
    assert.equal(isAllowedApiUrl(null), false);
    assert.equal(isAllowedApiUrl(undefined), false);
    assert.equal(isAllowedApiUrl(123), false);
  });

  it('rejects whitespace and attribute-breakout chars', () => {
    assert.equal(isAllowedApiUrl('/api/x y'), false);
    assert.equal(isAllowedApiUrl('/api/x"onclick'), false);
    assert.equal(isAllowedApiUrl("/api/x'"), false);
  });
});

describe('safeApiUrl', () => {
  it('returns url or null', () => {
    assert.equal(safeApiUrl('/api/ok'), '/api/ok');
    assert.equal(safeApiUrl('https://evil'), null);
  });
});
