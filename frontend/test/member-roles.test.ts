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
  NO_LOGIN_RECORD_TOOLTIP,
  ROLE_LABEL_ZH,
  ROLE_PINNED_TOOLTIP,
  formatMemberDepartment,
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
  roleLabel,
  sortRoleEventsDesc,
  withRole,
} from '../src/pages/settings/memberRoles.ts';
import {
  AdminMemberSchema,
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

    assert.equal(roleEventSourceLabel('console'), '管理界面');
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

  it('工具函数：部门空值格式化为「—」，有效字符串展示原值', () => {
    assert.equal(formatMemberDepartment('工程部'), '工程部');
    assert.equal(formatMemberDepartment('  产品研发部  '), '产品研发部');
    assert.equal(formatMemberDepartment(null), '—');
    assert.equal(formatMemberDepartment(undefined), '—');
    assert.equal(formatMemberDepartment(''), '—');
    assert.equal(formatMemberDepartment('   '), '—');
  });
});

describe('成员与角色的界面信息设计（§3.1）', () => {
  it('角色代码在界面上显示成中文，代码只留在悬停提示里', () => {
    assert.equal(roleLabel('admin'), '管理员');
    assert.equal(roleLabel('reviewer'), '审核员');
    assert.equal(roleLabel('ADMIN'), '管理员');
    assert.equal(roleLabel('unknown_role'), 'unknown_role', '未知角色原样显示，不猜');
    assert.equal(ROLE_LABEL_ZH.admin, '管理员');
    assert.equal(ROLE_LABEL_ZH.reviewer, '审核员');
  });

  it('列头、筛选、变更记录都不直接显示 admin / reviewer 代码', () => {
    const page = src('src/pages/settings/MembersPage.tsx');
    assert.doesNotMatch(page, /<th>admin<\/th>/);
    assert.doesNotMatch(page, /<th>reviewer<\/th>/);
    assert.doesNotMatch(page, /label: 'admin'/);
    assert.doesNotMatch(page, /label: 'reviewer'/);
    assert.match(page, /roleLabel\('admin'\)/);
    assert.match(page, /roleLabel\('reviewer'\)/);
    // 需要时在悬停提示里给出代码。
    assert.match(page, /角色代码：admin/);
    assert.match(page, /角色代码：reviewer/);
  });

  it('表格与卡片包含「部门」列并使用 formatMemberDepartment 渲染', () => {
    const page = src('src/pages/settings/MembersPage.tsx');
    assert.match(page, /<th>部门<\/th>/, '表格应包含「部门」列头');
    assert.equal(
      (page.match(/formatMemberDepartment\(member\.department\)/g) || []).length,
      2,
      '表格与卡片各一处渲染部门',
    );
  });

  it('开关与同一行的文字垂直居中：表格与卡片共用同一个行容器', () => {
    const page = src('src/pages/settings/MembersPage.tsx');
    assert.match(page, /className=\{s\.roleCell\}/);
    // 两个角色 × 两种布局（表格 / 窄屏卡片）都走同一个 RoleCell，不会各写一份对齐样式。
    assert.equal((page.match(/<RoleCell/g) || []).length, 4, '表格 + 卡片各两处');
    const css = src('src/pages/settings/membersAdmin.module.css');
    assert.match(css, /\.roleCell\s*\{[^}]*align-items:\s*center/);
  });

  it('表格的右对齐在「操作」列头与按钮上一致（.table th 的 text-align 不能盖住它）', () => {
    const css = src('src/pages/settings/adminPage.module.css');
    assert.match(css, /\.table\s+\.right\s*\{[^}]*text-align:\s*right/);
    const page = src('src/pages/settings/MembersPage.tsx');
    assert.match(page, /<th className=\{a\.right\}>操作<\/th>/);
  });

  it('页面说明与「最近登录」的空值口径一致', () => {
    const page = src('src/pages/settings/MembersPage.tsx');
    assert.doesNotMatch(page, /只包含至少登录过一次的成员/);
    assert.match(page, /还没有平台登录记录/);
    assert.match(page, /NO_LOGIN_RECORD_TOOLTIP/);
  });

  it('变更记录按时间倒序（服务端顺序之外界面再兜一次）', () => {
    const rows = [
      { event_id: 'a', created_at: '2026-09-30T10:00:00.000Z' },
      { event_id: 'b', created_at: '2026-10-01T10:00:00.000Z' },
      { event_id: 'c', created_at: '2026-09-30T10:00:00.000Z' },
    ];
    assert.deepEqual(sortRoleEventsDesc(rows).map((r) => r.event_id), ['b', 'c', 'a']);
    assert.deepEqual(sortRoleEventsDesc([]), []);
    const page = src('src/pages/settings/MembersPage.tsx');
    assert.match(page, /sortRoleEventsDesc\(/);
  });

  it('「最近登录」为空时的提示文案说明了数据来源', () => {
    assert.match(NO_LOGIN_RECORD_TOOLTIP, /登录记录/);
  });

  it('浅色主题下关闭态的开关清晰可辨（R6）', () => {
    const css = src('src/pages/settings/membersAdmin.module.css');
    // 关闭态：边界用次要文字色（浅色 #85857d vs 白卡片 ≈3.7:1，深色 ≈4.5:1），
    // 滑块用 secondary；原来的 rgba(0,0,0,0.08) 边界 + 纯白滑块在浅色下看不见。
    assert.match(css, /\.slider\s*\{[^}]*border:\s*1px solid var\(--color-text-muted\)/);
    assert.match(css, /\.slider::before\s*\{[^}]*background:\s*var\(--color-text-secondary\)/);
    // 只约束关闭态（行首的基础规则）；开启态在蓝底上用 #fff 是对的（review-ui-followups.test.ts）。
    assert.doesNotMatch(css, /^\.slider::before\s*\{[^}]*background:\s*#fff/m);
    assert.doesNotMatch(css, /\.slider\s*\{[^}]*border:\s*1px solid var\(--color-border\)/);
  });

  it('窄屏（≤900px）改用卡片式行：表格隐藏、操作入口不消失（R4）', () => {
    const page = src('src/pages/settings/MembersPage.tsx');
    assert.match(page, /s\.memberCards/, '要有卡片式行');
    assert.match(page, /s\.tableOnly/, '表格要能被窄屏隐藏');
    const cards = page.slice(page.indexOf('s.memberCards'));
    assert.match(cards, /变更记录/, '卡片里也要有变更记录入口');
    assert.match(cards, /role="admin"/);
    assert.match(cards, /role="reviewer"/);
    // 两个角色开关与操作入口在表格与卡片里共用同一批子组件，不各写一份。
    assert.match(page, /function RoleCell\(/);
    assert.match(page, /function MemberIdentity\(/);
    const css = src('src/pages/settings/membersAdmin.module.css');
    assert.match(css, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.tableOnly\s*\{[^}]*display:\s*none/);
    assert.match(css, /@media\s*\(max-width:\s*900px\)\s*\{[\s\S]*?\.memberCards\s*\{[^}]*display:\s*grid/);
    // 操作按钮不能被挤成竖排（那会把整行撑高）。
    assert.match(css, /\.memberCardActions\s+button|\.btn\b/);
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

  it('AdminMemberSchema 兼容 department（字符串、null 或缺失）', () => {
    const withDept = AdminMemberSchema.parse({ ...member(), department: '工程部' });
    assert.equal(withDept.department, '工程部');
    const withNull = AdminMemberSchema.parse({ ...member(), department: null });
    assert.equal(withNull.department, null);
    const withoutDept = AdminMemberSchema.parse({ ...member() });
    assert.equal(withoutDept.department, undefined);
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
