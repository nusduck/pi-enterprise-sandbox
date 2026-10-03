/**
 * P1b：401/503 分流与退出撤销结果的可见判定。这里锁定对外行为，
 * 保证「服务失败」不会被渲染成「未登录」或「撤销成功」。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/shared/api/client.ts';
import {
  AUTH_CONFIG_UNAVAILABLE_MESSAGE,
  AUTH_UNAVAILABLE_MESSAGE,
  ME_SESSION_REJECTED_MESSAGE,
  authFailureMessage,
  classifyAuthFailure,
  interpretLogoutResult,
  unconfirmedLogoutWarning,
} from '../src/shared/api/authConfig.ts';

describe('classifyAuthFailure', () => {
  it('treats a 401 (or INVALID_TOKEN) as anonymous', () => {
    assert.equal(classifyAuthFailure(new ApiError('nope', { status: 401 })).kind, 'unauthenticated');
    assert.equal(classifyAuthFailure(new ApiError('nope', { code: 'INVALID_TOKEN' })).kind, 'unauthenticated');
  });

  it('treats 503 / network / parsing failures as temporarily unavailable', () => {
    assert.equal(classifyAuthFailure(new ApiError('busy', { status: 503 })).kind, 'unavailable');
    assert.equal(classifyAuthFailure(new Error('Failed to fetch')).kind, 'unavailable');
    assert.equal(classifyAuthFailure(new Error('contract mismatch: user: Required')).kind, 'unavailable');
    assert.equal(classifyAuthFailure(undefined).kind, 'unavailable');
  });

  it('does not turn an unexpected 4xx contract error into a logout', () => {
    const failure = classifyAuthFailure(new ApiError('no route', { status: 404 }));
    assert.equal(failure.kind, 'unavailable');
    assert.equal(failure.status, 404);
  });

  it('never lets a raw empty message replace the stable fallback', () => {
    const empty = classifyAuthFailure(new ApiError('', { status: 503 }));
    assert.equal(authFailureMessage(empty, AUTH_UNAVAILABLE_MESSAGE), AUTH_UNAVAILABLE_MESSAGE);
    const config = classifyAuthFailure(new Error('Failed to fetch'));
    assert.equal(authFailureMessage(config, AUTH_CONFIG_UNAVAILABLE_MESSAGE), 'Failed to fetch');
  });
});

describe('interpretLogoutResult', () => {
  it('accepts both confirmed outcomes', () => {
    assert.deepEqual(interpretLogoutResult({ revocation: 'confirmed' }), {
      revocation: 'confirmed',
      code: null,
      warning: null,
    });
    assert.equal(interpretLogoutResult({ revocation: 'not_required' }).warning, null);
  });

  it('never upgrades an unknown or missing body to confirmed', () => {
    assert.equal(interpretLogoutResult({ ok: true }).revocation, 'unconfirmed');
    assert.equal(interpretLogoutResult(null).revocation, 'unconfirmed');
    assert.match(String(interpretLogoutResult({ ok: true }).warning), /撤销未确认/);
  });

  it('gives the unconfirmed warning for 503 and the generic one otherwise', () => {
    assert.match(unconfirmedLogoutWarning('AUTH_REVOCATION_UNCONFIRMED'), /未确认撤销/);
    assert.match(unconfirmedLogoutWarning(null), /网络或服务故障/);
    // 已删除的旧 409 码不再有专属文案，落到通用未确认提示。
    assert.match(unconfirmedLogoutWarning('LEGACY_SESSION_NOT_REVOCABLE'), /网络或服务故障/);
  });
});

describe('me session rejection', () => {
  it('prompts re-login without claiming a server-side revocation happened', () => {
    // me 401 只清本机身份；不补发 logout，所以文案不能出现「撤销」语义。
    assert.match(ME_SESSION_REJECTED_MESSAGE, /重新登录/);
    assert.doesNotMatch(ME_SESSION_REJECTED_MESSAGE, /撤销/);
  });
});
