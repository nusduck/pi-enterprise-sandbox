/**
 * 调用者的正式归属（org_id / user_id ULID），供不针对某个会话的 exec 调用使用
 * （目前是产物库）。会话作用域的请求仍走 `authorizeSandboxSession`。
 */
import { agentFetch, requestHeaders } from './agent-client.js';
import { config } from '../config.js';

export async function resolveOwnerIdentity(
  { auth = null, traceId = null }: { auth?: any; traceId?: string | null } = {},
): Promise<{ orgId: string; userId: string }> {
  const resp = await agentFetch(`${config.AGENT_BASE_URL}/internal/identity/owner`, {
    headers: requestHeaders({ auth, traceId }),
  });
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const error: any = new Error(typeof payload.error === 'string' ? payload.error : `Owner lookup failed (${resp.status})`);
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  const body: any = await resp.json();
  const orgId = String(body?.org_id || '').trim();
  const userId = String(body?.user_id || '').trim();
  if (!orgId || !userId) {
    // Never fall back to the browser's external ids: fail closed.
    const error: any = new Error('Owner identity unavailable');
    error.status = 503;
    error.code = 'OWNER_IDENTITY_UNAVAILABLE';
    throw error;
  }
  return { orgId, userId };
}
