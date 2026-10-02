/**
 * 平台角色管理的管理端客户端（`/api/admin/users*`，design `docs/design/rbac-roles.md` §5）。
 *
 * 角色判定、org 作用域、跨 org 404、`LAST_ADMIN` / `ROLE_PINNED_BY_DEPLOYMENT` 全在
 * 服务端（agent/），这里只做请求投影、zod 校验与**错误码保真**：页面要靠 `code`
 * 把 409 翻译成一句能行动的中文提示，退化成「操作失败」等于让管理员猜。
 *
 * 用 `parseApiStrict` 而不是 `parseApi`：契约漂移时必须抛错、由页面显示错误态，
 * 不能软失败成一个空列表——那正好是本设计 §6 明确禁止的「渲染成无成员」。
 */
import { z } from 'zod';
import { parseApiStrict } from '../schemas/api';
import { ApiError, authHeaders } from './client';

const nullableString = z.string().nullable().optional();

/** 一个组织成员 + 它在本 org 的角色（列表与 PUT/DELETE 返回同一形状）。 */
export const AdminMemberSchema = z
  .object({
    user_id: z.string(),
    username: nullableString,
    display_name: nullableString,
    email: nullableString,
    department: nullableString,
    roles: z.array(z.string()).default([]),
    /** 其中被部署环境变量锁定的角色；当前只有 `admin`。 */
    pinned_roles: z.array(z.string()).default([]),
    last_login_at: nullableString,
  })
  .passthrough();
export type AdminMember = z.infer<typeof AdminMemberSchema>;

const AdminMemberPageSchema = z.object({
  members: z.array(AdminMemberSchema).default([]),
  next_cursor: z.string().nullable().optional(),
});
export type AdminMemberPage = z.infer<typeof AdminMemberPageSchema>;

export const AdminMemberRoleEventSchema = z
  .object({
    event_id: z.string(),
    role: z.string(),
    action: z.string(),
    source: z.string(),
    actor_user_id: nullableString,
    actor_username: nullableString,
    actor_display_name: nullableString,
    created_at: nullableString,
  })
  .passthrough();
export type AdminMemberRoleEvent = z.infer<typeof AdminMemberRoleEventSchema>;

const AdminMemberRoleEventListSchema = z.object({
  events: z.array(AdminMemberRoleEventSchema).default([]),
});

/** 列表筛选；`role` 只接受服务端白名单值（未知值会得到 422 ROLE_UNKNOWN）。 */
export interface AdminMemberFilters {
  q?: string | null;
  role?: string | null;
  cursor?: string | null;
  limit?: number;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const resp = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await resp.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!resp.ok) {
    const body = (payload || {}) as { error?: unknown; code?: unknown };
    throw new ApiError(String(body.error || `请求失败（HTTP ${resp.status}）`), {
      status: resp.status,
      code: typeof body.code === 'string' ? body.code : null,
    });
  }
  return payload;
}

export async function listAdminMembers(f: AdminMemberFilters = {}): Promise<AdminMemberPage> {
  const q = new URLSearchParams();
  if (f.q) q.set('q', f.q);
  if (f.role) q.set('role', f.role);
  if (f.cursor) q.set('cursor', f.cursor);
  q.set('limit', String(f.limit ?? 50));
  return parseApiStrict(AdminMemberPageSchema, await request(`/users?${q}`), 'admin members');
}

/** 授予，幂等（已有该角色时服务端仍返回 200 与当前状态）。 */
export async function grantAdminMemberRole(userId: string, role: string): Promise<AdminMember> {
  return parseApiStrict(
    AdminMemberSchema,
    await request(`/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(role)}`, { method: 'PUT' }),
    'admin member role grant',
  );
}

/** 撤销，幂等（不存在该角色时服务端仍返回 200）。 */
export async function revokeAdminMemberRole(userId: string, role: string): Promise<AdminMember> {
  return parseApiStrict(
    AdminMemberSchema,
    await request(`/users/${encodeURIComponent(userId)}/roles/${encodeURIComponent(role)}`, { method: 'DELETE' }),
    'admin member role revoke',
  );
}

export async function listAdminMemberRoleEvents(
  userId: string,
  limit = 50,
): Promise<AdminMemberRoleEvent[]> {
  const body = await request(
    `/users/${encodeURIComponent(userId)}/role-events?limit=${encodeURIComponent(String(limit))}`,
  );
  return parseApiStrict(AdminMemberRoleEventListSchema, body, 'admin member role events').events;
}
