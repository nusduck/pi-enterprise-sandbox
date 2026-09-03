/** Resolve and authorize trusted browser identity for Run operations (PR-04 T4). */

import type { IncomingMessage } from 'node:http';
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';
import { authFromRequest } from '../services/sandbox-client.js';
import { authMe } from '../services/agent-auth-client.js';
import {
  getAgentRun,
  resolveAgentSandboxSession,
} from '../services/agent-client.js';
import { bindRequestTraceContext, type RequestTraceContext } from './trace-context.js';

export const DURABLE_RUN_READ_RETRY_DELAYS_MS: readonly number[] = Object.freeze([5, 15]);

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface TrustedAuthContext {
  authorization?: string | null;
  actingUserId: string;
  actingOrganizationId: string;
  actingRole: string;
  requestId?: string | null;
  callerType?: string;
  [key: string]: unknown;
}

export interface AuthorizeSandboxSessionResult {
  auth: TrustedAuthContext;
  access: any;
  sandboxAuth: {
    actingUserId: string;
    actingOrganizationId: string;
    actingRole: string;
  };
}

export type ReqWithTrace = IncomingMessage & {
  requestId?: string | null;
  traceId?: string | null;
  traceContext?: RequestTraceContext | null;
  traceparent?: string | null;
  tracestate?: string | null;
};


/**
 * Read the durable run from **Agent MySQL** (owner-scoped).
 * Sandbox agent_runs is no longer the status/ownership fact source.
 */
export async function getDurableRun(
  authOrClient: any,
  runId: string,
  traceId: string | null = null,
): Promise<any> {
  const load =
    authOrClient && typeof authOrClient.getAgentRun === 'function'
      ? () => authOrClient.getAgentRun(runId)
      : () => getAgentRun(runId, { auth: authOrClient, traceId });

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (err: any) {
      if (err?.status !== 404 || attempt >= DURABLE_RUN_READ_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await wait(DURABLE_RUN_READ_RETRY_DELAYS_MS[attempt]!);
    }
  }
}

export async function resolveTrustedAuth(req: ReqWithTrace | null | undefined): Promise<TrustedAuthContext> {
  const forwarded = authFromRequest(req);
  if (!config.AUTH_ENABLED) {
    return bindRequestTraceContext({
      ...forwarded,
      ...config.DEVELOPMENT_ACTING_IDENTITY,
      requestId: req?.requestId || null,
      callerType: 'web',
    }, req?.traceContext);
  }
  if (!forwarded.authorization) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  const user = await authMe(forwarded, {
    traceId: req?.traceId || null,
    traceContext: req?.traceContext || null,
  });
  const userId = user?.id != null ? String(user.id) : '';
  const organizationId =
    user?.organization_id != null ? String(user.organization_id) : '';
  if (!userId || !organizationId) {
    throw new HttpError(
      401,
      'AUTH_CONTEXT_INCOMPLETE',
      'Authenticated user context is incomplete',
    );
  }
  return bindRequestTraceContext({
    ...forwarded,
    actingUserId: userId,
    actingOrganizationId: organizationId,
    actingRole: String(user.role || 'user'),
    requestId: req?.requestId || null,
    callerType: 'web',
  }, req?.traceContext);
}

/**
 * Resolve a formal Sandbox session through Agent's owner mapping.
 */
export async function authorizeSandboxSession(
  sessionId: string,
  req: ReqWithTrace | null | undefined,
  opts: { conversationId?: string | null; traceId?: string | null } = {},
): Promise<AuthorizeSandboxSessionResult> {
  const id = String(sessionId || '').trim();
  if (!id) {
    throw new HttpError(400, 'SESSION_REQUIRED', 'session_id required');
  }
  const auth = await resolveTrustedAuth(req);
  const access = await resolveAgentSandboxSession(id, {
    auth,
    traceId: opts.traceId || req?.traceId || null,
  });
  const expectedConversation = opts.conversationId
    ? String(opts.conversationId)
    : null;
  const actualConversation = String(
    access?.conversation_id || access?.conversationId || '',
  );
  if (expectedConversation && actualConversation !== expectedConversation) {
    throw new HttpError(404, 'SESSION_NOT_FOUND', 'Session not found');
  }
  const actingUserId = String(access?.user_id || access?.userId || '').trim();
  const actingOrganizationId = String(
    access?.org_id || access?.orgId || '',
  ).trim();
  if (!actingUserId || !actingOrganizationId) {
    throw new HttpError(503, 'SESSION_OWNER_UNAVAILABLE', 'Session owner unavailable');
  }
  return {
    auth,
    access,
    sandboxAuth: {
      actingUserId,
      actingOrganizationId,
      // Agent has already enforced the owner scope. Keep the Sandbox hop at
      // the least-privileged role even when the BFF caller is an administrator.
      actingRole: 'user',
    },
  };
}

/**
 * Authorize run access via Agent owner-scoped GET (MySQL).
 */
export async function authorizeRunRequest(
  runId: string,
  req: ReqWithTrace | null | undefined,
): Promise<{ auth: TrustedAuthContext; run: any }> {
  const auth = await resolveTrustedAuth(req);
  // Owner scope is enforced inside Agent GetRunService.
  const run = await getDurableRun(auth, runId, req?.traceId);
  return { auth, run };
}

