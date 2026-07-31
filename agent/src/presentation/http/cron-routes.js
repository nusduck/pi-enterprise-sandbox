import {
  authSubjectsFromRequest,
  json,
  readBody,
} from './request-response.js';
import { mapErrorToHttp } from './error-mapper.js';

const AUTH_CONTEXT_ERROR = Object.freeze({
  error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
  code: 'AUTH_CONTEXT_REQUIRED',
});
const DEPENDENCY_ERROR = Object.freeze({
  error: 'Cron scheduler unavailable',
  code: 'DEPENDENCY',
});

async function parseJsonBody(req, res) {
  try {
    const raw = await readBody(req);
    return { ok: true, body: raw ? JSON.parse(raw) : {} };
  } catch {
    json(res, 400, { error: 'Invalid JSON body', code: 'VALIDATION' });
    return { ok: false, body: null };
  }
}

function requireCronContext(req, res, cronJobService) {
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

function respondWithMappedError(res, error) {
  const mapped = mapErrorToHttp(error);
  json(res, mapped.status, mapped.body);
}

/**
 * Handle the cron control-plane surface.
 * @returns {Promise<boolean>} true when the request matched a cron route.
 */
export async function handleCronRoute({
  req,
  res,
  parsedUrl,
  path,
  cronJobService,
}) {
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
          decodeURIComponent(runsMatch[1]),
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
          decodeURIComponent(manualMatch[1]),
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
  const cronJobId = decodeURIComponent(jobMatch[1]);
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
