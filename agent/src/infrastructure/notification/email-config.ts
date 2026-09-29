/**
 * 长任务完成邮件通知的部署配置（docs/design/run-completion-email.md T7）。
 *
 * fail-closed：没开、或开了但配置不全，都返回 `enabled: false` 与原因——不回退到
 * 默认地址、默认发件人，也不在缺口令时改成匿名发信。HTTP 进程用它回答「能力可用吗」，
 * worker 用它决定真发还是只结清 outbox，两边同一份判定。
 */

import { readFileSync } from 'node:fs';

export type EmailNotificationConfig =
  | {
      enabled: false;
      /** 给日志用；不含任何口令。 */
      reason: string;
    }
  | {
      enabled: true;
      smtp: {
        host: string;
        port: number;
        secure: boolean;
        auth: { user: string; pass: string } | null;
      };
      from: string;
      timeoutMs: number;
      minRunDurationMs: number;
      publicWebBaseUrl: string;
    };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MIN_RUN_DURATION_MS = 5 * 60_000;
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function truthy(value: unknown) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 未设置时用默认值；设置了但不是范围内整数就算配置错误。 */
function boundedInt(raw: unknown, fallback: number, min: number, max: number): number | null {
  const s = text(raw);
  if (!s) return fallback;
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export function resolveEmailNotificationConfig(
  env: Record<string, string | undefined>,
  deps: { readFile?: (path: string) => string } = {},
): EmailNotificationConfig {
  if (!truthy(env.NOTIFY_EMAIL_ENABLED)) {
    return { enabled: false, reason: 'NOTIFY_EMAIL_ENABLED is not set' };
  }
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  const host = text(env.SMTP_HOST);
  if (!host) return { enabled: false, reason: 'SMTP_HOST is required' };

  const secure = truthy(env.SMTP_SECURE);
  const port = boundedInt(env.SMTP_PORT, secure ? 465 : 587, 1, 65_535);
  if (port === null) return { enabled: false, reason: 'SMTP_PORT is invalid' };

  let auth: { user: string; pass: string } | null = null;
  const user = text(env.SMTP_USER);
  if (user) {
    const passwordFile = text(env.SMTP_PASSWORD_FILE);
    if (!passwordFile) {
      return { enabled: false, reason: 'SMTP_USER is set but SMTP_PASSWORD_FILE is missing' };
    }
    let pass: string;
    try {
      pass = readFile(passwordFile).replace(/\r?\n$/, '');
    } catch {
      return { enabled: false, reason: 'SMTP_PASSWORD_FILE is unreadable' };
    }
    if (!pass) return { enabled: false, reason: 'SMTP_PASSWORD_FILE is empty' };
    auth = { user, pass };
  }

  const from = text(env.NOTIFY_EMAIL_FROM);
  if (!from || !ADDRESS.test(from.replace(/^.*<([^>]+)>\s*$/, '$1'))) {
    return { enabled: false, reason: 'NOTIFY_EMAIL_FROM is missing or invalid' };
  }

  const timeoutMs = boundedInt(env.NOTIFY_EMAIL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 30_000);
  if (timeoutMs === null) return { enabled: false, reason: 'NOTIFY_EMAIL_TIMEOUT_MS is invalid' };

  const minRunDurationMs = boundedInt(
    env.NOTIFY_MIN_RUN_DURATION_MS,
    DEFAULT_MIN_RUN_DURATION_MS,
    0,
    7 * 24 * 3_600_000,
  );
  if (minRunDurationMs === null) {
    return { enabled: false, reason: 'NOTIFY_MIN_RUN_DURATION_MS is invalid' };
  }

  // 邮件里的链接必须指向真实前端；没有就不发，不猜 localhost。
  const base = text(env.PUBLIC_WEB_BASE_URL).replace(/\/+$/, '');
  let parsed: URL | null = null;
  try {
    parsed = base ? new URL(base) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
    return { enabled: false, reason: 'PUBLIC_WEB_BASE_URL is missing or invalid' };
  }

  return {
    enabled: true,
    smtp: { host, port, secure, auth },
    from,
    timeoutMs,
    minRunDurationMs,
    publicWebBaseUrl: base,
  };
}

/** 账户页展示用的能力摘要：只说可不可用与阈值，不外露主机与发件人。 */
export function emailNotificationCapability(config: EmailNotificationConfig) {
  return config.enabled
    ? { available: true, min_run_duration_ms: config.minRunDurationMs }
    : { available: false, min_run_duration_ms: null };
}
