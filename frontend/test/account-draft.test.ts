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
});
