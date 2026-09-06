/**
 * Agent 目录的内部路由（`docs/design/multi-agent-selection.md` §7.1.2）。
 *
 * 这一层只做四件事：匹配路由、取可信身份、解析 body、把领域错误翻成 HTTP。
 * **归属判定、角色闸门、config 校验全在 `AgentCatalogService`**——目录的权威
 * 事实归 agent/，换个入口挂上来也绕不过它（AGENTS.md §1）。
 *
 * 返回 `true` 表示"这个请求归我处理了"（无论成败），`false` 表示"不是我的路由"。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  authSubjectsFromRequest,
  json,
  readBody,
  type AuthSubjects,
} from './request-response.js';
import { mapErrorToHttp } from './error-mapper.js';

/**
 * 目录服务的最小契约。用结构类型而不是 import 具体实现：这一层只该知道
 * "能调什么"，不该知道它由谁实现。
 */
export interface AgentCatalogServiceLike {
  listAgents(auth: AuthSubjects, opts: { limit?: number | undefined }): Promise<unknown>;
  listVersions(
    auth: AuthSubjects,
    agentId: string,
    opts: { limit?: number | undefined },
  ): Promise<unknown>;
  createAgent(auth: AuthSubjects, body: unknown): Promise<unknown>;
  createVersion(auth: AuthSubjects, agentId: string, body: unknown): Promise<unknown>;
  setActiveVersion(
    auth: AuthSubjects,
    agentId: string,
    agentVersionId: unknown,
    opts?: { expectedActiveVersionId?: unknown },
  ): Promise<unknown>;
  configOptions(auth: AuthSubjects): Promise<unknown>;
  validateConfig(
    auth: AuthSubjects,
    body: { config?: unknown, agentId?: unknown },
  ): Promise<unknown>;
}

export interface AgentRouteInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly parsedUrl: URL;
  readonly path: string;
  readonly agentCatalogService?: AgentCatalogServiceLike | null | undefined;
}

const AUTH_CONTEXT_ERROR = Object.freeze({
  error: 'X-Acting-User-Id and X-Acting-Organization-Id are required',
  code: 'AUTH_CONTEXT_REQUIRED',
});
const DEPENDENCY_ERROR = Object.freeze({
  error: 'Agent catalog unavailable',
  code: 'DEPENDENCY',
});

/**
 * 返回 auth **与**服务本身：让"服务存在"这件事进入类型，调用点就不需要
 * 非空断言去重复一次已经检查过的事实。
 */
function requireCatalogContext(
  req: IncomingMessage,
  res: ServerResponse,
  agentCatalogService: AgentCatalogServiceLike | null | undefined,
): { auth: AuthSubjects; service: AgentCatalogServiceLike } | null {
  if (!agentCatalogService) {
    json(res, 503, DEPENDENCY_ERROR);
    return null;
  }
  const auth = authSubjectsFromRequest(req);
  if (!auth) {
    json(res, 400, AUTH_CONTEXT_ERROR);
    return null;
  }
  return { auth, service: agentCatalogService };
}

async function parseJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<{ ok: boolean; body: Record<string, unknown> }> {
  try {
    const raw = await readBody(req);
    const parsed = raw ? JSON.parse(raw) : {};
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      json(res, 400, { error: 'Request body must be an object', code: 'VALIDATION' });
      return { ok: false, body: {} };
    }
    return { ok: true, body: parsed as Record<string, unknown> };
  } catch {
    json(res, 400, { error: 'Invalid JSON body', code: 'VALIDATION' });
    return { ok: false, body: {} };
  }
}

function respondWithMappedError(res: ServerResponse, error: unknown): void {
  const mapped = mapErrorToHttp(error);
  json(res, mapped.status, mapped.body);
}

function readLimit(parsedUrl: URL): number | undefined {
  return Number(parsedUrl.searchParams.get('limit')) || undefined;
}

/**
 * 把可选的乐观并发字段投影成 camelCase，**并保留「键不存在」这个状态**——
 * 返回空对象（而不是 `{ expectedActiveVersionId: undefined }`）才能让服务层用
 * `=== undefined` 区分「旧客户端没传」和「新客户端断言当前没有活跃版本」。
 */
