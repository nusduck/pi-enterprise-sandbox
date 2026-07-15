/** Resolve and authorize trusted browser identity for Run operations. */
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';
import { authFromRequest, createSandboxClient } from '../services/sandbox-client.js';

export const DURABLE_RUN_READ_RETRY_DELAYS_MS = Object.freeze([5, 15]);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Read the durable run row with a small eventual-consistency cushion.
 * The Agent's create endpoint is the correctness barrier; this retry only
 * protects deployments whose database reads can briefly lag a committed write.
 * A genuinely unknown or foreign ID still returns the original 404.
 */
export async function getDurableRun(sandbox, runId) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await sandbox.getAgentRun(runId);
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
  if (!config.AUTH_ENABLED) return forwarded;
  if (!forwarded.authorization) {
    throw new HttpError(401, 'AUTH_REQUIRED', 'Authentication required');
  }
  const sandbox = createSandboxClient({ auth: forwarded });
  const user = await sandbox.authMe();
  const userId = user?.id != null ? String(user.id) : '';
  const organizationId = user?.organization_id != null
    ? String(user.organization_id)
    : '';
  if (!userId || !organizationId) {
    throw new HttpError(
      401,
      'AUTH_CONTEXT_INCOMPLETE',
      'Authenticated user context is incomplete',
    );
  }
  return {
    ...forwarded,
    actingUserId: userId,
    actingOrganizationId: organizationId,
    actingRole: String(user.role || 'user'),
  };
}

export async function authorizeRunRequest(runId, req) {
  const auth = await resolveTrustedAuth(req);
  // Persisted run ownership is authoritative. The Agent keeps only a bounded
  // in-memory execution log, so completed or pre-restart runs may no longer be
  // available there even though their durable history still exists.
  const sandbox = createSandboxClient({ auth });
  const run = await getDurableRun(sandbox, runId);
  if (!config.AUTH_ENABLED) return { auth, run };

  if (
    run.owner_user_id &&
    String(run.owner_user_id) !== String(auth.actingUserId) &&
    String(auth.actingRole || '').toLowerCase() !== 'admin'
  ) {
    throw new HttpError(404, 'RUN_NOT_FOUND', 'Run not found');
  }
  if (
    run.organization_id &&
    String(run.organization_id) !== String(auth.actingOrganizationId)
  ) {
    throw new HttpError(404, 'RUN_NOT_FOUND', 'Run not found');
  }

  if (run.conversation_id) {
    await sandbox.getConversation(run.conversation_id);
  } else if (!run.owner_user_id) {
    throw new HttpError(409, 'RUN_OWNERSHIP_PENDING', 'Run ownership is not ready');
  }
  return { auth, run };
}
