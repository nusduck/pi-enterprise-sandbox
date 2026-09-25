/**
 * 管理端 Run 查询路由（`/internal/admin/runs*`）。只读；角色与 org 作用域由
 * `AdminRunQueryService` 判定，这里只做参数投影与错误映射。
 *
 *   GET /internal/admin/runs                 列表（status / agent_id / user_id / from / to / q / cursor / limit）
 *   GET /internal/admin/runs/stats           统计条（day_start = 调用方本地零点）
 *   GET /internal/admin/runs/:id             详情（含触发这次运行的用户输入）
 *   GET /internal/admin/runs/:id/events      持久事件（after_sequence / limit）
 *   GET /internal/admin/runs/:id/tools       工具台账
 *
 * 返回 `true` 表示请求归这里处理（无论成败）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { authSubjectsFromRequest, json, type AuthSubjects } from './request-response.js';
import { mapErrorToHttp } from './error-mapper.js';
import { presentToolExecutionResponse } from './run-presenters.js';

export interface AdminRunQueryServiceLike {
  list(auth: AuthSubjects, query: Record<string, string | null>): Promise<unknown>;
  stats(auth: AuthSubjects, query: { dayStart?: string | null }): Promise<unknown>;
  get(auth: AuthSubjects, runId: string): Promise<unknown>;
  events(auth: AuthSubjects, runId: string, opts: { afterSequence?: unknown; limit?: unknown }): Promise<unknown>;
  tools(auth: AuthSubjects, runId: string): Promise<{ tools: unknown[] }>;
}

export interface AdminRunRouteInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly parsedUrl: URL;
  readonly path: string;
  readonly adminRunQueryService?: AdminRunQueryServiceLike | null | undefined;
}

const PREFIX = '/internal/admin/runs';

export async function handleAdminRunRoute(input: AdminRunRouteInput): Promise<boolean> {
  const { req, res, parsedUrl, path, adminRunQueryService: service } = input;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  if (req.method !== 'GET') {
    json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  if (!service) {
    json(res, 503, { error: 'Admin run queries unavailable', code: 'DEPENDENCY' });
    return true;
  }
  const auth = authSubjectsFromRequest(req);
  if (!auth) {
    json(res, 400, { error: 'X-Acting-User-Id and X-Acting-Organization-Id are required', code: 'AUTH_CONTEXT_REQUIRED' });
    return true;
  }
  const qs = parsedUrl.searchParams;
  const param = (name: string) => qs.get(name);
  try {
    if (path === PREFIX) {
      json(res, 200, await service.list(auth, {
        status: param('status'),
        agentId: param('agent_id'),
        userId: param('user_id'),
        from: param('from'),
        to: param('to'),
        q: param('q'),
        cursor: param('cursor'),
        limit: param('limit'),
      }));
      return true;
    }
    if (path === `${PREFIX}/stats`) {
      json(res, 200, await service.stats(auth, { dayStart: param('day_start') }));
      return true;
    }
    const m = path.slice(PREFIX.length + 1).match(/^([^/]+)(?:\/(events|tools))?$/);
    if (!m) {
      json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      return true;
    }
    const runId = decodeURIComponent(m[1]);
    if (m[2] === 'events') {
      json(res, 200, await service.events(auth, runId, { afterSequence: param('after_sequence'), limit: param('limit') }));
    } else if (m[2] === 'tools') {
      const { tools } = await service.tools(auth, runId);
      json(res, 200, { tools: tools.map(presentToolExecutionResponse) });
    } else {
      json(res, 200, await service.get(auth, runId));
    }
    return true;
  } catch (error) {
    const mapped = mapErrorToHttp(error);
    json(res, mapped.status, mapped.body);
    return true;
  }
}
