/**
 * Agent 目录（definitions + versions）的 Agent 端调用。
 *
 * BFF 在这条路径上只做转发与身份投影：**不缓存 Agent 列表、不判断归属、
 * 不判断哪个版本活跃**——那些是 agent/ 的权威事实（AGENTS.md §1）。
 *
 * 单独成文件而不是并进 `agent-client.ts`：后者已经贴着 1000 行的结构棘轮，
 * 再加一族端点就会把它顶破。
 */
import { agentFetch, requestHeaders } from './agent-client.js';
import { config } from '../config.js';

async function requestAgentCatalog(
  path: string,
  { method = 'GET', body = null, auth = null, traceId = null }: { method?: string; body?: any; auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const resp = await agentFetch(`${config.AGENT_BASE_URL}/internal/agents${path}`, {
    method,
    headers: requestHeaders({ auth, traceId }),
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const error: any = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent catalog request failed (${resp.status})`,
    );
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    // 只放行明确列出的结构化字段：激活冲突要让 UI 看见当前指针，
    // 但 BFF 不能把 agent/ 的任意错误载荷原样转出去。
    const details: Record<string, unknown> = {};
    if (Object.hasOwn(payload, 'active_version_id')) {
      details.active_version_id = payload.active_version_id ?? null;
    }
    if (Object.keys(details).length > 0) error.details = details;
    throw error;
  }
  if (resp.status === 204) return null;
  return resp.json();
}

export async function listAgentDefinitions(
  { limit }: { limit?: number | string } = {},
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return requestAgentCatalog(query, { auth, traceId });
}

export async function createAgentDefinition(
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentCatalog('', { method: 'POST', body, auth, traceId });
}

export async function listAgentDefinitionVersions(
  agentId: string,
  { limit }: { limit?: number | string } = {},
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : '';
  return requestAgentCatalog(
    `/${encodeURIComponent(agentId)}/versions${query}`,
    { auth, traceId },
  );
}

export async function createAgentDefinitionVersion(
  agentId: string,
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentCatalog(`/${encodeURIComponent(agentId)}/versions`, {
    method: 'POST', body, auth, traceId,
  });
}

export async function setAgentDefinitionActiveVersion(
  agentId: string,
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentCatalog(`/${encodeURIComponent(agentId)}/active-version`, {
    method: 'POST', body, auth, traceId,
  });
}

/**
 * 配置面：`options` 是能力投影，`validate` 只解析不落库。
 * BFF 在这两条上仍然只做限时转发与身份投影——语义权威在 agent/。
 */
export async function getAgentConfigOptions(
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentCatalog('/config/options', { auth, traceId });
}

export async function validateAgentConfig(
  body: any,
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<any> {
  return requestAgentCatalog('/config/validate', {
    method: 'POST', body, auth, traceId,
  });
}
