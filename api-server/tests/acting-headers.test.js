/**
 * `X-Acting-*` 剥离钉子测试（C5 A2）。
 *
 * 安全不变量：浏览器带来的 `X-Acting-*`（任何大小写变体）永远不能被转发给
 * exec；外发的身份头只能是服务端解析后写入的值。先钉住行为，再把两处手写
 * 名单收敛到 `http/acting-headers.ts` 的单一来源。
 *
 * Run: npx tsx --test tests/acting-headers.test.js
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sandboxProxyHeaders } from '../src/routes/files.js';
import {
  ACTING_HEADER_NAMES,
  applyTrustedActingHeaders,
  stripActingHeaders,
} from '../src/http/acting-headers.js';

const TRUSTED = {
  actingUserId: '01USER000000000000000000000',
  actingOrganizationId: '01ORG0000000000000000000000',
  actingRole: 'admin',
};

const FORGED = {
  'X-Acting-User-Id': 'forged-user',
  'X-Acting-Organization-Id': 'forged-org',
  'X-Acting-Role': 'admin',
  'x-acting-user-id': 'forged-user-lower',
  'x-acting-organization-id': 'forged-org-lower',
  'x-acting-role': 'admin-lower',
  'X-ACTING-USER-ID': 'forged-user-upper',
  'X-ACTING-ORGANIZATION-ID': 'forged-org-upper',
  'X-ACTING-ROLE': 'admin-upper',
  'X-Acting-user-Id': 'forged-user-mixed',
};

function hasForgedValue(headers) {
  return Object.values(headers).some(
    (value) => typeof value === 'string' && value.startsWith('forged'),
  );
}

describe('X-Acting-* 浏览器头永不转发', () => {
  it('sandboxProxyHeaders：任何大小写变体都不透传，只写服务端的值', () => {
    const headers = sandboxProxyHeaders(
      { headers: { authorization: 'Bearer external-jwt' } },
      { ...FORGED, 'X-Trace-Id': 'a'.repeat(32) },
      TRUSTED,
    );
    assert.equal(hasForgedValue(headers), false);
    assert.equal(headers['X-Acting-User-Id'], TRUSTED.actingUserId);
    assert.equal(headers['X-Acting-Organization-Id'], TRUSTED.actingOrganizationId);
    assert.equal(headers['X-Acting-Role'], TRUSTED.actingRole);
    assert.equal(headers.Authorization, undefined);
  });

  it('sandboxProxyHeaders：缺 trustedAuth 时 fail-closed 抛错，不回退浏览器 token', () => {
    assert.throws(
      () => sandboxProxyHeaders({ headers: {} }, {}, null),
      /resolved trustedAuth/,
    );
    assert.throws(
      () =>
        sandboxProxyHeaders(
          { headers: { authorization: 'Bearer external-jwt' } },
          {},
          { actingUserId: 'u' },
        ),
      /resolved trustedAuth/,
    );
  });
});

describe('stripActingHeaders / applyTrustedActingHeaders', () => {
  it('只剥离 X-Acting-*（大小写不敏感），不改入参、保留其他头', () => {
    const extra = { ...FORGED, 'Content-Type': 'application/json' };
    const stripped = stripActingHeaders(extra);
    assert.equal(hasForgedValue(stripped), false);
    assert.equal(stripped['Content-Type'], 'application/json');
    // 入参不动：调用方传进来的对象保持原样。
    assert.equal(Object.keys(extra).length, Object.keys(FORGED).length + 1);
    assert.deepEqual(
      [...ACTING_HEADER_NAMES].sort(),
      ['X-Acting-Organization-Id', 'X-Acting-Role', 'X-Acting-User-Id'],
    );
  });

  it('服务端身份齐了才写，缺一半就什么都不写（抛不抛由调用方定）', () => {
    const headers = {};
    applyTrustedActingHeaders(headers, TRUSTED);
    assert.equal(headers['X-Acting-User-Id'], TRUSTED.actingUserId);

    const partial = {};
    applyTrustedActingHeaders(partial, { actingUserId: 'u' });
    assert.deepEqual(partial, {});

    const empty = { 'Content-Type': 'application/json' };
    applyTrustedActingHeaders(empty, null);
    assert.deepEqual(empty, { 'Content-Type': 'application/json' });
  });
});
