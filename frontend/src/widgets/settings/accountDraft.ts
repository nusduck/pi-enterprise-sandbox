/**
 * 账户页草稿 → PATCH 补丁。校验与服务端一致，服务端仍是语义权威：这里只为了
 * 在提交前给出字段级提示，服务端的 422 同样会落到对应字段上。
 */
import type { Profile } from '../../shared/api/account';

export type AccountDraft = {
  display_name: string;
  email: string;
  notify_run_complete: boolean;
  notify_review_result: boolean;
  notify_review_pending: boolean;
  notify_run_waiting: boolean;
};
export type AccountField = keyof AccountDraft;
export type AccountErrors = Partial<Record<AccountField, string>>;
export type ProfilePatch = {
  display_name?: string;
  email?: string | null;
  notify_run_complete?: boolean;
  notify_review_result?: boolean;
  notify_review_pending?: boolean;
  notify_run_waiting?: boolean;
};

/** 四个邮件通知开关（与服务端字段名一致，服务端拒绝消息里带的就是它们）。 */
export const NOTIFY_SWITCH_FIELDS = [
  'notify_run_complete',
  'notify_review_result',
  'notify_review_pending',
  'notify_run_waiting',
] as const;

export type NotifySwitchField = (typeof NOTIFY_SWITCH_FIELDS)[number];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function draftFromProfile(p: Profile): AccountDraft {
  return {
    display_name: p.display_name || '',
    email: p.email || '',
    notify_run_complete: p.notify_run_complete === true,
    // 缺字段的旧服务端按关处理：不猜默认值，提交时也不会产生多余补丁。
    notify_review_result: p.notify_review_result === true,
    notify_review_pending: p.notify_review_pending === true,
    notify_run_waiting: p.notify_run_waiting === true,
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
    || NOTIFY_SWITCH_FIELDS.some((field) => d[field] !== base[field]);
}

export function buildProfilePatch(p: Profile, d: AccountDraft): { patch: ProfilePatch; errors: AccountErrors } {
  const errors: AccountErrors = {};
  const displayName = d.display_name.trim();
  const email = d.email.trim();
  if (!displayName) errors.display_name = '显示名称不能为空';
  else if (displayName.length > 255) errors.display_name = '最多 255 个字符';
  if (email && (email.length > 320 || !EMAIL.test(email))) errors.email = '邮箱格式不正确';

  const base = draftFromProfile(p);
  const available = emailNotification(p).available;
  for (const field of NOTIFY_SWITCH_FIELDS) {
    const turningOn = d[field] && !base[field];
    if (turningOn && !available) errors[field] = '部署未配置邮件发送，暂不可用';
    else if (turningOn && !email) errors[field] = '打开通知时必须保留邮箱';
    // 清空邮箱只被「运行完成」开关拦住：其余三个开关默认开，没有邮箱时照常
    // 保存（投递时记 skipped）。打开任一开关仍需邮箱（上一分支）。
    else if (field === 'notify_run_complete' && d[field] && !email) errors[field] = '打开通知时必须保留邮箱';
  }

  const patch: ProfilePatch = {};
  if (displayName !== base.display_name) patch.display_name = displayName;
  if (email !== base.email) patch.email = email || null;
  for (const field of NOTIFY_SWITCH_FIELDS) {
    if (d[field] !== base[field]) patch[field] = d[field];
  }
  return { patch, errors };
}

/** 服务端拒绝码 → 出错的字段与提示；认不出的码返回 null，按表单级错误显示。 */
export function fieldErrorForProfileCode(code: string | null | undefined, message?: string | null): AccountErrors | null {
  if (code === 'NOTIFY_EMAIL_REQUIRED' || code === 'NOTIFICATION_UNAVAILABLE') {
    // 服务端不说是哪个开关：四个开关共用一组校验，提示落在所有开关上。
    const text = code === 'NOTIFY_EMAIL_REQUIRED' ? '打开通知时必须保留邮箱' : '部署未配置邮件发送，暂不可用';
    return {
      notify_run_complete: text,
      notify_review_result: text,
      notify_review_pending: text,
      notify_run_waiting: text,
    };
  }
  if (code === 'AUTH_INPUT_INVALID' && typeof message === 'string') {
    // 开关的类型错误是字段级的：消息里带字段名（`<field> must be a boolean`）。
    for (const field of NOTIFY_SWITCH_FIELDS) {
      if (message.includes(field)) return { [field]: '开关值无效' } as AccountErrors;
    }
  }
  return null;
}
