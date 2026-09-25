/**
 * 管理端 Run 查询的 BFF 路由（只读）：
 *
 *   GET /api/admin/runs              列表（status / agent_id / user_id / from / to / q / cursor / limit）
 *   GET /api/admin/runs/stats        统计条（day_start）
 *   GET /api/admin/runs/:id          详情
 *   GET /api/admin/runs/:id/events   全部持久事件（分页拉齐）
 *   GET /api/admin/runs/:id/tools    工具台账
 *
 * 身份由服务端解析后写入 `X-Acting-*`（含角色），角色与作用域由 agent/ 判定。
 */
import type { ServerResponse } from 'node:http';
import { resolveTrustedAuth, type ReqWithTrace } from '../application/run-access-service.js';
import { presentPersistedTimelineEvent } from '../application/conversation-timeline-service.js';
import {
  getAdminRun,
  getAdminRunStats,
  listAdminRuns,
  listAdminRunTools,
  listAllAdminRunEvents,
} from '../services/agent-admin-client.js';
import { sendError, sendJson as json } from '../http/response.js';

const PREFIX = '/api/admin/runs';

/** Returns true when the path belongs here (handled, whatever the outcome). */
export async function handleAdminRunsRoute(
  method: string,
  path: string,
  parsedUrl: URL,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<boolean> {
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  if (method !== 'GET') {
    json(res, 405, { error: 'Method not allowed', code: 'METHOD_NOT_ALLOWED' });
    return true;
  }
  try {
    const auth = await resolveTrustedAuth(req);
    const opts = { auth, traceId: req?.traceId ?? null };
    if (path === PREFIX) {
      json(res, 200, await listAdminRuns(parsedUrl.searchParams, opts));
      return true;
    }
    if (path === `${PREFIX}/stats`) {
      json(res, 200, await getAdminRunStats(parsedUrl.searchParams, opts));
      return true;
    }
    const m = path.slice(PREFIX.length + 1).match(/^([^/]+)(?:\/(events|tools))?$/);
    if (!m) {
      json(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
      return true;
    }
    const runId = decodeURIComponent(m[1] ?? '');
    if (m[2] === 'events') {
      const { events, truncated } = await listAllAdminRunEvents(runId, opts);
      json(res, 200, { events: events.map((e) => presentPersistedTimelineEvent(e, runId)), truncated });
    } else if (m[2] === 'tools') {
      json(res, 200, await listAdminRunTools(runId, opts));
    } else {
      json(res, 200, await getAdminRun(runId, opts));
    }
    return true;
  } catch (error) {
    sendError(res, error, req?.traceId);
    return true;
  }
}
