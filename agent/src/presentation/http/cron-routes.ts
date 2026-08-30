/**
 * cron 控制面的路由。阶段 C 的 TS 转换。
 *
 * 返回 `true` 表示"这个请求归我处理了"（无论成败），`false` 表示"不是我的路由"
 * ——调用方据此继续往下匹配。把这条约定写进类型（`Promise<boolean>`）比写在
 * 注释里可靠。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authSubjectsFromRequest,
  json,
  readBody,
  type AuthSubjects,
} from './request-response.js';
import { mapErrorToHttp } from './error-mapper.js';

/**
 * cron 服务的最小契约。用结构类型而不是 import 具体实现：这一层只该知道
 * "能调什么"，不该知道它由谁实现。
 */
export interface CronJobServiceLike {
  list(auth: AuthSubjects, opts: { limit?: number | undefined }): Promise<unknown>;
  create(auth: AuthSubjects, body: unknown): Promise<unknown>;
  listRuns(
    cronJobId: string,
    auth: AuthSubjects,
    opts: { limit?: number | undefined },
  ): Promise<unknown>;
  runManual(cronJobId: string, auth: AuthSubjects): Promise<unknown>;
  get(cronJobId: string, auth: AuthSubjects): Promise<unknown>;
  update(cronJobId: string, auth: AuthSubjects, body: unknown): Promise<unknown>;
  delete(cronJobId: string, auth: AuthSubjects): Promise<unknown>;
}

export interface CronRouteInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly parsedUrl: URL;
  readonly path: string;
  readonly cronJobService?: CronJobServiceLike | null | undefined;
}

const AUTH_CONTEXT_ERROR = Object.freeze({
  error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
  code: 'AUTH_CONTEXT_REQUIRED',
});
const DEPENDENCY_ERROR = Object.freeze({
  error: 'Cron scheduler unavailable',
  code: 'DEPENDENCY',
});

async function parseJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: boolean; body: unknown }> {
  try {
    const raw = await readBody(req);
    return { ok: true, body: raw ? JSON.parse(raw) : {} };
  } catch {
    json(res, 400, { error: 'Invalid JSON body', code: 'VALIDATION' });
    return { ok: false, body: null };
  }
}

function requireCronContext(
  req: IncomingMessage,
  res: ServerResponse,
  cronJobService: CronJobServiceLike | null | undefined,
): AuthSubjects | null {
  if (!cronJobService) {
    json(res, 503, DEPENDENCY_ERROR);
    return null;
  }
  const auth = authSubjectsFromRequest(req);
  if (!auth) {
    json(res, 400, AUTH_CONTEXT_ERROR);
    return null;
  }
  return auth;
}

function respondWithMappedError(res: ServerResponse, error: unknown): void {
  const mapped = mapErrorToHttp(error);
  json(res, mapped.status, mapped.body);
}

/** 处理 cron 控制面。返回 true 表示这个请求已由本模块处理。 */
export async function handleCronRoute({
  req,
  res,
  parsedUrl,
  path,
  cronJobService,
}: CronRouteInput): Promise<boolean> {
  if (path === '/internal/cron-jobs') {
    const auth = requireCronContext(req, res, cronJobService);
    if (!auth) return true;
    try {
      if (req.method === 'GET') {
        const limit = Number(parsedUrl.searchParams.get('limit')) || undefined;
        json(res, 200, {
          cron_jobs: await cronJobService.list(auth, { limit }),
        });
        return true;
      }
      if (req.method === 'POST') {
        const parsed = await parseJsonBody(req, res);
        if (!parsed.ok) return true;
        json(res, 201, await cronJobService.create(auth, parsed.body));
        return true;
      }
      return false;
    } catch (error) {
      respondWithMappedError(res, error);
      return true;
    }
  }

  const runsMatch = path.match(/^\/internal\/cron-jobs\/([^/]+)\/runs$/);
  if (runsMatch && req.method === 'GET') {
    const auth = requireCronContext(req, res, cronJobService);
    if (!auth) return true;
    try {
      const limit = Number(parsedUrl.searchParams.get('limit')) || undefined;
      json(res, 200, {
        cron_job_runs: await cronJobService.listRuns(
          decodeURIComponent(runsMatch[1] as string),
          auth,
          { limit },
        ),
      });
    } catch (error) {
      respondWithMappedError(res, error);
    }
    return true;
  }

  const manualMatch = path.match(/^\/internal\/cron-jobs\/([^/]+)\/run$/);
  if (manualMatch && req.method === 'POST') {
    const auth = requireCronContext(req, res, cronJobService);
    if (!auth) return true;
    try {
      json(
        res,
        202,
        await cronJobService.runManual(
          decodeURIComponent(manualMatch[1] as string),
          auth,
        ),
      );
    } catch (error) {
      respondWithMappedError(res, error);
    }
    return true;
  }

  const jobMatch = path.match(/^\/internal\/cron-jobs\/([^/]+)$/);
  if (!jobMatch || !['GET', 'PATCH', 'DELETE'].includes(req.method || '')) {
    return false;
  }
  const auth = requireCronContext(req, res, cronJobService);
  if (!auth) return true;
  const cronJobId = decodeURIComponent(jobMatch[1] as string);
  try {
    if (req.method === 'GET') {
      json(res, 200, await cronJobService.get(cronJobId, auth));
    } else if (req.method === 'PATCH') {
      const parsed = await parseJsonBody(req, res);
      if (!parsed.ok) return true;
      json(res, 200, await cronJobService.update(cronJobId, auth, parsed.body));
    } else {
      await cronJobService.delete(cronJobId, auth);
      res.writeHead(204);
      res.end();
    }
  } catch (error) {
    respondWithMappedError(res, error);
  }
  return true;
}
