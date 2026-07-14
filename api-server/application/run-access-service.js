/** Resolve and authorize trusted browser identity for Run operations. */
import { config } from '../config.js';
import { HttpError } from '../http/errors.js';
import { getAgentRun } from '../services/agent-client.js';
import { authFromRequest, createSandboxClient } from '../services/sandbox-client.js';

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
  const run = await getAgentRun(runId, { auth });
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
    const sandbox = createSandboxClient({ auth });
    await sandbox.getConversation(run.conversation_id);
  } else if (!run.owner_user_id) {
    throw new HttpError(409, 'RUN_OWNERSHIP_PENDING', 'Run ownership is not ready');
  }
  return { auth, run };
}
