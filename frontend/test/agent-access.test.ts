/**
 * 智能体可见范围编辑：草稿变化判定、提交内容、错误文案（design agent-visibility §6）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  accessDraftChanged,
  accessErrorMessage,
  accessPayload,
  addGrant,
  draftFromAccess,
  memberLabel,
  removeGrant,
} from '../src/pages/settings/agentAccessHelpers.ts';

const alice = { user_id: '01M3AAAAAAAAAAAAAAAAAAAAAA', username: 'E1001', display_name: '张三' };
const bob = { user_id: '01M3BBBBBBBBBBBBBBBBBBBBBB', username: 'E1002', display_name: null };

describe('agent access draft', () => {
  const saved = draftFromAccess({ agent_id: 'a', visibility: 'restricted', grants: [{ ...alice, granted_at: null }] });

  it('detects real changes and ignores reordering', () => {
    assert.equal(accessDraftChanged(saved, saved), false);
    const withBob = addGrant(saved, bob);
    assert.equal(accessDraftChanged(saved, withBob), true);
    assert.equal(accessDraftChanged(withBob, { ...withBob, grants: [...withBob.grants].reverse() }), false);
    assert.equal(accessDraftChanged(saved, removeGrant(saved, alice.user_id)), true);
    assert.equal(accessDraftChanged(saved, { ...saved, visibility: 'org' }), true);
  });

  it('does not add the same member twice', () => {
    assert.equal(addGrant(saved, alice).grants.length, 1);
  });

  it('sends no names for org visibility, and only ids for restricted', () => {
    assert.deepEqual(accessPayload({ visibility: 'org', grants: [alice] }), { visibility: 'org', user_ids: [] });
    assert.deepEqual(accessPayload(addGrant(saved, bob)), { visibility: 'restricted', user_ids: [alice.user_id, bob.user_id] });
  });

  it('labels members by employee number first', () => {
    assert.equal(memberLabel(alice), 'E1001 · 张三');
    assert.equal(memberLabel(bob), 'E1002');
    assert.equal(memberLabel({ user_id: '01M3CCCCCCCCCCCCCCCCCCCCCC', username: null, display_name: null }), '01M3CCCCCC');
  });

  it('explains server refusals in Chinese', () => {
    assert.match(accessErrorMessage({ status: 400, message: 'The default agent must stay visible to the whole organization' }), /默认智能体/);
    assert.match(accessErrorMessage({ status: 400, message: 'Not active members of this organization: x' }), /已停用/);
    assert.match(accessErrorMessage({ status: 403 }), /管理员/);
    assert.match(accessErrorMessage({ status: 404 }), /不存在/);
    assert.match(accessErrorMessage({ status: 503, message: 'down' }), /操作失败/);
  });
});
