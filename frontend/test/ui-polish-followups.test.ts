/**
 * ui-polish 真浏览器验收后的三处修复：Popover 焦点规则、SSO 按钮文字、用户菜单角色标签。
 * Popover 的交互（Esc、焦点移入/归还）另由 Playwright 在运行栈上验证；这里守纯逻辑与接线。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { arrowFocusIndex, initialFocusIndex, type FocusCandidate } from '../src/shared/ui/popoverFocus.ts';
import { ssoButtonText } from '../src/pages/login/ssoButtonText.ts';
import { primaryRoleLabel } from '../src/shared/security/roles.ts';

const here = dirname(fileURLToPath(import.meta.url));
const readSrc = (...parts: string[]) => readFileSync(join(here, '..', 'src', ...parts), 'utf8');

const el = (tagName: string, attrs: Record<string, string> = {}): FocusCandidate => ({
  tagName,
  getAttribute: (name) => (name in attrs ? attrs[name] : null),
});

describe('popoverFocus.initialFocusIndex', () => {
  it('prefers the search field so the user can type immediately', () => {
    const items = [el('BUTTON', { 'aria-pressed': 'true' }), el('INPUT', { type: 'search' }), el('BUTTON')];
    assert.equal(initialFocusIndex(items), 1);
  });

  it('falls back to the selected item, then the first item', () => {
    assert.equal(initialFocusIndex([el('BUTTON'), el('BUTTON', { 'aria-pressed': 'true' })]), 1);
    assert.equal(initialFocusIndex([el('BUTTON'), el('BUTTON', { 'aria-selected': 'true' })]), 1);
    assert.equal(initialFocusIndex([el('BUTTON'), el('BUTTON', { 'aria-pressed': 'false' })]), 0);
  });

  it('ignores non-text inputs and returns -1 when nothing is focusable', () => {
    assert.equal(initialFocusIndex([el('INPUT', { type: 'checkbox' }), el('BUTTON', { 'aria-checked': 'true' })]), 1);
    assert.equal(initialFocusIndex([]), -1);
  });
});

describe('popoverFocus.arrowFocusIndex', () => {
  it('cycles with ArrowDown / ArrowUp, including from outside the list (-1)', () => {
    assert.equal(arrowFocusIndex('ArrowDown', 0, 3), 1);
    assert.equal(arrowFocusIndex('ArrowDown', 2, 3), 0);
    assert.equal(arrowFocusIndex('ArrowUp', 0, 3), 2);
    assert.equal(arrowFocusIndex('ArrowDown', -1, 3), 0);
  });

  it('supports Home / End and ignores other keys or empty lists', () => {
    assert.equal(arrowFocusIndex('Home', 2, 3), 0);
    assert.equal(arrowFocusIndex('End', 0, 3), 2);
    assert.equal(arrowFocusIndex('Enter', 0, 3), null);
    assert.equal(arrowFocusIndex('ArrowDown', -1, 0), null);
  });
});

describe('Popover wiring', () => {
  const src = readSrc('shared', 'ui', 'Popover.tsx');

  it('handles Escape on document (capture) so it works while focus is on the trigger', () => {
    assert.match(src, /document\.addEventListener\('keydown', handleKeyDown, true\)/);
    assert.doesNotMatch(src, /onKeyDown=\{handleKeyDown\}/);
  });

  it('moves focus into the popover on open and is not marked modal', () => {
    assert.match(src, /initialFocusIndex\(items\)/);
    assert.doesNotMatch(src, /aria-modal/);
  });

  it('does not pull focus back to the trigger after an outside click', () => {
    assert.match(src, /closedByOutsideRef\.current = true;/);
    assert.match(src, /if \(!closedByOutsideRef\.current\) triggerRef\.current\?\.focus\(\)/);
  });

  it('AgentPicker items expose the selected state used for initial focus', () => {
    assert.match(readSrc('widgets', 'composer', 'AgentPicker.tsx'), /aria-pressed=\{isSelected\}/);
  });
});

describe('ssoButtonText', () => {
  it('spaces Chinese from Latin edges exactly once', () => {
    assert.equal(ssoButtonText('公司 SSO'), '使用公司 SSO 登录');
    assert.equal(ssoButtonText('Okta'), '使用 Okta 登录');
    assert.equal(ssoButtonText('统一认证'), '使用统一认证登录');
    assert.equal(ssoButtonText('  公司 SSO  '), '使用公司 SSO 登录');
  });

  it('is what the login page renders', () => {
    assert.match(readSrc('pages', 'login', 'LoginPage.tsx'), /\{ssoButtonText\(caps\.ssoLabel\)\}/);
  });
});

describe('primaryRoleLabel', () => {
  it('shows the highest role', () => {
    assert.equal(primaryRoleLabel({ roles: ['admin', 'reviewer'] }), '管理员');
    assert.equal(primaryRoleLabel({ roles: ['reviewer'] }), '审核员');
    assert.equal(primaryRoleLabel({ roles: [] }), '普通用户');
    assert.equal(primaryRoleLabel(null), '普通用户');
  });

  it('is used by the sidebar user menu', () => {
    assert.match(readSrc('widgets', 'conversation-sidebar', 'ConversationSidebar.tsx'), /<small>\{primaryRoleLabel\(state\.authUser\)\}<\/small>/);
  });

  it('is used by SettingsDialog so reviewer shows 审核员 instead of 普通用户', () => {
    const src = readSrc('widgets', 'settings', 'SettingsDialog.tsx');
    assert.doesNotMatch(src, /isAdmin \? '管理员' : '普通用户'/);
    assert.match(src, /primaryRoleLabel\(profile \|\| fallback\)/);
    // When user has reviewer role, primaryRoleLabel returns 审核员
    assert.equal(primaryRoleLabel({ roles: ['reviewer'] }), '审核员');
    assert.equal(primaryRoleLabel({ roles: ['reviewer', 'user'] }), '审核员');
    assert.equal(primaryRoleLabel({ role: 'reviewer' }), '审核员');
  });
});
