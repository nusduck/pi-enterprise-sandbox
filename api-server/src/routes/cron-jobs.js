/** Cron job BFF routes: auth/trace boundary only; Agent owns all facts. */

import {
  createAgentCronJob,
  deleteAgentCronJob,
  getAgentCronJob,
  listAgentCronJobRuns,
  listAgentCronJobs,
  runAgentCronJob,
  updateAgentCronJob,
} from '../services/agent-client.js';
import { resolveTrustedAuth } from '../application/run-access-service.js';
import { sendError, sendJson as json } from '../http/response.js';

export async function handleListCronJobs(parsedUrl, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    const limit = parsedUrl.searchParams.get('limit') || undefined;
    const result = await listAgentCronJobs({ limit }, { auth, traceId: req?.traceId });
    json(res, 200, result);
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

export async function handleCreateCronJob(body, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    const result = await createAgentCronJob(body, { auth, traceId: req?.traceId });
    json(res, 201, result);
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

export async function handleGetCronJob(cronJobId, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    json(res, 200, await getAgentCronJob(cronJobId, { auth, traceId: req?.traceId }));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

export async function handleUpdateCronJob(cronJobId, body, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    json(res, 200, await updateAgentCronJob(cronJobId, body, { auth, traceId: req?.traceId }));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

export async function handleDeleteCronJob(cronJobId, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    await deleteAgentCronJob(cronJobId, { auth, traceId: req?.traceId });
    res.writeHead(204);
    res.end();
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

export async function handleRunCronJob(cronJobId, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    json(res, 202, await runAgentCronJob(cronJobId, { auth, traceId: req?.traceId }));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}

export async function handleListCronJobRuns(cronJobId, parsedUrl, res, req) {
  try {
    const auth = await resolveTrustedAuth(req);
    const limit = parsedUrl.searchParams.get('limit') || undefined;
    json(res, 200, await listAgentCronJobRuns(
      cronJobId, { limit }, { auth, traceId: req?.traceId },
    ));
  } catch (error) {
    sendError(res, error, req?.traceId);
  }
}
