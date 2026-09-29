/**
 * 账户页草稿 → PATCH 补丁。校验与服务端一致，服务端仍是语义权威：这里只为了
 * 在提交前给出字段级提示，服务端的 422 同样会落到对应字段上。
 */
import type { Profile } from '../../shared/api/account';

export type AccountDraft = { display_name: string; email: string; notify_run_complete: boolean };
export type AccountField = keyof AccountDraft;
export type AccountErrors = Partial<Record<AccountField, string>>;
export type ProfilePatch = { display_name?: string; email?: string | null; notify_run_complete?: boolean };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function draftFromProfile(p: Profile): AccountDraft {
  return {
    display_name: p.display_name || '',
    email: p.email || '',
    notify_run_complete: p.notify_run_complete === true,
  };
}

/** 服务端给出的邮件通知能力。缺字段（旧版服务端）按不可用处理，不猜。 */
export function emailNotification(p: Profile | null) {
  const cap = p?.notifications?.email;
  const available = cap?.available === true;
  const ms = available && typeof cap?.min_run_duration_ms === 'number' ? cap.min_run_duration_ms : null;
  return { available, threshold: ms === null ? null : formatThreshold(ms) };
}

/** 阈值文案：不足一分钟按秒写，否则按分钟（整分）。 */
export function formatThreshold(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} 秒`;
  return `${Math.round(ms / 60_000)} 分钟`;
}

export function isDirty(p: Profile | null, d: AccountDraft): boolean {
  if (!p) return false;
  const base = draftFromProfile(p);
  return d.display_name.trim() !== base.display_name
    || d.email.trim() !== base.email
    || d.notify_run_complete !== base.notify_run_complete;
}

export function buildProfilePatch(p: Profile, d: AccountDraft): { patch: ProfilePatch; errors: AccountErrors } {
  const errors: AccountErrors = {};
  const displayName = d.display_name.trim();
  const email = d.email.trim();
  if (!displayName) errors.display_name = '显示名称不能为空';
  else if (displayName.length > 255) errors.display_name = '最多 255 个字符';
  if (email && (email.length > 320 || !EMAIL.test(email))) errors.email = '邮箱格式不正确';

  const base = draftFromProfile(p);
  const turningOn = d.notify_run_complete && !base.notify_run_complete;
  if (turningOn && !emailNotification(p).available) errors.notify_run_complete = '部署未配置邮件发送，暂不可用';
  else if (d.notify_run_complete && !email) errors.notify_run_complete = '打开通知时必须保留邮箱';

  const patch: ProfilePatch = {};
  if (displayName !== base.display_name) patch.display_name = displayName;
  if (email !== base.email) patch.email = email || null;
  if (d.notify_run_complete !== base.notify_run_complete) patch.notify_run_complete = d.notify_run_complete;
  return { patch, errors };
}

/** 服务端拒绝码 → 出错的字段与提示；认不出的码返回 null，按表单级错误显示。 */
export function fieldErrorForProfileCode(code: string | null | undefined): AccountErrors | null {
  if (code === 'NOTIFY_EMAIL_REQUIRED') return { notify_run_complete: '打开通知时必须保留邮箱' };
  if (code === 'NOTIFICATION_UNAVAILABLE') return { notify_run_complete: '部署未配置邮件发送，暂不可用' };
  return null;
}
