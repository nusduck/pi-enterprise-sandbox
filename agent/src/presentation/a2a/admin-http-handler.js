import { ExternalIdentityResolver } from '../../application/parent/external-identity-resolver.js';
import { publicCredentialView } from '../../application/a2a/credential-service.js';
import { isUlid } from '../../domain/shared/ulid.js';

function errorStatus(error) {
  if (error?.name === 'OwnerScopedNotFoundError') return 404;
  if (error?.name === 'ValidationError') return 400;
  if (error?.name === 'ConflictError') return 409;
  return 500;
}

function safeError(error, status) {
  return status >= 500
    ? 'Internal server error'
    : error instanceof Error
      ? error.message
      : 'Request failed';
}

async function readJson(req, deps) {
  const raw = await deps.readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.name = 'ValidationError';
    throw error;
  }
}

/**
 * Internal admin API for A2A configuration and credential lifecycle.
 * The route is additionally protected by AGENT_INTERNAL_TOKEN in the server.
 */
export function createA2aAdminHttpHandler(deps) {
  if (!deps?.credentialService || !deps?.createRepositories) {
    throw new Error('A2A admin handler requires credential service and repositories');
  }

  async function resolveAdmin(req) {
    const auth = deps.authSubjectsFromRequest(req);
    if (!auth) {
      const error = new Error('Authenticated admin identity is required');
      error.status = 401;
      throw error;
    }
    if (String(auth.role || '').toLowerCase() !== 'admin') {
      const error = new Error('Administrator role is required');
      error.status = 403;
      throw error;
    }
    const repos = deps.createRepositories(deps.db);
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    return { auth, owner: await resolver.resolveOwner(auth), repos };
  }

  async function requireOwnedAgent(repos, owner, agentId) {
    if (!isUlid(agentId)) {
      const error = new Error('agentId must be a ULID');
      error.name = 'ValidationError';
      throw error;
    }
    const agent = await repos.catalog.getDefinitionById(agentId);
    if (!agent || agent.orgId !== owner.orgId) {
      const error = new Error('Agent not found');
      error.name = 'OwnerScopedNotFoundError';
      throw error;
    }
    return agent;
  }

  async function appendAudit(repos, owner, input) {
    await repos.a2aAudit.append({
      auditId: deps.generateId(),
      orgId: owner.orgId,
      clientId: input.clientId,
      credentialId: input.credentialId,
      agentId: input.agentId,
      eventType: input.eventType,
      traceId: input.traceId,
      method: input.method,
      payloadJson: input.payloadJson,
    });
  }

  async function handle(req, res, parsedUrl) {
    const path = parsedUrl.pathname || '/';
    if (!path.startsWith('/internal/a2a/')) return false;

    try {
      const { owner, repos } = await resolveAdmin(req);
      const traceId = deps.resolveTraceId(req);

      if (req.method === 'GET' && path === '/internal/a2a/config') {
        const requestedAgentId = parsedUrl.searchParams.get('agent_id');
        // Keep the complete owner-scoped catalog in every response so a UI
        // refresh for one Agent does not make all other Agent options vanish.
        const agents = await repos.catalog.listDefinitionsByOrg(owner.orgId);
        const selectedAgent = requestedAgentId
          ? await requireOwnedAgent(repos, owner, requestedAgentId)
          : agents[0] || null;
        const selectedAgentId = selectedAgent?.agentId || null;
        const credentials = await repos.a2aCredentials.listByOrg(owner.orgId, {
          agentId: selectedAgentId,
        });
        const tasks = await repos.a2aTasks.listForOrgAdmin(owner.orgId, {
          agentId: selectedAgentId,
          limit: 20,
        });
        const audit = await repos.a2aAudit.listForOrgAdmin(owner.orgId, {
          agentId: selectedAgentId,
          limit: 20,
        });
        const base = String(deps.publicBaseUrl || '').replace(/\/$/, '');
        deps.json(res, 200, {
          publicBaseUrl: base || null,
          streaming: true,
          authentication: 'Bearer API credential',
          agents: agents.map((agent) => ({
            ...agent,
            agentCardUrl: base
              ? `${base}/a2a/agents/${agent.agentId}/.well-known/agent-card.json`
              : null,
            endpoint: base ? `${base}/a2a/agents/${agent.agentId}` : null,
          })),
          selectedAgentId,
          credentials: credentials.map(publicCredentialView),
          recentTasks: tasks,
          audit,
        });
        return true;
      }

      if (req.method === 'POST' && path === '/internal/a2a/credentials') {
        const body = await readJson(req, deps);
        const agent = await requireOwnedAgent(repos, owner, body.agentId);
        const issued = await deps.credentialService.issue({
          orgId: owner.orgId,
          agentId: agent.agentId,
          clientId: body.clientId,
          scopes: body.scopes,
          expiresAt: body.expiresAt,
        });
        await appendAudit(repos, owner, {
          clientId: issued.credential.clientId,
          credentialId: issued.credential.credentialId,
          agentId: agent.agentId,
          eventType: 'a2a.credential_issued',
          method: 'IssueCredential',
          traceId,
          payloadJson: { scopes: issued.credential.scopes },
        });
        deps.json(res, 201, issued);
        return true;
      }

      const action = path.match(
        /^\/internal\/a2a\/credentials\/([^/]+)\/(rotate|revoke)$/,
      );
      if (req.method === 'POST' && action) {
        const credentialId = decodeURIComponent(action[1]);
        const existing = await repos.a2aCredentials.getById(credentialId);
        if (!existing || existing.orgId !== owner.orgId) {
          const error = new Error('Credential not found');
          error.name = 'OwnerScopedNotFoundError';
          throw error;
        }
        const body = await readJson(req, deps);
        if (action[2] === 'rotate') {
          const rotated = await deps.credentialService.rotate({
            credentialId,
            orgId: owner.orgId,
            scopes: body.scopes,
            expiresAt: body.expiresAt,
          });
          await appendAudit(repos, owner, {
            clientId: existing.clientId,
            credentialId: rotated.credential.credentialId,
            agentId: existing.agentId,
            eventType: 'a2a.credential_rotated',
            method: 'RotateCredential',
            traceId,
            payloadJson: { rotatedFromId: credentialId },
          });
          deps.json(res, 200, rotated);
        } else {
          const revoked = await deps.credentialService.revoke({
            credentialId,
            orgId: owner.orgId,
          });
          await appendAudit(repos, owner, {
            clientId: existing.clientId,
            credentialId,
            agentId: existing.agentId,
            eventType: 'a2a.credential_revoked',
            method: 'RevokeCredential',
            traceId,
          });
          deps.json(res, 200, { credential: revoked });
        }
        return true;
      }
    } catch (error) {
      const status = Number(error?.status) || errorStatus(error);
      deps.json(res, status, {
        error: safeError(error, status),
        code:
          status === 401
            ? 'AUTH_REQUIRED'
            : status === 403
              ? 'ADMIN_REQUIRED'
              : status === 404
                ? 'NOT_FOUND'
                : status === 409
                  ? 'CONFLICT'
                  : status >= 500
                    ? 'INTERNAL_ERROR'
                    : 'INVALID_REQUEST',
      });
      return true;
    }

    return false;
  }

  return { handle };
}
