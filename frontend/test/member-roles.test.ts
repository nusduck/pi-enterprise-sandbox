/**
 * RBAC 一期前端（design `docs/design/rbac-roles.md` §4.3 / §5 / §6）。
 *
 * 三块容易悄悄写错、又只有静态判据能守住的东西：
 * 1. `hasAdminRole` 的 fail-closed 语义（读错一个字面比较就是越权或把人挡在门外）；
 * 2. 409 错误码到中文提示的映射（退化成「操作失败」等于让管理员猜）；
 * 3. 列表的加载 / 错误 / 空三态（把加载失败画成「无成员」是本设计明确禁止的）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

import { hasAdminRole, hasRole, rolesOf } from '../src/shared/security/roles.ts';
import {
  MEMBER_ROLE_ERROR_ZH,
  ROLE_PINNED_TOOLTIP,
  formatMemberTimestamp,
  isRolePinned,
  isSelfMember,
  memberDisplayName,
  memberRoleErrorMessage,
  memberSecondaryName,
  membersListState,
  roleEventActionLabel,
  roleEventActorLabel,
  roleEventSourceLabel,
  withRole,
} from '../src/pages/settings/memberRoles.ts';
import {
  grantAdminMemberRole,
  listAdminMemberRoleEvents,
  listAdminMembers,
  revokeAdminMemberRole,
} from '../src/shared/api/adminMembers.ts';

const src = (relative: string) => readFileSync(join(__dirname, '..', relative), 'utf8');

describe('hasAdminRole：优先 roles，缺失回退 role，解析不出来就是 false', () => {
  it('roles 数组是权威', () => {
    assert.equal(hasAdminRole({ roles: ['admin'] }), true);
    assert.equal(hasAdminRole({ roles: ['admin', 'reviewer'] }), true);
    assert.equal(hasAdminRole({ roles: ['reviewer'] }), false);
    assert.equal(hasAdminRole({ roles: [] }), false);
    assert.equal(hasAdminRole({ roles: ['Admin'] }), true);
    assert.equal(hasAdminRole({ roles: ['admin,reviewer'] }), true);
  });

  it('roles 缺失时回退到兼容的单值 role', () => {
    assert.equal(hasAdminRole({ role: 'admin' }), true);
    assert.equal(hasAdminRole({ role: 'admin,reviewer' }), true);
    assert.equal(hasAdminRole({ role: 'ADMIN' }), true);
    assert.equal(hasAdminRole({ role: 'reviewer' }), false);
    assert.equal(hasAdminRole({ role: 'user' }), false);
    assert.equal(hasAdminRole({ role: null }), false);
    assert.equal(hasAdminRole({ roles: null, role: 'admin' }), true);
  });

  it('roles 存在时不再看 role（服务端说没有就是没有）', () => {
    assert.equal(hasAdminRole({ roles: ['reviewer'], role: 'admin' }), false);
    assert.equal(hasAdminRole({ roles: [], role: 'admin' }), false);
  });

  it('fail-closed：空值、未知类型、未知角色一律 false', () => {
    assert.equal(hasAdminRole(null), false);
    assert.equal(hasAdminRole(undefined), false);
    assert.equal(hasAdminRole({}), false);
    assert.equal(hasAdminRole({ roles: 'admin' }), false);
    assert.equal(hasAdminRole({ roles: 1 }), false);
    assert.equal(hasAdminRole({ roles: { admin: true } }), false);
    assert.equal(hasAdminRole({ roles: [1, true, null] }), false);
    assert.equal(hasAdminRole({ role: '' }), false);
    assert.equal(hasAdminRole({ role: 'administrator' }), false);
  });

  it('rolesOf 去重并规范化；hasRole 认白名单角色', () => {
    assert.deepEqual([...rolesOf({ role: ' Admin , admin ,REVIEWER' })].sort(), ['admin', 'reviewer']);
    assert.equal(hasRole({ roles: ['reviewer'] }, 'reviewer'), true);
    assert.equal(hasRole({ roles: ['reviewer'] }, 'admin'), false);
    assert.equal(hasRole({ roles: ['admin'] }, ''), false);
  });

  it('四处管理控制台闸门都改读 hasAdminRole，不再写字面比较', () => {
    const files = [
      'src/app/layout/AdminShell.tsx',
      'src/widgets/settings/SettingsDialog.tsx',
      'src/widgets/turn-stream/TurnStream.tsx',
      'src/widgets/conversation-sidebar/ConversationSidebar.tsx',
    ];
    for (const file of files) {
      const source = src(file);
      assert.match(source, /hasAdminRole/, `${file} 应使用 hasAdminRole`);
      assert.doesNotMatch(source, /===\s*'admin'/, `${file} 不应再有 role === 'admin' 字面比较`);
    }
    // SettingsDialog 有两个来源（profile 与 fallback），任一是 admin 即 admin。
    const settings = src('src/widgets/settings/SettingsDialog.tsx');
    assert.match(settings, /hasAdminRole\(profile\)\s*\|\|\s*hasAdminRole\(fallback\)/);
  });

  it('AuthUserSchema 把 roles 收进模型（保持 passthrough）', () => {
    const schema = src('src/shared/schemas/api.ts');
    assert.match(schema, /roles:\s*z\.array\(z\.string\(\)\)\.optional\(\)/);
    assert.match(schema, /\.passthrough\(\)/);
  });
});

describe('成员与角色页的错误提示映射', () => {
  it('LAST_ADMIN / ROLE_PINNED_BY_DEPLOYMENT 有专门的中文提示', () => {
    assert.equal(
      memberRoleErrorMessage({ code: 'LAST_ADMIN', message: 'cannot revoke the last admin' }),
      '不能撤销本组织的最后一个管理员',
    );
    assert.equal(
      memberRoleErrorMessage({ code: 'ROLE_PINNED_BY_DEPLOYMENT', message: 'pinned' }),
      '该管理员由部署锁定，不能撤销',
    );
    assert.equal(MEMBER_ROLE_ERROR_ZH.LAST_ADMIN, '不能撤销本组织的最后一个管理员');
    assert.equal(MEMBER_ROLE_ERROR_ZH.ROLE_PINNED_BY_DEPLOYMENT, '该管理员由部署锁定，不能撤销');
  });

  it('没有映射的错误码用服务端文案兜底，再退回「操作失败」', () => {
    assert.equal(memberRoleErrorMessage({ code: 'WHATEVER', message: '上游超时' }), '上游超时');
    assert.equal(memberRoleErrorMessage(new Error('boom')), 'boom');
    assert.equal(memberRoleErrorMessage(null), '操作失败');
    assert.equal(memberRoleErrorMessage({}), '操作失败');
    assert.equal(memberRoleErrorMessage({ code: 500, message: '   ' }), '操作失败');
  });

  it('工具函数：展示名、锁定、时间、乐观集合、操作者与来源中文化', () => {
    assert.equal(memberDisplayName({ display_name: 'Alice', username: 'alice' }), 'Alice');
    assert.equal(memberDisplayName({ display_name: null, username: 'alice' }), 'alice');
    assert.equal(memberDisplayName({ display_name: null, username: null }), '—');
    assert.equal(memberSecondaryName({ display_name: 'Alice', username: 'alice' }), 'alice');
    assert.equal(memberSecondaryName({ display_name: 'alice', username: 'alice' }), null);
    assert.equal(memberSecondaryName({ display_name: 'Alice', username: null }), null);

    assert.equal(isRolePinned({ pinned_roles: ['admin'] }, 'admin'), true);
    assert.equal(isRolePinned({ pinned_roles: ['admin'] }, 'reviewer'), false);
    assert.equal(isRolePinned({ pinned_roles: [] }, 'admin'), false);

    assert.equal(formatMemberTimestamp(null), '—');
    assert.equal(formatMemberTimestamp(''), '—');
    assert.equal(formatMemberTimestamp('not-a-date'), 'not-a-date');
    assert.equal(formatMemberTimestamp('2026-09-30T10:00:00.000Z').includes('2026'), true);

    assert.deepEqual(withRole(['reviewer'], 'admin', true), ['admin', 'reviewer']);
    assert.deepEqual(withRole(['admin', 'reviewer'], 'admin', false), ['reviewer']);
    assert.deepEqual(withRole(['ADMIN'], 'admin', false), []);

    assert.equal(roleEventSourceLabel('console'), '界面授予');
    assert.equal(roleEventSourceLabel('bootstrap'), '部署引导');
    assert.equal(roleEventSourceLabel('migration'), '数据迁移');
    assert.equal(roleEventSourceLabel('unknown'), 'unknown');
    assert.equal(roleEventActionLabel('grant'), '授予');
    assert.equal(roleEventActionLabel('revoke'), '撤销');
    assert.equal(roleEventActorLabel({ actor_display_name: 'Alice', actor_username: 'alice' }), 'Alice');
    assert.equal(roleEventActorLabel({ actor_display_name: null, actor_username: 'alice' }), 'alice');
    assert.equal(roleEventActorLabel({ actor_display_name: null, actor_username: null }), '系统');

    // 真实形状：`me.id` 是凭据 id，成员列表的 `user_id` 是内部 ULID——不同 id 空间，
    // 所以靠用户名认人（`auth_credentials.username` 有唯一索引）。
    assert.equal(
      isSelfMember({ user_id: '01M1INTERNAL00000000000000', username: 'alice' }, { id: 'cred-1', username: 'alice' }),
      true,
    );
    assert.equal(
      isSelfMember({ user_id: '01M1INTERNAL00000000000000', username: 'bob' }, { id: 'cred-1', username: 'alice' }),
      false,
    );
    // 拿不到用户名时才退回 id 比对。
    assert.equal(isSelfMember({ user_id: 'u1' }, { id: 'u1', username: 'alice' }), true);
    assert.equal(isSelfMember({ user_id: 'u2' }, { id: 'u1', username: 'alice' }), false);
    assert.equal(isSelfMember({ username: 'alice' }, { username: 'alice' }), true);
    assert.equal(isSelfMember({ username: 'bob' }, { username: 'alice' }), false);
    assert.equal(isSelfMember({ user_id: 'u1' }, null), false);
  });
});

describe('列表三态：错误态与空态是两个分支', () => {
  it('错误优先，绝不被渲染成「无成员」', () => {
    assert.equal(membersListState({ loading: false, error: '读取失败', count: 0 }), 'error');
    assert.equal(membersListState({ loading: true, error: '读取失败', count: 0 }), 'error');
    // 有旧数据时错误也仍然是错误态，不假装成 ready。
    assert.equal(membersListState({ loading: false, error: '读取失败', count: 5 }), 'error');
  });

  it('空态与加载态各自独立', () => {
    assert.equal(membersListState({ loading: true, error: null, count: 0 }), 'loading');
    assert.equal(membersListState({ loading: false, error: null, count: 0 }), 'empty');
    assert.equal(membersListState({ loading: false, error: null, count: 3 }), 'ready');
  });

  it('页面把两种分支分别渲染出来（错误带重试，空态是另一句话）', () => {
    const page = src('src/pages/settings/MembersPage.tsx');
    assert.match(page, /listState === 'error'/);
    assert.match(page, /读取成员列表失败/);
    assert.match(page, /重试/);
    assert.match(page, /listState === 'empty'/);
    assert.match(page, /没有匹配的成员。/);
    // 读取失败必须清成错误态，不能留一份「看起来像空列表」的数据。
    assert.match(page, /setMembers\(null\)/);
    assert.match(page, /ROLE_PINNED_TOOLTIP/);
    assert.match(page, /window\.confirm/);
    assert.match(page, /refreshAuthUser\(\)/);
    assert.match(page, /withRole\(m\.roles, role, next\)/);
  });

  it('部署锁定的 tooltip 用对了变量名', () => {
    assert.match(ROLE_PINNED_TOOLTIP, /SANDBOX_AUTH_ADMIN_USERNAMES/);
    assert.doesNotMatch(ROLE_PINNED_TOOLTIP, /SANDBOX_ADMIN_USERNAMES/);
  });

  it('页面在管理控制台里可达', () => {
    assert.match(src('src/app/layout/AdminShell.tsx'), /'\/admin\/members'/);
    assert.match(src('src/app/layout/AdminShell.tsx'), /成员与角色/);
    assert.match(src('src/app/router/index.tsx'), /path="\/admin\/members"/);
    assert.match(src('src/app/router/index.tsx'), /admin\(<MembersPage \/>\)/);
  });
});

describe('adminMembers 客户端：请求形状与错误码保真', () => {
  it('列表把筛选映射成 q / role / cursor / limit', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url) => {
      seen.push(new URL(String(url), ORIGIN));
      return jsonResponse(200, { members: [], next_cursor: null });
    }));
    await listAdminMembers({ q: 'ali', role: 'admin', cursor: 'c1', limit: 20 });
    await listAdminMembers();
    assert.equal(seen[0].pathname, '/api/admin/users');
    assert.equal(seen[0].searchParams.get('q'), 'ali');
    assert.equal(seen[0].searchParams.get('role'), 'admin');
    assert.equal(seen[0].searchParams.get('cursor'), 'c1');
    assert.equal(seen[0].searchParams.get('limit'), '20');
    assert.equal(seen[1].searchParams.get('q'), null);
    assert.equal(seen[1].searchParams.get('role'), null);
    assert.equal(seen[1].searchParams.get('limit'), '50');
  });

  it('授予用 PUT、撤销用 DELETE，路径段编码', async (t) => {
    const seen = [];
    t.after(stubFetch(async (url, init) => {
      seen.push({ url: new URL(String(url), ORIGIN), init });
      return jsonResponse(200, member());
    }));
    await grantAdminMemberRole('u 1', 'admin');
    await revokeAdminMemberRole('u 1', 'admin');
    assert.equal(seen[0].url.pathname, '/api/admin/users/u%201/roles/admin');
    assert.equal(seen[0].init.method, 'PUT');
    assert.equal(seen[1].url.pathname, '/api/admin/users/u%201/roles/admin');
    assert.equal(seen[1].init.method, 'DELETE');
  });

  it('409 的 code 原样保留，页面才翻译得出中文', async (t) => {
    t.after(stubFetch(async () => jsonResponse(409, {
      error: 'Cannot revoke the last admin of this organization',
      code: 'LAST_ADMIN',
    })));
    await assert.rejects(revokeAdminMemberRole('u1', 'admin'), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'LAST_ADMIN');
      assert.equal(memberRoleErrorMessage(err), '不能撤销本组织的最后一个管理员');
      return true;
    });
  });

  it('role-events 解析 events 数组', async (t) => {
    t.after(stubFetch(async (url) => {
      assert.equal(new URL(String(url), ORIGIN).pathname, '/api/admin/users/u1/role-events');
      return jsonResponse(200, {
        events: [{
          event_id: 'e1', role: 'admin', action: 'grant', source: 'bootstrap',
          actor_user_id: null, actor_username: null, actor_display_name: null,
          created_at: '2026-09-30T10:00:00.000Z',
        }],
      });
    }));
    const events = await listAdminMemberRoleEvents('u1');
    assert.equal(events.length, 1);
    assert.equal(events[0].source, 'bootstrap');
    assert.equal(roleEventActorLabel(events[0]), '系统');
  });

  it('列表响应缺 members 时抛错（契约漂移不能被当成空列表）', async (t) => {
    t.after(stubFetch(async () => jsonResponse(200, { members: [{ username: 'no-id' }] })));
    await assert.rejects(listAdminMembers(), /contract mismatch/);
  });
});

const ORIGIN = 'http://bff.test';

function member() {
  return {
    user_id: 'u1',
    username: 'alice',
    display_name: 'Alice',
    email: 'a@b.co',
    roles: ['admin'],
    pinned_roles: [],
    last_login_at: null,
  };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}
