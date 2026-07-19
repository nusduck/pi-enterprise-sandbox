/** Resolve and authorize trusted browser identity for Run operations (PR-04 T4). */

import { config } from '../config.js';
import { HttpError } from '../http/errors.js';
import { authFromRequest, createSandboxClient } from '../services/sandbox-client.js';
import {
  getAgentRun,
  resolveAgentSandboxSession,
} from '../services/agent-client.js';
import { bindRequestTraceContext } from './trace-context.js';

export const DURABLE_RUN_READ_RETRY_DELAYS_MS = Object.freeze([5, 15]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the durable run from **Agent MySQL** (owner-scoped).
 * Sandbox agent_runs is no longer the status/ownership fact source.
 *
 * First arg may be:
 * - trusted auth context `{ actingUserId, ... }` (production), or
 * - a client with `getAgentRun(runId)` (unit-test fake / legacy shape).
 */
export async function getDurableRun(authOrClient, runId, traceId = null) {
  const load =
    authOrClient && typeof authOrClient.getAgentRun === 'function'
      ? () => authOrClient.getAgentRun(runId)
      : () => getAgentRun(runId, { auth: authOrClient, traceId });

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (err) {
      if (err?.status !== 404 || attempt >= DURABLE_RUN_READ_RETRY_DELAYS_MS.length) {
        throw err;
      }
      await wait(DURABLE_RUN_READ_RETRY_DELAYS_MS[attempt]);
    }
  }
}

export async function resolveTrustedAuth(req) {
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
  // Still use Sandbox authMe for browser session identity (not Run status).
  const sandbox = createSandboxClient({
    auth: bindRequestTraceContext(forwarded, req?.traceContext),
    traceId: req?.traceId || null,
    traceContext: req?.traceContext || null,
  });
  const user = await sandbox.authMe();
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
 *
 * Browser identities and formal Sandbox owner ids are different domains. The
 * BFF must resolve the latter before touching any session-owned Sandbox route;
 * forwarding a browser JWT alone would make Sandbox resolve the external
 * subject and reject an otherwise valid formal binding. The returned
 * `sandboxAuth` is intentionally limited to the server-to-server acting
 * headers and must never be serialized into a public response.
 *
 * @param {string} sessionId
 * @param {import('node:http').IncomingMessage | null | undefined} req
 * @param {{ conversationId?: string|null, traceId?: string|null }} [opts]
 */
export async function authorizeSandboxSession(sessionId, req, opts = {}) {
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
 *
 * Defense-in-depth: Agent maps external X-Acting subjects → internal ULIDs and
 * scopes the load. BFF must **not** compare external UUID/subjects to Agent
 * response ULID userId/orgId (different ID domains). Foreign/unknown runs are
 * already 404 from Agent GET.
 *
 * Optional Sandbox conversation ACL only when conversation_id is a non-ULID
 * external id (legacy).
 */
export async function authorizeRunRequest(runId, req) {
  const auth = await resolveTrustedAuth(req);
  // Owner scope is enforced inside Agent GetRunService.
  const run = await getDurableRun(auth, runId, req?.traceId);

  const conversationId = run.conversationId || run.conversation_id;
  if (
    conversationId &&
    !String(conversationId).match(/^[0-9A-HJKMNP-TV-Z]{26}$/i)
  ) {
    // External conversation mapping may still be Sandbox-scoped UUID — optional ACL.
    try {
      const sandbox = createSandboxClient({
        auth,
        traceId: req?.traceId || null,
        traceContext: req?.traceContext || null,
      });
      await sandbox.getConversation(conversationId);
    } catch {
      throw new HttpError(404, 'RUN_NOT_FOUND', 'Run not found');
    }
  }

  return { auth, run };
}
