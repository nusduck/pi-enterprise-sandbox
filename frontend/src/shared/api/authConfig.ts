/**
 * 登录能力投影与认证失败的**展示判定**（纯函数，可单测）：
 *
 * - `GET /api/auth/config` 失败不能当成「没有登录方式」：这是服务故障，必须
 *   保留错误与重试入口，不能误导用户以为部署没开登录。
 * - `me` 的 401 与 503 语义不同：401 才是匿名身份（清本机身份），503/网络/解析
 *   失败是暂时不可用（保留草稿与本地身份，显示错误与重试）。
 * - 退出登录即使服务端撤销未确认，也要能区分「已退出但未确认」与普通失败。
 *
 * 只做判定，不发请求；HTTP 调用与 config 投影在 ./auth.ts 与
 * ../schemas/auth.ts。
 */
import type { ApiError } from './client';

export type AuthFailureKind = 'unauthenticated' | 'unavailable';

export type AuthFailure = {
  kind: AuthFailureKind;
  status: number | null;
  code: string | null;
  message: string;
};

const UNAVAILABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * 把一次 me/config 失败的 HTTP 形状归成两类。只有明确的 401（或上游给出的
 * INVALID_TOKEN）才算未认证；其余（含 5xx、网络错误、无法分类的 4xx 契约错误
 * 与解析失败）都当成暂时不可用，保留本机状态。
 */
export function classifyAuthFailure(error: unknown): AuthFailure {
  const api = error as Partial<ApiError> | null | undefined;
  const status = typeof api?.status === 'number' ? api.status : null;
  const code = typeof api?.code === 'string' ? api.code : null;
  // 上游没给出可用文案时留空，由 authFailureMessage 统一用稳定提示兜底。
  const message = typeof api?.message === 'string' ? api.message.trim() : '';
  if (status === 401 || code === 'INVALID_TOKEN') {
    return { kind: 'unauthenticated', status, code, message };
  }
  if (status !== null && !UNAVAILABLE_STATUSES.has(status) && status < 500) {
    // 4xx 契约错误（404/422/…）同样不能当成匿名：服务端没有给出可信的
    // 「未登录」结论，宁可显示错误并重试。
    return { kind: 'unavailable', status, code, message };
  }
  return { kind: 'unavailable', status, code, message };
}

/** 上游文案可读就用上游，否则用调用方给的稳定提示。 */
export function authFailureMessage(failure: AuthFailure, fallback: string): string {
  return failure.message || fallback;
}

export const AUTH_UNAVAILABLE_MESSAGE = '认证服务暂时不可用，请重试。';
export const AUTH_CONFIG_UNAVAILABLE_MESSAGE = '登录方式加载失败，请重试。';
/**
 * `me` 明确拒绝（401）时的提示：只做本机身份清理并引导重新登录。**不补发
 * best-effort logout**——那是一次延迟响应，可能在新登录写 Cookie 之后才落地，
 * 反而清掉新会话；真正撤销会话由用户的手动退出负责。
 */
export const ME_SESSION_REJECTED_MESSAGE = '登录已失效，请重新登录。';

// ── 退出登录的服务端撤销结果 ───────────────────────────────

export type LogoutRevocation = 'confirmed' | 'not_required' | 'unconfirmed';

export type LogoutOutcome = {
  /** 服务端是否确认撤销了当前会话。 */
  revocation: LogoutRevocation;
  code: string | null;
  /** 面向用户的可见提示；null 表示普通退出，无需额外警示。 */
  warning: string | null;
};

/**
 * P1b 契约（sso-reservation-tasks §锁定 DTO）：
 * - 200 `revocation:"confirmed"` / `"not_required"`：服务端已确认（或本来就
 *   无需）撤销。
 * - 409 `LEGACY_SESSION_NOT_REVOCABLE` / 503 `AUTH_REVOCATION_UNCONFIRMED` /
 *   网络失败：本机退出仍然完成，但服务端撤销未确认，必须如实提示。
 *
 * 未知的 200 响应体不猜成 confirmed（避免把未确认当成功）。
 */
export function interpretLogoutResult(result: unknown): LogoutOutcome {
  const body = (result || {}) as { revocation?: unknown; code?: unknown };
  const revocation = body.revocation;
  if (revocation === 'confirmed' || revocation === 'not_required') {
    return { revocation, code: null, warning: null };
  }
  return {
    revocation: 'unconfirmed',
    code: typeof body.code === 'string' ? body.code : null,
    warning: unconfirmedLogoutWarning(null),
  };
}

/** 退出失败（409/503/网络）时的可见提示：本机已清，撤销状态未确认。 */
export function unconfirmedLogoutWarning(code: string | null | undefined): string {
  if (code === 'LEGACY_SESSION_NOT_REVOCABLE') {
    return '已退出本机。旧登录凭据没有会话标识，服务端无法确认撤销，必要时请联系管理员。';
  }
  if (code === 'AUTH_REVOCATION_UNCONFIRMED') {
    return '已退出本机。服务端未确认撤销登录凭据，如仍能访问请稍后重试或联系管理员。';
  }
  return '已退出本机。服务端撤销未确认（网络或服务故障），如仍能访问请稍后重试或联系管理员。';
}
