/**
 * BFF production config fail-fast.
 * Run: node --test api-server/tests/production-config.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDeploymentEnv,
  validateProductionConfig,
  effectiveConfig,
  isWeakSecret,
  resolveAuthEnabled,
} from '../config.js';

const STRONG = 'b'.repeat(64);

describe('resolveDeploymentEnv', () => {
  it('defaults to development', () => {
    assert.equal(resolveDeploymentEnv({}), 'development');
  });
});

describe('validateProductionConfig', () => {
  it('no-ops in development with empty tokens', () => {
    assert.doesNotThrow(() =>
      validateProductionConfig({
        DEPLOYMENT_ENV: 'development',
        AGENT_INTERNAL_TOKEN: '',
        SANDBOX_API_TOKEN: '',
        AUTH_ENABLED: 'false',
      }),
    );
  });

  it('requires tokens and auth in production', () => {
    assert.throws(
      () =>
        validateProductionConfig({
          DEPLOYMENT_ENV: 'production',
          AGENT_INTERNAL_TOKEN: '',
          SANDBOX_API_TOKEN: '',
          AUTH_ENABLED: 'false',
        }),
      /Production configuration is unsafe/,
    );
  });

  it('requires AUTH_ENABLED in production', () => {
    assert.throws(
      () =>
        validateProductionConfig({
          DEPLOYMENT_ENV: 'production',
          AGENT_INTERNAL_TOKEN: STRONG,
          SANDBOX_API_TOKEN: STRONG,
          AUTH_ENABLED: 'false',
        }),
      /AUTH_ENABLED/,
    );
  });

  it('accepts strong production config', () => {
    assert.doesNotThrow(() =>
      validateProductionConfig({
        DEPLOYMENT_ENV: 'production',
        AGENT_INTERNAL_TOKEN: STRONG,
        SANDBOX_API_TOKEN: STRONG,
        AUTH_ENABLED: 'true',
      }),
    );
  });

  it('accepts SANDBOX_AUTH_ENABLED as auth signal', () => {
    assert.doesNotThrow(() =>
      validateProductionConfig({
        DEPLOYMENT_ENV: 'production',
        AGENT_INTERNAL_TOKEN: STRONG,
        SANDBOX_API_TOKEN: STRONG,
        SANDBOX_AUTH_ENABLED: 'true',
      }),
    );
  });
});

describe('effectiveConfig redaction', () => {
  it('never dumps service tokens', () => {
    const snap = effectiveConfig({
      PORT: 4000,
      NODE_ENV: 'production',
      DEPLOYMENT_ENV: 'production',
      SANDBOX_BASE_URL: 'http://sandbox:8081',
      SANDBOX_API_TOKEN: 'sandbox-secret-value',
      AGENT_BASE_URL: 'http://agent:4100',
      AGENT_INTERNAL_TOKEN: 'agent-secret-value',
      AUTH_ENABLED: true,
      APPROVAL_ENABLED: true,
    });
    const text = JSON.stringify(snap);
    assert.equal(snap.SANDBOX_API_TOKEN, '***');
    assert.equal(snap.AGENT_INTERNAL_TOKEN, '***');
    assert.ok(!text.includes('sandbox-secret'));
    assert.ok(!text.includes('agent-secret'));
  });
});

describe('isWeakSecret + resolveAuthEnabled', () => {
  it('detects weak secrets', () => {
    assert.equal(isWeakSecret('x'), true);
    assert.equal(isWeakSecret(STRONG), false);
  });

  it('resolves auth enabled', () => {
    assert.equal(resolveAuthEnabled({ AUTH_ENABLED: 'true' }), true);
  });
});
