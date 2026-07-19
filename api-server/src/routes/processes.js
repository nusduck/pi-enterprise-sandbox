/** BFF process history and control routes. Agent owns tenant identity mapping. */

import {
  cancelAgentProcess,
  getAgentProcess,
  getAgentProcessLogs,
  listAgentProcesses,
  readAgentProcess,
  signalAgentProcess,
  writeAgentProcessStdin,
} from '../services/agent-client.js';
import { resolveTrustedAuth } from '../application/run-access-service.js';
import { sendError, sendJson as json } from '../http/response.js';

async function context(req) {
  return {
    auth: await resolveTrustedAuth(req),
    traceId: req?.traceId || null,
  };
}

export async function handleListProcesses(parsedUrl, res, req = null) {
  try {
    const opts = await context(req);
    const result = await listAgentProcesses(
      {
        runId: parsedUrl.searchParams.get('run_id'),
        sessionId: parsedUrl.searchParams.get('session_id'),
        status: parsedUrl.searchParams.get('status'),
        limit: parsedUrl.searchParams.get('limit'),
      },
      opts,
    );
    json(res, 200, result);
  } catch (err) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleGetProcess(processId, res, req = null) {
  try {
    json(res, 200, await getAgentProcess(processId, await context(req)));
  } catch (err) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleGetProcessLogs(processId, parsedUrl, res, req = null) {
  try {
    json(
      res,
      200,
      await getAgentProcessLogs(
        processId,
        {
          offset: parsedUrl.searchParams.get('offset'),
          limit: parsedUrl.searchParams.get('limit'),
        },
        await context(req),
      ),
    );
  } catch (err) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleReadProcess(processId, parsedUrl, res, req = null) {
  try {
    json(
      res,
      200,
      await readAgentProcess(
        processId,
        {
          stream: parsedUrl.searchParams.get('stream'),
          cursor: parsedUrl.searchParams.get('cursor'),
          limit: parsedUrl.searchParams.get('limit'),
        },
        await context(req),
      ),
    );
  } catch (err) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleProcessAction(
  processId,
  action,
  body,
  res,
  req = null,
) {
  try {
    const opts = await context(req);
    let result;
    if (action === 'stdin') {
      result = await writeAgentProcessStdin(processId, body || {}, opts);
    } else if (action === 'signal' || action === 'kill') {
      result = await signalAgentProcess(
        processId,
        { signal: body?.signal || 'SIGTERM' },
        opts,
      );
    } else if (action === 'cancel') {
      result = await cancelAgentProcess(processId, opts);
    } else {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    json(res, 200, result);
  } catch (err) {
    sendError(res, err, req?.traceId);
  }
}
