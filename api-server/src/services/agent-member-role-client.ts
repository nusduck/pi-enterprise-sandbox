/**
 * 平台角色管理的 Agent 端调用（`/internal/admin/members*`，design §5）。
 *
 * 与 `agent-admin-client.ts` / `agent-skill-admin-client.ts` 同一纪律：**BFF 只转发
 * 与投影身份**。角色判定、org 作用域、跨 org 404、`LAST_ADMIN` /
 * `ROLE_PINNED_BY_DEPLOYMENT` 全在 agent/，这里不做二次判断，也不缓存
 * （撤销要在下一个请求生效，缓存会直接破坏这条）。
 *
 * 单独成文件：`agent-client.ts` 与 `agent-admin-client.ts` 都贴着行数棘轮。
 */
import { agentFetch, requestHeaders } from './agent-client.js';
import { config } from '../config.js';

type Opts = { auth?: any; traceId?: string | null };

/** Agent 接受的查询键；浏览器多带的键一律丢掉。 */
const LIST_KEYS = ['q', 'role', 'cursor', 'limit'] as const;

async function requestAgentMembers(
  path: string,
  query: URLSearchParams | null,
  { auth = null, traceId = null }: Opts,
  method = 'GET',
): Promise<any> {
  const url = new URL(`${config.AGENT_BASE_URL}/internal/admin/members${path}`);
  if (query) for (const [k, v] of query) url.searchParams.set(k, v);
  const resp = await agentFetch(url, {
    method,
    headers: requestHeaders({ auth, traceId }),
  });
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const error: any = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent member request failed (${resp.status})`,
    );
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  return resp.json();
}

function pick(source: URLSearchParams, keys: readonly string[]): URLSearchParams {
  const out = new URLSearchParams();
  for (const key of keys) {
    const value = source.get(key);
    if (value != null && value !== '') out.set(key, value);
  }
  return out;
}

export function listAdminMembers(source: URLSearchParams, opts: Opts = {}): Promise<any> {
  return requestAgentMembers('', pick(source, LIST_KEYS), opts);
}

export function grantAdminMemberRole(
  userId: string,
  role: string,
  opts: Opts = {},
): Promise<any> {
  return requestAgentMembers(
    `/${encodeURIComponent(userId)}/roles/${encodeURIComponent(role)}`,
    null,
    opts,
    'PUT',
  );
}

export function revokeAdminMemberRole(
  userId: string,
  role: string,
  opts: Opts = {},
): Promise<any> {
  return requestAgentMembers(
    `/${encodeURIComponent(userId)}/roles/${encodeURIComponent(role)}`,
    null,
    opts,
    'DELETE',
  );
}

export function listAdminMemberRoleEvents(
  userId: string,
  source: URLSearchParams,
  opts: Opts = {},
): Promise<any> {
  return requestAgentMembers(
    `/${encodeURIComponent(userId)}/role-events`,
    pick(source, ['limit']),
    opts,
  );
}
