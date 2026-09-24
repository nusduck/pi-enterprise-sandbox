/**
 * `envelope.ts` 的测试：信封是从网络反序列化来的，`assertEnvelope` 必须
 * 真的在运行时逐字段校验，而不是只在编译期"看起来"类型对。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ContractError } from '../src/errors.js';
import { assertEnvelope, errResult, okResult, parseEnvelope } from '../src/envelope.js';
import type { RpcEnvelope } from '../src/envelope.js';

const VALID_ENVELOPE: RpcEnvelope = Object.freeze({
  requestId: 'req-1',
  workspaceId: 'ws-1',
  orgId: 'org-1',
  userId: 'user-1',
  fenceToken: 7,
});

function expectEnvelopeInvalid(value: unknown): void {
  assert.throws(
    () => assertEnvelope(value),
    (error: unknown) => error instanceof ContractError && error.code === 'ENVELOPE_INVALID',
  );
}

describe('assertEnvelope', () => {
  it('accepts a fully-populated envelope', () => {
    assert.doesNotThrow(() => assertEnvelope(VALID_ENVELOPE));
  });

  it('rejects a non-object value', () => {
    expectEnvelopeInvalid(null);
    expectEnvelopeInvalid(undefined);
    expectEnvelopeInvalid('not-an-object');
    expectEnvelopeInvalid(42);
    expectEnvelopeInvalid([]);
  });

  it('rejects a missing requestId', () => {
    const { requestId: _requestId, ...rest } = VALID_ENVELOPE;
    expectEnvelopeInvalid(rest);
  });

  it('rejects a missing workspaceId — the multi-instance routing key must stay mandatory', () => {
    const { workspaceId: _workspaceId, ...rest } = VALID_ENVELOPE;
    expectEnvelopeInvalid(rest);
    expectEnvelopeInvalid({ ...VALID_ENVELOPE, workspaceId: '' });
    expectEnvelopeInvalid({ ...VALID_ENVELOPE, workspaceId: 123 });
  });

  it('rejects a missing orgId or userId', () => {
    const { orgId: _orgId, ...withoutOrg } = VALID_ENVELOPE;
    expectEnvelopeInvalid(withoutOrg);
    const { userId: _userId, ...withoutUser } = VALID_ENVELOPE;
    expectEnvelopeInvalid(withoutUser);
  });

  it('rejects a non-integer, negative, or missing fenceToken', () => {
    expectEnvelopeInvalid({ ...VALID_ENVELOPE, fenceToken: -1 });
    expectEnvelopeInvalid({ ...VALID_ENVELOPE, fenceToken: 1.5 });
    expectEnvelopeInvalid({ ...VALID_ENVELOPE, fenceToken: '7' });
    const { fenceToken: _fenceToken, ...withoutFence } = VALID_ENVELOPE;
    expectEnvelopeInvalid(withoutFence);
  });

  it('accepts fenceToken 0 (fence tokens start counting at zero)', () => {
    assert.doesNotThrow(() => assertEnvelope({ ...VALID_ENVELOPE, fenceToken: 0 }));
  });
});

describe('parseEnvelope', () => {
  it('returns the same value once validated', () => {
    assert.deepEqual(parseEnvelope(VALID_ENVELOPE), VALID_ENVELOPE);
  });

  it('throws the same ContractError as assertEnvelope', () => {
    assert.throws(
      () => parseEnvelope({}),
      (error: unknown) => error instanceof ContractError && error.code === 'ENVELOPE_INVALID',
    );
  });
});

describe('okResult / errResult', () => {
  it('wraps success and failure results with the expected discriminant', () => {
    const success = okResult({ hello: 'world' });
    assert.equal(success.ok, true);
    assert.deepEqual(success.data, { hello: 'world' });

    const failure = errResult({ code: 'AUTH_FAILED', message: 'nope' });
    assert.equal(failure.ok, false);
    assert.deepEqual(failure.error, { code: 'AUTH_FAILED', message: 'nope' });
  });
});
