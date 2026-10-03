/**
 * BFF production config fail-fast.
 * Run: npx tsx --test tests/production-config.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDeploymentEnv,
  validateProductionConfig,
  effectiveConfig,
  isWeakSecret,
  resolveAuthEnabled,
  resolveApprovalMode,
  resolveDevelopmentActingIdentity,
  resolveDatasetUploadMaxBytes,
} from '../src/config.js';

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

  it('rejects explicit auto approval in production', () => {
    assert.throws(
      () =>
        validateProductionConfig({
          DEPLOYMENT_ENV: 'production',
          AGENT_INTERNAL_TOKEN: STRONG,
          SANDBOX_API_TOKEN: STRONG,
          AUTH_ENABLED: 'true',
          APPROVAL_MODE: 'auto_approve',
        }),
      /APPROVAL_MODE=auto_approve/,
    );
  });

  it('accepts explicit ask and deny modes in production', () => {
    for (const APPROVAL_MODE of ['ask', 'deny']) {
      assert.doesNotThrow(() =>
        validateProductionConfig({
          DEPLOYMENT_ENV: 'production',
          AGENT_INTERNAL_TOKEN: STRONG,
          SANDBOX_API_TOKEN: STRONG,
          AUTH_ENABLED: 'true',
          APPROVAL_MODE,
        }),
      );
    }
  });

  it('rejects the retired SANDBOX_AUTH_ENABLED alias as auth signal', () => {
    assert.throws(
      () =>
        validateProductionConfig({
          DEPLOYMENT_ENV: 'production',
          AGENT_INTERNAL_TOKEN: STRONG,
          SANDBOX_API_TOKEN: STRONG,
          SANDBOX_AUTH_ENABLED: 'true',
        }),
      /AUTH_ENABLED/,
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
      APPROVAL_MODE: 'ask',
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

  it('resolves a stable auth-disabled development owner', () => {
    assert.deepEqual(resolveDevelopmentActingIdentity({}), {
      actingUserId: 'local-development-user',
      actingOrganizationId: 'local-development-org',
      actingRole: 'user',
    });
    assert.deepEqual(
      resolveDevelopmentActingIdentity({
        BFF_DEV_ACTING_USER_ID: 'dev-user-a',
        BFF_DEV_ACTING_ORGANIZATION_ID: 'dev-org-a',
        BFF_DEV_ACTING_ROLE: 'admin',
      }),
      {
        actingUserId: 'dev-user-a',
        actingOrganizationId: 'dev-org-a',
        actingRole: 'admin',
      },
    );
    assert.equal(
      resolveDevelopmentActingIdentity({ BFF_DEV_ACTING_ROLE: 'operator' })
        .actingRole,
      'user',
    );
  });

  it('resolves auth enabled', () => {
    assert.equal(resolveAuthEnabled({ AUTH_ENABLED: 'true' }), true);
    assert.equal(resolveApprovalMode({}), 'ask');
    assert.equal(resolveApprovalMode({ APPROVAL_MODE: 'deny' }), 'deny');
    assert.equal(resolveApprovalMode({ APPROVAL_ENABLED: 'false' }), 'ask');
  });

  it('resolves a positive configurable Dataset upload byte limit', () => {
    assert.equal(
      resolveDatasetUploadMaxBytes({ DATASET_UPLOAD_MAX_BYTES: '12345' }),
      12345,
    );
    assert.equal(
      resolveDatasetUploadMaxBytes({ DATASET_UPLOAD_MAX_BYTES: '-1' }),
      55 * 1024 * 1024,
    );
    assert.equal(
      resolveDatasetUploadMaxBytes({ DATASET_UPLOAD_MAX_BYTES: 'invalid' }),
      55 * 1024 * 1024,
    );
  });
});
