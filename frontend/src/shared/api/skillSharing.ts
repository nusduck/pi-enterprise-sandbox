/**
 * 共享申请与 org 层管理的前端 API 适配（ADR 0015 §7.1/§7.2）。
 *
 * 与能力目录那几个接口不同，这里是**硬失败**：申请/批准/吊销都要么成功要么把原因
 * 告诉用户，没有「接口还没做好」这种中间态可以悄悄吞掉。所以错误一律抛出带
 * `code` 的 `ApiError`，由调用方决定怎么显示。
 */
import { ApiError, authHeaders } from './client';

const BASE = '/api';

export type ShareRequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';

/** 一条共享申请。字段名跟随 agent 的投影（camelCase）。 */
export interface SkillShareRequest {
  requestId: string;
  name: string;
  contentDigest: string;
  note: string;
  status: ShareRequestStatus;
  decidedByUserId: string;
  decidedAt: string | null;
  decisionNote: string;
  createdAt: string;
}

export interface OrgSkillVersion {
  contentDigest: string;
  status: 'active' | 'deprecated' | 'revoked';
  publishedAt?: string;
  publishedByUserId?: string;
  originKind?: string;
  originUserId?: string;
  fileCount?: number;
  totalBytes?: number;
  description?: string;
}

export interface OrgSkillName {
  name: string;
  currentDigest: string;
  versions: OrgSkillVersion[];
}

export interface SkillManifest {
  name: string;
  contentDigest: string;
  fileCount: number;
  totalBytes: number;
  files: Array<{ path: string; bytes: number }>;
  skillMd: string;
  truncated: boolean;
  affectedAgentVersionIds?: string[];
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  const text = await resp.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!resp.ok) {
    const body = (payload || {}) as { error?: unknown; code?: unknown };
    throw new ApiError(String(body.error || `请求失败（HTTP ${resp.status}）`), {
      status: resp.status,
      code: typeof body.code === 'string' ? body.code : null,
    });
  }
  return payload as T;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value ?? {}),
  };
}

// ── 用户侧 ──────────────────────────────────────────────────────────────

/** 以当前**已启用**版本发起申请；未启用时服务端回 409 `SKILL_NOT_ENABLED`。 */
export function requestSkillShare(name: string, note?: string): Promise<{ request: SkillShareRequest }> {
  return request(
    `/capabilities/skills/${encodeURIComponent(name)}/share-requests`,
    jsonBody(note ? { note } : {}),
  );
}

export async function listMySkillShareRequests(): Promise<SkillShareRequest[]> {
  const body = await request<{ requests?: SkillShareRequest[] }>('/capabilities/skills/share-requests');
  return body.requests ?? [];
}

export function withdrawSkillShare(requestId: string): Promise<{ request: SkillShareRequest }> {
  return request(
    `/capabilities/skills/share-requests/${encodeURIComponent(requestId)}/withdraw`,
    jsonBody({}),
  );
}

// ── 管理员侧 ────────────────────────────────────────────────────────────

/** 共享申请队列的一页：`next_cursor === null` 表示到底（design ui-polish.md §2.4）。 */
export interface SkillShareQueuePage {
  requests: SkillShareRequest[];
  next_cursor: string | null;
}

/**
 * GET /api/admin/skills/share-requests — cursor-paginated page
 * (`limit` 1..100, server default 50)。仍是硬失败：错误带 `code` 抛给调用方。
 */
export async function listSkillShareQueuePage(opts: {
  status?: ShareRequestStatus;
  limit?: number;
  cursor?: string | null;
} = {}): Promise<SkillShareQueuePage> {
  const query = new URLSearchParams();
  if (opts.status) query.set('status', opts.status);
  if (opts.limit != null) query.set('limit', String(opts.limit));
  if (opts.cursor) query.set('cursor', opts.cursor);
  const qs = query.toString() ? `?${query}` : '';
  const body = await request<{ requests?: SkillShareRequest[]; next_cursor?: unknown }>(
    `/admin/skills/share-requests${qs}`,
  );
  return {
    requests: body.requests ?? [],
    next_cursor: typeof body.next_cursor === 'string' ? body.next_cursor : null,
  };
}

/** 队列首页，保持旧的数组返回（`SkillAdminPage` 尚未迁移到分页）。 */
export async function listSkillShareQueue(status?: ShareRequestStatus): Promise<SkillShareRequest[]> {
  const { requests } = await listSkillShareQueuePage(status ? { status } : {});
  return requests;
}

export function getShareRequestManifest(requestId: string): Promise<SkillManifest> {
  return request(`/admin/skills/share-requests/${encodeURIComponent(requestId)}/manifest`);
}

export function approveSkillShare(
  requestId: string,
  opts: { setCurrent?: boolean; note?: string } = {},
): Promise<{ request: SkillShareRequest }> {
  return request(
    `/admin/skills/share-requests/${encodeURIComponent(requestId)}/approve`,
    jsonBody(opts),
  );
}

export function rejectSkillShare(requestId: string, note: string): Promise<{ request: SkillShareRequest }> {
  return request(
    `/admin/skills/share-requests/${encodeURIComponent(requestId)}/reject`,
    jsonBody({ note }),
  );
}

export async function listOrgSkills(): Promise<OrgSkillName[]> {
  const body = await request<{ skills?: OrgSkillName[] }>('/admin/skills/org');
  return body.skills ?? [];
}

export function getOrgSkillManifest(name: string, digest: string): Promise<SkillManifest> {
  return request(
    `/admin/skills/org/${encodeURIComponent(name)}/versions/${encodeURIComponent(digest)}/manifest`,
  );
}

export function uploadOrgSkill(
  file: File | Blob,
  filename: string,
  setCurrent = false,
): Promise<{ name: string }> {
  const headers = authHeaders();
  headers['Content-Type'] = 'application/octet-stream';
  headers['X-Filename'] = encodeURIComponent(filename);
  if (setCurrent) headers['X-Set-Current'] = '1';
  const query = `?filename=${encodeURIComponent(filename)}${setCurrent ? '&set_current=true' : ''}`;
  return request(`/admin/skills/org${query}`, { method: 'POST', headers, body: file });
}

export function setOrgSkillCurrent(name: string, contentDigest: string): Promise<{ ok: boolean }> {
  return request(
    `/admin/skills/org/${encodeURIComponent(name)}/current`,
    jsonBody({ contentDigest }),
  );
}

export function setOrgSkillVersionStatus(
  name: string,
  digest: string,
  status: 'deprecate' | 'revoke',
  reason: string,
): Promise<{ ok: boolean; status: string; affectedAgentVersionIds: string[] }> {
  return request(
    `/admin/skills/org/${encodeURIComponent(name)}/versions/${encodeURIComponent(digest)}/${status}`,
    jsonBody({ reason }),
  );
}
