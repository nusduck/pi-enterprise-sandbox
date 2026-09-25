/**
 * 本人账户资料（`/api/auth/profile`）。可改的字段由 Agent 决定（目前是显示名称与邮箱），
 * 其余字段只读；提交不可改的字段会得到 422 `PROFILE_FIELD_NOT_EDITABLE`。
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
    organization_id: z.string().optional(),
    organization_name: z.string().nullable().optional(),
    status: z.string().optional(),
    created_at: z.string().nullable().optional(),
    last_login_at: z.string().nullable().optional(),
    editable_fields: z.array(z.string()).default([]),
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

export function updateProfile(patch: { display_name?: string; email?: string | null }): Promise<Profile> {
  return request('PATCH', patch);
}
