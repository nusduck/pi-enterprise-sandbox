import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProfilePatch,
  draftFromProfile,
  emailNotification,
  fieldErrorForProfileCode,
  formatThreshold,
  isDirty,
} from '../src/widgets/settings/accountDraft.ts';

const available = { email: { available: true, min_run_duration_ms: 300_000 } };
const profile = (extra: Record<string, unknown> = {}) => ({
  username: 'dora',
  display_name: '多拉',
  email: 'dora@example.com',
  editable_fields: ['display_name', 'email', 'notify_run_complete'],
  notify_run_complete: false,
  notifications: available,
  ...extra,
});

describe('account draft', () => {
  it('reads the capability from the server and treats a missing block as unavailable', () => {
    assert.deepEqual(emailNotification(profile() as any), { available: true, threshold: '5 分钟' });
    assert.deepEqual(emailNotification(profile({ notifications: undefined }) as any), { available: false, threshold: null });
    assert.deepEqual(emailNotification(null), { available: false, threshold: null });
    // Sub-minute thresholds must not render as "0 分钟".
    assert.equal(formatThreshold(15_000), '15 秒');
    assert.equal(formatThreshold(90_000), '2 分钟');
  });

  it('sends only changed fields, including the notification switch', () => {
    const p = profile() as any;
    const d = { ...draftFromProfile(p), notify_run_complete: true };
    assert.equal(isDirty(p, d), true);
    assert.deepEqual(buildProfilePatch(p, d), { patch: { notify_run_complete: true }, errors: {} });
    assert.equal(isDirty(p, draftFromProfile(p)), false);
  });

  it('refuses to turn notification on without the capability or an address', () => {
    const off = profile({ notifications: { email: { available: false, min_run_duration_ms: null } } }) as any;
    assert.ok(buildProfilePatch(off, { ...draftFromProfile(off), notify_run_complete: true }).errors.notify_run_complete);

    const p = profile() as any;
    assert.ok(buildProfilePatch(p, { ...draftFromProfile(p), email: '', notify_run_complete: true }).errors.notify_run_complete);
  });

  it('allows turning an enabled switch off even after the capability went away, but not clearing the address alone', () => {
    const p = profile({ notify_run_complete: true, notifications: { email: { available: false, min_run_duration_ms: null } } }) as any;
    assert.deepEqual(buildProfilePatch(p, { ...draftFromProfile(p), notify_run_complete: false }), {
      patch: { notify_run_complete: false },
      errors: {},
    });
    assert.ok(buildProfilePatch(p, { ...draftFromProfile(p), email: '' }).errors.notify_run_complete);
    assert.deepEqual(
      buildProfilePatch(p, { ...draftFromProfile(p), email: '', notify_run_complete: false }).patch,
      { email: null, notify_run_complete: false },
    );
  });

  it('maps server refusals onto the switch', () => {
    assert.ok(fieldErrorForProfileCode('NOTIFY_EMAIL_REQUIRED')?.notify_run_complete);
    assert.ok(fieldErrorForProfileCode('NOTIFICATION_UNAVAILABLE')?.notify_run_complete);
    assert.equal(fieldErrorForProfileCode('AUTH_STORE_UNAVAILABLE'), null);
  });

  it('tracks the three new switches without touching old-server profiles', () => {
    const p = profile() as any;
    // 旧服务端缺字段 → 草稿全关，不产生多余补丁。
    assert.deepEqual(draftFromProfile(p), {
      display_name: '多拉',
      email: 'dora@example.com',
      notify_run_complete: false,
      notify_review_result: false,
      notify_review_pending: false,
      notify_run_waiting: false,
    });
    assert.equal(isDirty(p, draftFromProfile(p)), false);

    const full = profile({
      notify_review_result: true,
      notify_review_pending: false,
      notify_run_waiting: true,
    }) as any;
    const d = { ...draftFromProfile(full), notify_review_pending: true, notify_run_waiting: false };
    assert.equal(isDirty(full, d), true);
    assert.deepEqual(buildProfilePatch(full, d), {
      patch: { notify_review_pending: true, notify_run_waiting: false },
      errors: {},
    });
  });

  it('requires the capability and an address for any new switch', () => {
    const off = profile({ notifications: { email: { available: false, min_run_duration_ms: null } } }) as any;
    const errors = buildProfilePatch(off, { ...draftFromProfile(off), notify_review_pending: true }).errors;
    assert.equal(errors.notify_review_pending, '部署未配置邮件发送，暂不可用');

    const p = profile() as any;
    const noMail = buildProfilePatch(p, { ...draftFromProfile(p), email: '', notify_run_waiting: true }).errors;
    assert.equal(noMail.notify_run_waiting, '打开通知时必须保留邮箱');

    // 三个默认开关开着时清空邮箱不报错；只有运行完成开关开着才报错。
    const on = profile({ notify_review_result: true }) as any;
    assert.deepEqual(buildProfilePatch(on, { ...draftFromProfile(on), email: '' }).errors, {});
    const runComplete = profile({ notify_run_complete: true }) as any;
    const clearedRun = buildProfilePatch(runComplete, { ...draftFromProfile(runComplete), email: '' }).errors;
    assert.ok(clearedRun.notify_run_complete);
    assert.equal(clearedRun.notify_review_result, undefined);
  });

  it('maps field-level AUTH_INPUT_INVALID onto the named switch', () => {
    assert.ok(fieldErrorForProfileCode('AUTH_INPUT_INVALID', 'notify_review_result must be a boolean')?.notify_review_result);
    assert.ok(fieldErrorForProfileCode('AUTH_INPUT_INVALID', 'notify_run_waiting must be a boolean')?.notify_run_waiting);
    assert.equal(fieldErrorForProfileCode('AUTH_INPUT_INVALID', 'email is not a valid address'), null);
    assert.equal(fieldErrorForProfileCode('VALIDATION_ERROR', 'notify_review_result must be a boolean'), null);
  });
});