function expectedActiveVersionOf(
  body: Record<string, unknown>,
): { expectedActiveVersionId?: unknown } {
  for (const key of ['expected_active_version_id', 'expectedActiveVersionId']) {
    if (Object.hasOwn(body, key)) return { expectedActiveVersionId: body[key] };
  }
  return {};
}

/** 处理 Agent 目录面。返回 true 表示这个请求已由本模块处理。 */
export async function handleAgentCatalogRoute({
  req,
  res,
  parsedUrl,
  path,
  agentCatalogService,
}: AgentRouteInput): Promise<boolean> {
  if (path === '/internal/agents') {
    if (req.method !== 'GET' && req.method !== 'POST') return false;
    const ctx = requireCatalogContext(req, res, agentCatalogService);
    if (!ctx) return true;
    try {
      if (req.method === 'GET') {
        json(res, 200, await ctx.service.listAgents(ctx.auth, {
          limit: readLimit(parsedUrl),
        }));
        return true;
      }
      const parsed = await parseJsonBody(req, res);
      if (!parsed.ok) return true;
      json(res, 201, await ctx.service.createAgent(ctx.auth, parsed.body));
    } catch (error) {
      respondWithMappedError(res, error);
    }
    return true;
  }

  // 配置面在版本路由之前匹配：`config` 是保留段，不会被当成 agentId。
  if (path === '/internal/agents/config/options' && req.method === 'GET') {
    const ctx = requireCatalogContext(req, res, agentCatalogService);
    if (!ctx) return true;
    try {
      json(res, 200, await ctx.service.configOptions(ctx.auth));
    } catch (error) {
      respondWithMappedError(res, error);
    }
    return true;
  }

  if (path === '/internal/agents/config/validate' && req.method === 'POST') {
    const ctx = requireCatalogContext(req, res, agentCatalogService);
    if (!ctx) return true;
    try {
      const parsed = await parseJsonBody(req, res);
      if (!parsed.ok) return true;
      // 字段级校验结果是**合法请求的正常结果**，所以是 200 + valid=false；
      // 只有结构性问题（body 不是对象、config 缺失）才是 400。
      json(res, 200, await ctx.service.validateConfig(ctx.auth, {
        config: parsed.body['config'],
        agentId: parsed.body['agent_id'] ?? parsed.body['agentId'],
      }));
    } catch (error) {
      respondWithMappedError(res, error);
    }
    return true;
  }

  const versionsMatch = path.match(/^\/internal\/agents\/([^/]+)\/versions$/);
  if (versionsMatch && (req.method === 'GET' || req.method === 'POST')) {
    const ctx = requireCatalogContext(req, res, agentCatalogService);
    if (!ctx) return true;
    const agentId = decodeURIComponent(versionsMatch[1] as string);
    try {
      if (req.method === 'GET') {
        json(res, 200, await ctx.service.listVersions(ctx.auth, agentId, {
          limit: readLimit(parsedUrl),
        }));
        return true;
      }
      const parsed = await parseJsonBody(req, res);
      if (!parsed.ok) return true;
      json(res, 201, await ctx.service.createVersion(ctx.auth, agentId, {
        ...parsed.body,
        // 「没传」与「传了 null」语义不同：前者跳过乐观并发检查（旧客户端），
        // 后者断言「我读到的是没有活跃版本」。展开成 camelCase 时必须保住这个区别。
        ...expectedActiveVersionOf(parsed.body),
      }));
    } catch (error) {
      respondWithMappedError(res, error);
    }
    return true;
  }

  const activateMatch = path.match(/^\/internal\/agents\/([^/]+)\/active-version$/);
  if (!activateMatch || req.method !== 'POST') return false;
  const ctx = requireCatalogContext(req, res, agentCatalogService);
  if (!ctx) return true;
  const agentId = decodeURIComponent(activateMatch[1] as string);
  try {
    const parsed = await parseJsonBody(req, res);
    if (!parsed.ok) return true;
    json(res, 200, await ctx.service.setActiveVersion(
      ctx.auth,
      agentId,
      parsed.body['agent_version_id'] ?? parsed.body['agentVersionId'] ?? null,
      expectedActiveVersionOf(parsed.body),
    ));
  } catch (error) {
    respondWithMappedError(res, error);
  }
  return true;
}
