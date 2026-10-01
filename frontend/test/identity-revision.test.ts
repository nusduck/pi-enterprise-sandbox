/**
 * P1b：身份代次守卫。切号/退出后，旧身份的异步响应必须被丢弃——
 * 这是「过期 me/config/catalog/会话响应不得灌回新身份」的可执行定义。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createIdentityRevision,
  isCurrentIdentity,
} from '../src/features/chat/identityRevision.ts';

describe('identity revision', () => {
  it('starts current and keeps unrelated snapshots valid', () => {
    const revision = createIdentityRevision();
    const snapshot = revision.current();
    assert.equal(revision.isCurrent(snapshot), true);
    assert.equal(isCurrentIdentity(revision, snapshot), true);
  });

  it('invalidates every older snapshot on an identity boundary', () => {
    const revision = createIdentityRevision();
    const beforeLogout = revision.current();
    revision.bump();
    assert.equal(revision.isCurrent(beforeLogout), false);

    const afterLogout = revision.current();
    assert.notEqual(afterLogout, beforeLogout);
    assert.equal(revision.isCurrent(afterLogout), true);
  });

  it('discards a response that resolved after another account took over', () => {
    const revision = createIdentityRevision();
    // 请求 A（旧身份）发出后被请求 B（新身份）超越。
    const requestA = revision.current();
    revision.bump();
    const requestB = revision.current();
    revision.bump();
    assert.equal(isCurrentIdentity(revision, requestA), false);
    assert.equal(isCurrentIdentity(revision, requestB), false);
    // 只有新身份自己的请求能落地。
    const requestC = revision.current();
    assert.equal(isCurrentIdentity(revision, requestC), true);
  });
});
