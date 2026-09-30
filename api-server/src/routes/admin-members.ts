/**
 * 平台角色管理的 BFF 面（design `docs/design/rbac-roles.md` §5）：
 *
 *   GET    /api/admin/users?q=&role=&cursor=&limit=   本 org 成员列表（含角色与部署锁定）
 *   PUT    /api/admin/users/:userId/roles/:role        授予（幂等）
 *   DELETE /api/admin/users/:userId/roles/:role        撤销（幂等）
 *   GET    /api/admin/users/:userId/role-events        角色变更记录
 *
 * 身份由服务端解析后写入 `X-Acting-*`（含**角色集合**）：浏览器声明不了自己的角色。
 * 角色判定、org 作用域、跨 org 404、`LAST_ADMIN` / `ROLE_PINNED_BY_DEPLOYMENT` 全在
 * agent/，错误码原样透传——BFF 自己再判一次会让「谁说了算」变成两个地方，而它手里
 * 只有请求头里的角色，没有账本。
 *
 * 路径用 `users`（design §5 的对外命名），Agent 侧叫 `members`：同一个东西，
 * 对外是「平台的用户」，对内是「本 org 的成员」。
 */
import type { ServerResponse } from 'node:http';
import { resolveTrustedAuth, type ReqWithTrace } from '../application/run-access-service.js';
import {
  grantAdminMemberRole,
  listAdminMemberRoleEvents,
  listAdminMembers,
  revokeAdminMemberRole,
} from '../services/agent-member-role-client.js';
import { sendError, sendJson as json } from '../http/response.js';

const PREFIX = '/api/admin/users';

/** `/api/admin/users/:userId/roles/:role` 或 `/api/admin/users/:userId/role-events`。 */
const MEMBER_PATH = /^([^/]+)(?:\/(roles|role-events)(?:\/([^/]+))?)?$/;

/**
 * 解码一个路径段；非法百分号编码（如 `%E0`）返回 null，由调用方给 404。
 * `decodeURIComponent` 在这里抛 `URIError` 会落到兜底错误映射，变成 500。
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Returns true when the path belongs here (handled, whatever the outcome). */
export async function handleAdminMembersRoute(
  method: string,
  path: string,
  parsedUrl: URL,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<boolean> {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  try {
    const auth = await resolveTrustedAuth(req);
    const opts = { auth, traceId: req?.traceId ?? null };
    if (path === PREFIX) {
      if (method !== 'GET') {
        json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      json(res, 200, await listAdminMembers(parsedUrl.searchParams, opts));
      return true;
    }
    const match = MEMBER_PATH.exec(path.slice(PREFIX.length + 1));
    if (!match) {
      json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      return true;
    }
    const userId = decodeSegment(match[1] as string);
    if (userId === null) {
      json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      return true;
    }
    const section = match[2];
    // 缺 `:role` 段时不能 decode `undefined`——`decodeURIComponent(undefined)` 得到的是
    // 字符串 `"undefined"`，会被当成一个角色名转发给 Agent。
    const tail = typeof match[3] === 'string' && match[3] !== '' ? match[3] : null;
    if (section === 'role-events') {
      if (method !== 'GET' || tail !== null) {
        json(res, tail !== null ? 404 : 405, {
          error: tail !== null ? 'Not found' : 'Method not allowed',
          code: tail !== null ? 'NOT_FOUND' : 'METHOD_NOT_ALLOWED',
        });
        return true;
      }
      json(res, 200, await listAdminMemberRoleEvents(userId, parsedUrl.searchParams, opts));
      return true;
    }
    if (section === 'roles') {
      if (tail === null) {
        json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
        return true;
      }
      const role = decodeSegment(tail);
      if (role === null) {
        json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
        return true;
      }
      if (method === 'PUT') {
        json(res, 200, await grantAdminMemberRole(userId, role, opts));
        return true;
      }
      if (method === 'DELETE') {
        json(res, 200, await revokeAdminMemberRole(userId, role, opts));
        return true;
      }
      json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    return true;
  } catch (error) {
    sendError(res, error, req?.traceId);
    return true;
  }
}
