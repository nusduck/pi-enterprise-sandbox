/**
 * 平台角色解析口径（`agent/src/domain/identity/roles.ts`）。
 *
 * 用例来自跨包夹具 `tests/fixtures/contracts/platform-roles-v1.json`：api-server 的
 * 同形实现读**同一组**用例（design §4.3 要求两份实现由同形的测试夹具锁定一致）。
 * 这里只补夹具表达不了的形状（`AuthSubjects` 对象入参）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  KNOWN_ROLES,
  NO_ROLE,
  ROLE_ADMIN,
  ROLE_REVIEWER,
  formatActingRole,
  hasRole,
  isKnownRole,
  parseRoleSet,
  primaryRole,
} from '../../src/domain/identity/roles.js';

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/contracts/platform-roles-v1.json', import.meta.url),
    'utf8',
  ),
);

describe('platform roles (shared contract fixture)', () => {
  it('fixture 与实现的常量一致', () => {
    assert.equal(fixture.contract, 'platform-roles-v1');
    assert.deepEqual([...KNOWN_ROLES], fixture.knownRoles);
    assert.equal(NO_ROLE, fixture.noRole);
  });

  for (const c of fixture.parse) {
    it(`parseRoleSet: ${c.name}`, () => {
      assert.deepEqual(parseRoleSet(c.input), c.roles);
    });
  }

  for (const c of fixture.hasRole) {
    it(`hasRole: ${c.name}`, () => {
      assert.equal(hasRole(c.input, c.query), c.expected);
    });
  }

  for (const c of fixture.primaryRole) {
    it(`primaryRole: ${c.name}`, () => {
      assert.equal(primaryRole(c.input), c.expected);
    });
  }

  for (const c of fixture.actingRole) {
    it(`formatActingRole: ${c.name}`, () => {
      assert.equal(formatActingRole(c.input), c.expected);
    });
  }
});

describe('platform roles (agent shapes)', () => {
  it('isKnownRole 只认白名单，大小写不敏感', () => {
    assert.equal(isKnownRole('admin'), true);
    assert.equal(isKnownRole(' REVIEWER '), true);
    assert.equal(isKnownRole('user'), false);
    assert.equal(isKnownRole(null), false);
    assert.equal(isKnownRole(1), false);
  });

  it('hasRole 接受 AuthSubjects 形状（BFF 写入的 X-Acting-Role）', () => {
    assert.equal(hasRole({ role: 'admin,reviewer' }, ROLE_ADMIN), true);
    assert.equal(hasRole({ role: 'admin,reviewer' }, ROLE_REVIEWER), true);
    assert.equal(hasRole({ role: 'reviewer' }, ROLE_ADMIN), false);
    // BFF 没解析出角色（null）必须拒绝，不能当成普通用户放行管理面。
    assert.equal(hasRole({ role: null }, ROLE_ADMIN), false);
    assert.equal(hasRole(null, ROLE_ADMIN), false);
    assert.equal(hasRole(undefined, ROLE_ADMIN), false);
  });
});
