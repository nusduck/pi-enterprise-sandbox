/** BFF process routes: Agent authorizes the session; exec owns process facts. */

import type { ServerResponse } from 'node:http';
import {
  authorizeSandboxSession,
  requireSessionWorkspaceId,
  type ReqWithTrace,
} from '../application/run-access-service.js';
import { createSandboxClient, type SandboxClient } from '../services/sandbox-client.js';
import { HttpError } from '../http/errors.js';
import { sendError, sendJson as json } from '../http/response.js';

function requiredSessionId(value: unknown): string {
  const sessionId = String(value || '').trim();
  if (!sessionId) throw new HttpError(400, 'SESSION_REQUIRED', 'session_id required');
  return sessionId;
}

async function clientFor(sessionId: string, req: ReqWithTrace | null | undefined): Promise<{ workspaceId: string; client: SandboxClient }> {
  const access = await authorizeSandboxSession(sessionId, req, {
    traceId: req?.traceId || null,
  });
  const workspaceId = requireSessionWorkspaceId(access);
  return {
    workspaceId,
    client: createSandboxClient({
      traceId: req?.traceId || null,
      traceContext: req?.traceContext || null,
      auth: access.sandboxAuth,
    }),
  };
}

export async function handleListProcesses(parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const sessionId = requiredSessionId(parsedUrl.searchParams.get('session_id'));
    const { client, workspaceId } = await clientFor(sessionId, req);
    const result = await client.listProcesses(workspaceId, {
      runId: parsedUrl.searchParams.get('run_id'),
      status: parsedUrl.searchParams.get('status'),
      limit: parsedUrl.searchParams.get('limit'),
    });
    json(res, 200, {
      ...result,
      processes: Array.isArray(result?.processes)
        ? result.processes.map((entry: any) => ({ ...entry, session_id: sessionId }))
        : [],
    });
  } catch (err: any) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleGetProcess(processId: string, parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const sessionId = requiredSessionId(parsedUrl.searchParams.get('session_id'));
    const { client, workspaceId } = await clientFor(sessionId, req);
    const result = await client.getProcess(workspaceId, processId);
    json(res, 200, { ...result, session_id: sessionId });
  } catch (err: any) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleGetProcessLogs(processId: string, parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const sessionId = requiredSessionId(parsedUrl.searchParams.get('session_id'));
    const { client, workspaceId } = await clientFor(sessionId, req);
    json(res, 200, await client.getProcessLogs(workspaceId, processId, {
      offset: parsedUrl.searchParams.get('offset'),
      limit: parsedUrl.searchParams.get('limit'),
    }));
  } catch (err: any) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleReadProcess(processId: string, parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  try {
    const sessionId = requiredSessionId(parsedUrl.searchParams.get('session_id'));
    const { client, workspaceId } = await clientFor(sessionId, req);
    json(res, 200, await client.readProcess(workspaceId, processId, {
      stream: parsedUrl.searchParams.get('stream'),
      cursor: parsedUrl.searchParams.get('cursor'),
      limit: parsedUrl.searchParams.get('limit'),
    }));
  } catch (err: any) {
    sendError(res, err, req?.traceId);
  }
}

export async function handleProcessAction(
  processId: string,
  action: string,
  body: any,
  res: ServerResponse,
  req: ReqWithTrace | null = null,
): Promise<void> {
  try {
    const sessionId = requiredSessionId(body?.session_id);
    const { client, workspaceId } = await clientFor(sessionId, req);
    let result: any;
    if (action === 'stdin') {
      result = await client.processAction(workspaceId, processId, 'stdin', {
        data: body?.data || '',
        eof: Boolean(body?.eof),
      });
    } else if (action === 'signal' || action === 'kill') {
      result = await client.processAction(workspaceId, processId, 'signal', {
        signal: body?.signal || 'SIGTERM',
      });
    } else if (action === 'cancel') {
      result = await client.processAction(workspaceId, processId, 'cancel');
    } else {
      json(res, 405, { error: 'Method not allowed' });
      return;
    }
    json(res, 200, result);
  } catch (err: any) {
    sendError(res, err, req?.traceId);
  }
}

