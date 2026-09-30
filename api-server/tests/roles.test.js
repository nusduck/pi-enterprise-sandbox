/**
 * 平台角色解析口径（`api-server/src/domain/roles.ts`）。
 *
 * 用例来自跨包夹具 `tests/fixtures/contracts/platform-roles-v1.json`：Agent 侧的
 * 同形实现读**同一组**用例（design `docs/design/rbac-roles.md` §4.3 要求两份实现
 * 由同形的测试夹具锁定一致）。这里只补夹具表达不了的形状（`actingRole` 字段名与
 * `BFF_DEV_ACTING_ROLE` 的解析）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

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
} from '../src/domain/roles.js';
import { resolveDevelopmentActingIdentity } from '../src/config.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../tests/fixtures/contracts/platform-roles-v1.json', import.meta.url), 'utf8'),
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

describe('platform roles (bff shapes)', () => {
  it('isKnownRole 只认白名单，大小写不敏感', () => {
    assert.equal(isKnownRole('admin'), true);
    assert.equal(isKnownRole(' REVIEWER '), true);
    assert.equal(isKnownRole('user'), false);
    assert.equal(isKnownRole(undefined), false);
  });

  it('hasRole 认 TrustedAuthContext 的 actingRole 字段', () => {
    assert.equal(hasRole({ actingRole: 'admin,reviewer' }, ROLE_ADMIN), true);
    assert.equal(hasRole({ actingRole: 'admin,reviewer' }, ROLE_REVIEWER), true);
    assert.equal(hasRole({ actingRole: 'reviewer' }, ROLE_ADMIN), false);
    assert.equal(hasRole({ actingRole: null }, ROLE_ADMIN), false);
    assert.equal(hasRole({}, ROLE_ADMIN), false);
    assert.equal(hasRole(null, ROLE_ADMIN), false);
  });

  it('BFF_DEV_ACTING_ROLE 接受逗号集合，未知值被丢弃', () => {
    const id = (role) => resolveDevelopmentActingIdentity({ BFF_DEV_ACTING_ROLE: role });
    assert.equal(id('admin').actingRole, 'admin');
    assert.equal(id('admin,reviewer').actingRole, 'admin,reviewer');
    assert.equal(id('reviewer').actingRole, 'reviewer');
    assert.equal(id('root').actingRole, 'user');
    assert.equal(resolveDevelopmentActingIdentity({}).actingRole, 'user');
  });
});
