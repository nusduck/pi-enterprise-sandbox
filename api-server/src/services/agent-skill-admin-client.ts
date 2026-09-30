/**
 * Agent 端 Skill 管理面与共享申请面的 BFF 调用（ADR 0015 §7.2）。
 *
 * 两类调用共用一份转发逻辑，因为它们的形状完全一样：**BFF 只转发 + 投影身份**。
 * 角色判定（`role === 'admin'`）、org 作用域、跨 org 404、状态机合法性全在 agent/，
 * 这里不做二次判断——BFF 判一次会让「谁说了算」变成两个地方，而它手里只有
 * 请求头里的角色，没有账本。
 *
 * 独立成文件的理由是行数棘轮：`agent-client.ts` 与 `agent-admin-client.ts` 都贴着
 * 预算，新的转发逻辑从这里开始守 1000 行上限。
 */
import { agentFetch, requestHeaders } from './agent-client.js';
import { config } from '../config.js';

type Opts = { auth?: any; traceId?: string | null };

async function requestAgentSkill(
  path: string,
  {
    method = 'GET',
    query = null,
    body = null,
    extraHeaders = {},
    auth = null,
    traceId = null,
    maxBytes = null,
  }: {
    method?: string;
    query?: URLSearchParams | null;
    body?: any;
    extraHeaders?: Record<string, string>;
    maxBytes?: number | null;
  } & Opts = {},
): Promise<any> {
  const url = new URL(`${config.AGENT_BASE_URL}${path}`);
  if (query) for (const [k, v] of query) url.searchParams.set(k, v);
  const isStream = body && typeof body.pipe === 'function';
  // 声明体大小上限时先看 `Content-Length`：整包读进内存再拒绝是白花的钱，
  // 而归档面允许 50MB。
  if (maxBytes != null && isStream) {
    const declared = Number(extraHeaders['Content-Length'] ?? extraHeaders['content-length'] ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
      const error: any = new Error('Skill archive exceeds size limit');
      error.status = 413;
      error.code = 'SKILL_ARCHIVE_TOO_LARGE';
      throw error;
    }
  }
  const headers = requestHeaders({
    auth,
    traceId,
    extra: { 'Content-Type': 'application/json', ...extraHeaders },
  });
  const fetchOpts: RequestInit = { method, headers };
  if (body != null) fetchOpts.body = isStream ? body : JSON.stringify(body);
  if (isStream) (fetchOpts as any).duplex = 'half';
  const resp = await agentFetch(url, fetchOpts);
  if (!resp.ok) {
    const payload: any = await resp.json().catch(() => ({}));
    const error: any = new Error(
      typeof payload.error === 'string'
        ? payload.error
        : `Agent Skill request failed (${resp.status})`,
    );
    error.status = resp.status;
    if (typeof payload.code === 'string') error.code = payload.code;
    throw error;
  }
  return resp.json();
}

// ── 用户侧：共享申请（design §7.2 用户侧表） ────────────────────────────────

export function createAgentSkillShareRequest(name: string, note: unknown, opts: Opts = {}): Promise<any> {
  return requestAgentSkill('/internal/skills/share-requests', {
    method: 'POST',
    // 名字放在 body 里而不是路径里：与 agent 内部面一致，且避免路径段里出现
    // 需要二次解码的名字（`SKILL_NAME_PATTERN` 虽然不含 `/`，但白名单比约定稳）。
    body: { name, ...(typeof note === 'string' && note !== '' ? { note } : {}) },
    ...opts,
  });
}

export function listAgentSkillShareRequests(opts: Opts = {}): Promise<any> {
  return requestAgentSkill('/internal/skills/share-requests', { ...opts });
}

export function withdrawAgentSkillShareRequest(requestId: string, opts: Opts = {}): Promise<any> {
  return requestAgentSkill(
    `/internal/skills/share-requests/${encodeURIComponent(requestId)}/withdraw`,
    { method: 'POST', body: {}, ...opts },
  );
}

// ── 管理员侧：申请队列与 org 层（design §7.2 管理员侧表） ──────────────────

export function listAdminSkillShareRequests(query: URLSearchParams, opts: Opts = {}): Promise<any> {
  // 只转发已知的键（与 admin/runs 同一条纪律）：浏览器的 query 不能直达 agent。
  // `scope=org` 是 agent 内部面区分「管理员队列」的唯一开关；**权限不靠它**——
  // agent 收到之后仍然要过 admin 检查（跨 org 一律 404）。
  const scoped = new URLSearchParams();
  const status = query.get('status');
  if (status != null && status !== '') scoped.set('status', status);
  scoped.set('scope', 'org');
  return requestAgentSkill('/internal/skills/share-requests', { query: scoped, ...opts });
}

export function getAdminSkillShareRequestManifest(requestId: string, opts: Opts = {}): Promise<any> {
  return requestAgentSkill(
    `/internal/skills/share-requests/${encodeURIComponent(requestId)}/manifest`,
    { ...opts },
  );
}

export function decideAdminSkillShareRequest(
  requestId: string,
  decision: 'approve' | 'reject',
  body: Record<string, unknown>,
  opts: Opts = {},
): Promise<any> {
  return requestAgentSkill(
    `/internal/skills/share-requests/${encodeURIComponent(requestId)}/${decision}`,
    { method: 'POST', body, ...opts },
  );
}

export function listAdminOrgSkills(opts: Opts = {}): Promise<any> {
  return requestAgentSkill('/internal/skills/org', { ...opts });
}

export function uploadAdminOrgSkill(
  body: any,
  filename: string,
  { setCurrent = false, ...opts }: Opts & { setCurrent?: boolean } = {},
): Promise<any> {
  const query = new URLSearchParams({ filename: String(filename || 'skill.zip') });
  if (setCurrent) query.set('set_current', 'true');
  return requestAgentSkill('/internal/skills/org', {
    method: 'POST',
    query,
    body,
    extraHeaders: { 'Content-Type': 'application/octet-stream' },
    maxBytes: 55 * 1024 * 1024,
    ...opts,
  });
}

export function getAdminOrgSkillManifest(name: string, digest: string, opts: Opts = {}): Promise<any> {
  return requestAgentSkill(
    `/internal/skills/org/${encodeURIComponent(name)}/versions/${encodeURIComponent(digest)}/manifest`,
    { ...opts },
  );
}

export function setAdminOrgSkillCurrent(name: string, contentDigest: string, opts: Opts = {}): Promise<any> {
  return requestAgentSkill(`/internal/skills/org/${encodeURIComponent(name)}/current`, {
    method: 'POST',
    body: { contentDigest },
    ...opts,
  });
}

export function setAdminOrgSkillVersionStatus(
  name: string,
  digest: string,
  status: 'deprecate' | 'revoke',
  reason: unknown,
  opts: Opts = {},
): Promise<any> {
  return requestAgentSkill(
    `/internal/skills/org/${encodeURIComponent(name)}/versions/${encodeURIComponent(digest)}/${status}`,
    { method: 'POST', body: { reason: typeof reason === 'string' ? reason : '' }, ...opts },
  );
}
