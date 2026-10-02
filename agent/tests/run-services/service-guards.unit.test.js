/**
 * service-guards unit tests (C2 收敛钉子)。
 *
 * `requireAuth` / `assertDomainRunId` 是 errors.ts 里收敛出来的两个 helper，
 * 本文件先钉住它们的行为（拒绝 + 成功对照），再由各 service 直接复用：
 * - requireAuth：缺鉴权上下文 → ValidationError('auth is required')；合法透传。
 * - assertDomainRunId：legacy arun_/UUID/非法 ULID → OwnerScopedNotFoundError
 *  （跨租户一律 404，资源名保持各站点原值）；合法 ULID → 归一化透传。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  OwnerScopedNotFoundError,
  ValidationError,
  assertDomainRunId,
  requireAuth,
} from '../../src/application/errors.js';

const VALID_ULID = '01K0G2PAV8FPMVC9QHJG7JPN4Z';

describe('requireAuth', () => {
  it('rejects missing auth context with the legacy literal', () => {
    for (const missing of [null, undefined, 0, '']) {
      assert.throws(
        () => requireAuth(missing),
        (err) =>
          err instanceof ValidationError &&
          err.message === 'auth is required',
      );
    }
  });

  it('passes a present auth object through untouched', () => {
    const auth = { provider: 'bff', externalOrgId: 'o', externalUserId: 'u' };
    assert.equal(requireAuth(auth), auth);
  });
});

describe('assertDomainRunId', () => {
  it('maps legacy arun_ ids to owner-scoped 404 without leaking existence', () => {
    try {
      assertDomainRunId('arun_abc123');
      assert.fail('must throw');
    } catch (err) {
      assert.ok(err instanceof OwnerScopedNotFoundError);
      assert.equal(err.message, 'Run not found');
      assert.equal(err.resource, 'runs');
      assert.equal(err.id, 'arun_abc123');
    }
  });

  it('maps UUID shapes (hyphenated and bare) to the same 404', () => {
    for (const uuid of [
      '550e8400-e29b-41d4-a716-446655440000',
      '550e8400e29b41d4a716446655440000',
    ]) {
      assert.throws(
        () => assertDomainRunId(uuid),
        (err) =>
          err instanceof OwnerScopedNotFoundError &&
          err.resource === 'runs' &&
          err.id === uuid,
      );
    }
  });

  it('maps non-ULID garbage to 404 (assertUlid fallback path)', () => {
    assert.throws(
      () => assertDomainRunId('not-a-ulid'),
      (err) =>
        err instanceof OwnerScopedNotFoundError &&
        err.message === 'Run not found' &&
        err.resource === 'runs',
    );
  });

  it('keeps trace call sites on the trace_spans noun', () => {
    assert.throws(
      () =>
        assertDomainRunId('arun_abc123', {
          resource: 'trace_spans',
          message: 'Trace not found',
        }),
      (err) =>
        err instanceof OwnerScopedNotFoundError &&
        err.message === 'Trace not found' &&
        err.resource === 'trace_spans',
    );
  });

  it('passes a valid ULID through normalized (success对照)', () => {
    assert.equal(assertDomainRunId(VALID_ULID.toLowerCase()), VALID_ULID);
  });

  it('does not trim: padded input stays 404, caller trims first (steer 语义)', () => {
    assert.throws(
      () => assertDomainRunId(`  ${VALID_ULID}  `),
      (err) => err instanceof OwnerScopedNotFoundError,
    );
    assert.equal(
      assertDomainRunId(`  ${VALID_ULID}  `.trim(), { id: `  ${VALID_ULID}  ` }),
      VALID_ULID,
    );
  });
});
