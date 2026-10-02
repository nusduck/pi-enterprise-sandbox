/**
 * CSRF guard for auth write requests: Origin / Fetch Metadata.
 * Run: npx tsx --test tests/auth-request-guard.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import {
  CROSS_SITE_AUTH_CODE,
  detectCrossSiteAuthWrite,
} from '../src/http/auth-request-guard.js';

function req(headers) {
  return { headers, socket: {} };
}

describe('detectCrossSiteAuthWrite', () => {
  it('allows a non-browser request with no Origin and no Fetch Metadata', () => {
    assert.equal(detectCrossSiteAuthWrite(req({})), null);
  });

  it('rejects Sec-Fetch-Site: cross-site even without Origin', () => {
    const rejection = detectCrossSiteAuthWrite(req({ 'sec-fetch-site': 'cross-site' }));
    assert.equal(rejection?.code, CROSS_SITE_AUTH_CODE);
  });

  it('rejects an opaque (null) Origin', () => {
    assert.equal(
      detectCrossSiteAuthWrite(req({ origin: 'null' }))?.code,
      CROSS_SITE_AUTH_CODE,
    );
  });

  it('rejects a malformed Origin', () => {
    assert.equal(
      detectCrossSiteAuthWrite(req({ origin: 'not a url' }))?.code,
      CROSS_SITE_AUTH_CODE,
    );
  });

  it('rejects an unknown cross-site Origin with a matching fetch mode', () => {
    const rejection = detectCrossSiteAuthWrite(
      req({ origin: 'https://evil.example', host: 'app.example' }),
    );
    assert.equal(rejection?.code, CROSS_SITE_AUTH_CODE);
  });

  it('accepts a same-origin Origin (host matches Host)', () => {
    assert.equal(
      detectCrossSiteAuthWrite(
        req({ origin: 'https://app.example', host: 'app.example' }),
      ),
      null,
    );
  });

  it('accepts a browser-attested same-origin request despite a rewritten Host', () => {
    assert.equal(
      detectCrossSiteAuthWrite(
        req({
          origin: 'http://localhost:5173',
          host: 'localhost:4000',
          'sec-fetch-site': 'same-origin',
        }),
      ),
      null,
    );
  });

  it('accepts an allowlisted CORS origin', () => {
    const previous = [...config.CORS_ALLOWED_ORIGINS];
    config.CORS_ALLOWED_ORIGINS.push('https://partner.example');
    try {
      assert.equal(
        detectCrossSiteAuthWrite(
          req({ origin: 'https://partner.example', host: 'app.example' }),
        ),
        null,
      );
    } finally {
      config.CORS_ALLOWED_ORIGINS.length = 0;
      config.CORS_ALLOWED_ORIGINS.push(...previous);
    }
  });

  it('keeps the HTTP dev loopback origin working outside production', () => {
    const previous = config.DEPLOYMENT_ENV;
    config.DEPLOYMENT_ENV = 'development';
    try {
      assert.equal(
        detectCrossSiteAuthWrite(
          req({ origin: 'http://localhost:5173', host: 'localhost:4000' }),
        ),
        null,
      );
    } finally {
      config.DEPLOYMENT_ENV = previous;
    }
  });

  it('does not grant the loopback exemption in production', () => {
    const previous = config.DEPLOYMENT_ENV;
    config.DEPLOYMENT_ENV = 'production';
    try {
      assert.equal(
        detectCrossSiteAuthWrite(
          req({ origin: 'http://localhost:5173', host: 'localhost:4000' }),
        )?.code,
        CROSS_SITE_AUTH_CODE,
      );
    } finally {
      config.DEPLOYMENT_ENV = previous;
    }
  });
});
