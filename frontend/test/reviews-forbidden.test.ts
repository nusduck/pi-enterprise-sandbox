import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { hasAdminRole, hasReviewerRole } from '../src/shared/security/roles.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (...parts: string[]) => readFileSync(join(here, '..', 'src', ...parts), 'utf8');

describe('交付物审核权限与 forbidden 空状态（§2.6）', () => {
  it('hasReviewerRole 正确判定审核员角色，fail-closed', () => {
    assert.equal(hasReviewerRole({ roles: ['reviewer'] }), true);
    assert.equal(hasReviewerRole({ roles: ['admin', 'reviewer'] }), true);
    assert.equal(hasReviewerRole({ role: 'reviewer' }), true);
    assert.equal(hasReviewerRole({ roles: ['admin'] }), false);
    assert.equal(hasReviewerRole({ role: 'user' }), false);
    assert.equal(hasReviewerRole(null), false);
    assert.equal(hasReviewerRole(undefined), false);
  });

  it('ReviewsPage 在非 reviewer 时不请求审核队列，直接显示 EmptyState forbidden', () => {
    const tsx = readSrc('pages', 'reviews', 'ReviewsPage.tsx');

    // 1. 判定 reviewer 角色与 admin 角色
    assert.match(tsx, /hasReviewerRole\(state\.authUser\)/);
    assert.match(tsx, /hasAdminRole\(state\.authUser\)/);

    // 2. 只有持有 reviewer 角色才触发 load 请求队列
    assert.match(tsx, /if\s*\(\s*isReviewer\s*\)\s*\{\s*void\s+load\(\s*\{\s*cursor:\s*null\s*\}\s*\);\s*\}/);

    // 3. 非 reviewer 时渲染 EmptyState forbidden
    assert.match(tsx, /if\s*\(\s*!isReviewer\s*\)\s*\{/);
    assert.match(tsx, /<EmptyState\s+variant="forbidden"/);
    assert.match(tsx, /title="需要审核员权限"/);
    assert.match(tsx, /只有持有 reviewer 角色的成员可以查看和处理交付物审核队列。/);

    // 4. 管理员时提供前往成员与角色页面的跳转链接
    assert.match(tsx, /action=\{isAdmin\s*\?\s*\{\s*label:\s*'前往成员与角色分配',\s*to:\s*'\/admin\/members'\s*\}\s*:\s*undefined\}/);
  });
});
