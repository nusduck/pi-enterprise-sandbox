/**
 * A2A 配置与凭据生命周期的内部管理面。阶段 C 的 TS 转换。
 *
 * 路由本身还受 `AGENT_INTERNAL_TOKEN` 保护（在 server 那层），这里再叠一层
 * **管理员角色**校验：内部 token 证明"调用方是我们的服务"，不证明"这个人
 * 可以改凭据"。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ExternalIdentityResolver } from '../../application/parent/external-identity-resolver.js';
import { publicCredentialView } from '../../application/a2a/credential-service.js';
import { isUlid } from '../../domain/shared/ulid.js';

/**
 * 带 HTTP 状态的错误。
 *
 * 转 TS 时替掉了两处 `@ts-expect-error`：原来是 `new Error()` 之后直接赋
 * `.status`，在 TS 下不成立。这个类型让"状态码是错误的一部分"变成显式契约，
 * 而不是一个靠约定成立的动态属性。
 */
class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    name?: string,
  ) {
    super(message);
    if (name !== undefined) this.name = name;
  }
}

/** 领域错误只靠 `name` 区分（跨模块 instanceof 在 ESM 下不可靠）。 */
function namedError(message: string, name: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function errorStatus(error: unknown): number {
  const named = error as { name?: unknown; status?: unknown } | null;
  if (typeof named?.status === 'number') return named.status;
  if (named?.name === 'OwnerScopedNotFoundError') return 404;
  if (named?.name === 'ValidationError') return 400;
  if (named?.name === 'ConflictError') return 409;
  return 500;
}

function safeError(error: unknown, status: number): string {
  return status >= 500
    ? 'Internal server error'
    : error instanceof Error
      ? error.message
      : 'Request failed';
}

/**
 * 读并解析请求体。返回 `unknown`——body 来自外部，调用方必须显式收窄。
 * 把它声明成 `any` 会让"这是不可信输入"这条事实从类型里消失。
 */
async function readJson(req: IncomingMessage, deps: AdminHandlerDeps): Promise<unknown> {
  const raw = await deps.readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw namedError('Request body must be valid JSON', 'ValidationError');
  }
}

/**
 * 本处理器需要的依赖。宽松类型（`any` 的具名别名）是过渡期的诚实表述：
 * 仓储与服务都还是 JS，给它们编造精确类型等于谎报现状。等 application/ 与
 * infrastructure/ 转完 TS，这里会自然收紧。
 */
type Loose = any;

export interface AdminHandlerDeps {
  readonly credentialService: Loose;
  readonly createRepositories: (db: Loose) => Loose;
  readonly db: Loose;
  readonly authSubjectsFromRequest: (req: IncomingMessage) => Loose;
  readonly resolveTraceId: (req: IncomingMessage) => string;
  readonly readBody: (req: IncomingMessage) => Promise<string>;
  readonly json: (res: ServerResponse, status: number, body: unknown) => void;
  readonly generateId: () => string;
  readonly publicBaseUrl?: string | undefined;
}

/**
 * Internal admin API for A2A configuration and credential lifecycle.
 * The route is additionally protected by AGENT_INTERNAL_TOKEN in the server.
 */
export function createA2aAdminHttpHandler(deps: AdminHandlerDeps) {
  if (!deps?.credentialService || !deps?.createRepositories) {
    throw new Error('A2A admin handler requires credential service and repositories');
  }

  async function resolveAdmin(req: IncomingMessage) {
    const auth = deps.authSubjectsFromRequest(req);
    if (!auth) {
      throw new HttpStatusError('Authenticated admin identity is required', 401);
    }
    if (String(auth.role || '').toLowerCase() !== 'admin') {
      throw new HttpStatusError('Administrator role is required', 403);
    }
    const repos = deps.createRepositories(deps.db);
    const resolver = new ExternalIdentityResolver({
      organizations: repos.organizations,
      externalRefs: repos.externalRefs,
    });
    return { auth, owner: await resolver.resolveOwner(auth), repos };
  }

  async function requireOwnedAgent(repos: Loose, owner: Loose, agentId: string) {
    if (!isUlid(agentId)) throw namedError('agentId must be a ULID', 'ValidationError');
    const agent = await repos.catalog.getDefinitionById(agentId);
    // 跨租户一律当作不存在——存在性本身不能泄漏。
    if (!agent || agent.orgId !== owner.orgId) {
      throw namedError('Agent not found', 'OwnerScopedNotFoundError');
    }
    return agent;
  }

  async function appendAudit(repos: Loose, owner: Loose, input: Loose) {
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

  async function handle(req: IncomingMessage, res: ServerResponse, parsedUrl: URL): Promise<boolean> {
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
        const body = (await readJson(req, deps)) as Loose;
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
        const body = (await readJson(req, deps)) as Loose;
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
