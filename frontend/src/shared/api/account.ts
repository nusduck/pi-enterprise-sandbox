/**
 * 本人账户资料（`/api/auth/profile`）。可改的字段由 Agent 决定（目前是显示名称、邮箱与
 * 四个邮件通知开关），其余字段只读；提交不可改的字段会得到 422 `PROFILE_FIELD_NOT_EDITABLE`。
 * 邮件通知是否可用由服务端在 `notifications.email` 里给出，前端不自行判断。
 * `login_method` / `identity_provider` 是只读来源字段：本地账号为 local / null，公司 SSO
 * 账号为 sso / issuer；缺字段时显示「—」而不是猜成账号密码。
 */
import { z } from 'zod';
import { parseApi } from '../schemas/api';
import { ApiError } from './client';

const ProfileSchema = z
  .object({
    username: z.string(),
    display_name: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    role: z.string().optional(),
    roles: z.array(z.string()).optional(),
    organization_id: z.string().optional(),
    organization_name: z.string().nullable().optional(),
    // 登录来源：local / null 或 sso / issuer（design sso-oidc-dev §4.2）。
    // 缺字段的旧服务端保持 undefined，不伪装成「账号密码」。
    login_method: z.string().optional().nullable(),
    identity_provider: z.string().optional().nullable(),
    status: z.string().optional(),
    created_at: z.string().nullable().optional(),
    last_login_at: z.string().nullable().optional(),
    editable_fields: z.array(z.string()).default([]),
    notify_run_complete: z.boolean().optional(),
    notify_review_result: z.boolean().optional(),
    notify_review_pending: z.boolean().optional(),
    notify_run_waiting: z.boolean().optional(),
    notifications: z
      .object({
        email: z
          .object({
            available: z.boolean(),
            min_run_duration_ms: z.number().nullable(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();
export type Profile = z.infer<typeof ProfileSchema>;

async function request(method: 'GET' | 'PATCH', body?: unknown): Promise<Profile> {
  const resp = await fetch('/api/auth/profile', {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await resp.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!resp.ok) {
    throw new ApiError(String(data.error || `Profile request failed: ${resp.status}`), {
      status: resp.status,
      code: typeof data.code === 'string' ? data.code : null,
    });
  }
  return parseApi(ProfileSchema, data, 'profile');
}

export function getProfile(): Promise<Profile> {
  return request('GET');
}

export function updateProfile(patch: {
  display_name?: string;
  email?: string | null;
  notify_run_complete?: boolean;
  notify_review_result?: boolean;
  notify_review_pending?: boolean;
  notify_run_waiting?: boolean;
}): Promise<Profile> {
  return request('PATCH', patch);
}
