/**
 * 平台角色管理的 Agent 内部面（`/internal/admin/members*`，design §5）。
 *
 *   GET    /internal/admin/members                      本 org 成员列表（q / role / cursor / limit）
 *   PUT    /internal/admin/members/:userId/roles/:role  授予（幂等）
 *   DELETE /internal/admin/members/:userId/roles/:role  撤销（幂等）
 *   GET    /internal/admin/members/:userId/role-events  角色变更记录（limit）
 *
 * 鉴权（必须持有 admin）、org 作用域、跨 org 404、最后 admin 与部署锁定都在
 * `MemberRoleService` 里判；这里只做参数投影与错误映射。返回 `true` 表示请求归
 * 这里处理（无论成败）。
 *
 * 路径沿用「成员」而不是「用户」：`userId` 是**本 org 的**成员，名单里只有已
 * provisioning 的账号（design §10）。BFF 对外暴露成 `/api/admin/users`（design §5）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireAuthSubjects, json, type AuthSubjects } from './request-response.js';
import { MemberRoleError } from '../../application/member-role-service.js';

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

export interface MemberRoleServiceLike {
  listMembers(
    actor: AuthSubjects,
    query: { q?: string | null; role?: string | null; cursor?: string | null; limit?: unknown },
  ): Promise<unknown>;
  grantRole(actor: AuthSubjects, userId: string, role: string): Promise<unknown>;
  revokeRole(actor: AuthSubjects, userId: string, role: string): Promise<unknown>;
  listRoleEvents(actor: AuthSubjects, userId: string, opts: { limit?: unknown }): Promise<unknown>;
}

export interface MemberRoleRouteInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly parsedUrl: URL;
  readonly path: string;
  readonly memberRoleService?: MemberRoleServiceLike | null | undefined;
}

const PREFIX = '/internal/admin/members';

/** `/…/members/:userId/roles/:role` 或 `/…/members/:userId/role-events`。 */
const MEMBER_PATH = /^([^/]+)(?:\/(roles|role-events)(?:\/([^/]+))?)?$/;

/** 服务抛出的 `MemberRoleError` 原样映射；其余错误按仓库惯例记日志后 500。 */
function statusForMemberRoleError(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof MemberRoleError) {
    return { status: error.status, body: { error: error.message, code: error.code } };
  }
  console.error('[agent-http] member role operation failed:', error);
  return { status: 500, body: { error: 'Internal server error', code: 'INTERNAL_ERROR' } };
}

export async function handleMemberRoleRoute(input: MemberRoleRouteInput): Promise<boolean> {
  const { req, res, parsedUrl, path, memberRoleService: service } = input;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  if (!service) {
    json(res, 503, { error: 'Member role management unavailable', code: 'DEPENDENCY' });
    return true;
  }
  const auth = requireAuthSubjects(req, res);
  if (!auth) return true;
  const qs = parsedUrl.searchParams;
  try {
    if (path === PREFIX) {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
        return true;
      }
      json(res, 200, await service.listMembers(auth, {
        q: qs.get('q'),
        role: qs.get('role'),
        cursor: qs.get('cursor'),
        limit: qs.get('limit'),
      }));
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
    // `match[3]` 缺席时不能 `decodeURIComponent(undefined)`：那会得到字符串
    // `"undefined"` 并被当成一个角色名传下去（一个静默的错误角色）。缺段就是 404。
    const tail = typeof match[3] === 'string' && match[3] !== '' ? match[3] : null;
    if (section === 'role-events') {
      if (req.method !== 'GET' || tail !== null) {
        json(res, tail !== null ? 404 : 405, {
          error: tail !== null ? 'Not found' : 'Method not allowed',
          code: tail !== null ? 'NOT_FOUND' : 'METHOD_NOT_ALLOWED',
        });
        return true;
      }
      json(res, 200, await service.listRoleEvents(auth, userId, { limit: qs.get('limit') }));
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
      if (req.method === 'PUT') {
        json(res, 200, await service.grantRole(auth, userId, role));
        return true;
      }
      if (req.method === 'DELETE') {
        json(res, 200, await service.revokeRole(auth, userId, role));
        return true;
      }
      json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
      return true;
    }
    json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
    return true;
  } catch (error) {
    const mapped = statusForMemberRoleError(error);
    json(res, mapped.status, mapped.body);
    return true;
  }
}
