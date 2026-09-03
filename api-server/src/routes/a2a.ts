import type { ServerResponse } from 'node:http';
import { resolveTrustedAuth, type ReqWithTrace, type TrustedAuthContext } from '../application/run-access-service.js';
import { HttpError } from '../http/errors.js';
import { sendError, sendJson } from '../http/response.js';
import {
  getAgentA2aConfig,
  issueAgentA2aCredential,
  rotateAgentA2aCredential,
  revokeAgentA2aCredential,
} from '../services/agent-client.js';

async function resolveAdmin(req: ReqWithTrace | null | undefined): Promise<TrustedAuthContext> {
  const auth = await resolveTrustedAuth(req);
  if (String(auth.actingRole || '').toLowerCase() !== 'admin') {
    throw new HttpError(403, 'ADMIN_REQUIRED', 'Administrator role is required');
  }
  return auth;
}

export async function handleGetA2aConfig(parsedUrl: URL, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveAdmin(req);
    const agentId = parsedUrl.searchParams.get('agent_id');
    sendJson(
      res,
      200,
      await getAgentA2aConfig(agentId, { auth, traceId }),
    );
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleIssueA2aCredential(body: any, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveAdmin(req);
    sendJson(
      res,
      201,
      await issueAgentA2aCredential(body, { auth, traceId }),
    );
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleRotateA2aCredential(id: string, body: any, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveAdmin(req);
    sendJson(
      res,
      200,
      await rotateAgentA2aCredential(id, body, { auth, traceId }),
    );
  } catch (error) {
    sendError(res, error, traceId);
  }
}

export async function handleRevokeA2aCredential(id: string, res: ServerResponse, req: ReqWithTrace | null = null): Promise<void> {
  const traceId = req?.traceId || null;
  try {
    const auth = await resolveAdmin(req);
    sendJson(
      res,
      200,
      await revokeAgentA2aCredential(id, { auth, traceId }),
    );
  } catch (error) {
    sendError(res, error, traceId);
  }
}

