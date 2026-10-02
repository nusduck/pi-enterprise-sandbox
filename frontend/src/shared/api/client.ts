/**
 * Typed HTTP + SSE stream client for the Sandbox API Server.
 * Typed client for API Server resources.
 */
import { isAllowedApiUrl } from '../security/url';
import {
  ApprovalDecisionSchema,
  ArtifactImportResponseSchema,
  ArtifactListSchema,
  ConversationEventsResponseSchema,
  ConversationListSchema,
  ConversationSchema,
  EnsureSessionSchema,
  parseApi,
  parseApiStrict,
  type ArtifactImportResponse,
  type Conversation,
  type ConversationEventsResponse,
  type EnsureSession,
} from '../schemas/api';
import type { Artifact } from '../state/types';

const BASE = '/api';

/** Browser authentication is carried by the BFF-owned HttpOnly session cookie. */
export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra };
}

export class ApiError extends Error {
  status?: number;
  code?: string | null;
  traceId?: string | null;
  detail?: unknown;

  constructor(message: string, opts: Partial<ApiError> = {}) {
    super(message);
    this.name = 'ApiError';
    Object.assign(this, opts);
  }
}

export async function errorBody(resp: Response): Promise<Record<string, unknown>> {
  return (await resp.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Build the ApiError for a failed response.
 *
 * - message (shown to people): `error`, then `detail`, then `${fallback}: ${status}`.
 * - code (for branching): the specific `reason_code` when the server sent one, else `code`.
 */
export function toApiError(
  resp: Response,
  body: Record<string, unknown> | null | undefined,
  fallback: string,
): ApiError {
  const b = body || {};
  const message =
    (typeof b.error === 'string' && b.error.trim()) ||
    (typeof b.detail === 'string' && b.detail.trim()) ||
    (b.error != null && typeof b.error === 'object' ? JSON.stringify(b.error) : '') ||
    (b.error != null && String(b.error).trim() ? String(b.error) : '') ||
    (b.detail != null && typeof b.detail === 'object' ? JSON.stringify(b.detail) : '') ||
    (b.detail != null && String(b.detail).trim() ? String(b.detail) : '') ||
    `${fallback}: ${resp.status}`;
  const code =
    (typeof b.reason_code === 'string' && b.reason_code.trim()) ||
    (typeof b.code === 'string' && b.code.trim()) ||
    null;
  return new ApiError(message, {
    status: resp.status,
    code,
    traceId: (b.trace_id as string) || resp.headers.get('x-trace-id') || null,
    detail: b,
  });
}

export async function throwApiError(resp: Response, fallback: string): Promise<never> {
  const body = await errorBody(resp);
  throw toApiError(resp, body, fallback);
}

// ── Conversations ───────────────────────────────

/** `GET /api/conversations` 的一页：`next_cursor === null` 表示到底（§2.4）。 */
export type ConversationPage = {
  conversations: Conversation[];
  next_cursor: string | null;
};

/**
 * GET /api/conversations — cursor-paginated list (`q` filters titles server-side).
 * `limit` / `cursor` / `q` only go on the query string when the caller set them;
 * the server owns their defaults (limit 30). `URLSearchParams` escapes `q`.
 */
export async function listConversations(opts: {
  limit?: number;
  cursor?: string | null;
  q?: string | null;
} = {}): Promise<ConversationPage> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.cursor) q.set('cursor', opts.cursor);
  if (opts.q) q.set('q', opts.q);
  const qs = q.toString() ? `?${q}` : '';
  const resp = await fetch(`${BASE}/conversations${qs}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    await throwApiError(resp, 'List conversations failed');
  }
  const page = parseApi(ConversationListSchema, await resp.json(), 'conversations');
  // parseApi 软失败时会把原始 body 原样放行（例如响应仍是旧版裸数组），这里再兜一层，
  // 不把 undefined 当列表、也不把「缺 cursor」读成「还有下一页」交给调用方。
  return {
    conversations: Array.isArray(page.conversations) ? page.conversations : [],
    next_cursor: typeof page.next_cursor === 'string' ? page.next_cursor : null,
  };
}

export async function getConversation(id: string): Promise<Conversation> {
  const resp = await fetch(`${BASE}/conversations/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    await throwApiError(resp, 'Get conversation failed');
  }
  return parseApi(ConversationSchema, await resp.json(), 'conversation');
}

export async function getConversationEvents(
  id: string,
): Promise<ConversationEventsResponse> {
  const resp = await fetch(
    `${BASE}/conversations/${encodeURIComponent(id)}/events`,
    { headers: authHeaders() },
  );
  if (!resp.ok) {
    await throwApiError(resp, 'Conversation events failed');
  }
  return parseApiStrict(
    ConversationEventsResponseSchema,
    await resp.json(),
    'conversation events',
  );
}

export async function deleteConversation(id: string): Promise<boolean> {
  const resp = await fetch(`${BASE}/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!resp.ok && resp.status !== 204) {
    await throwApiError(resp, 'Delete conversation failed');
  }
  return true;
}

// ── Artifacts ───────────────────────────────────

export async function listArtifacts(
  sessionId: string,
): Promise<{ artifacts: Artifact[]; total?: number }> {
  const q = new URLSearchParams({ session_id: sessionId });
  const resp = await fetch(`${BASE}/artifacts?${q}`, {
    headers: authHeaders(),
  });
  if (!resp.ok) {
    await throwApiError(resp, 'List artifacts failed');
  }
  const data = parseApi(ArtifactListSchema, await resp.json(), 'artifacts');
  if (Array.isArray(data)) {
    return { artifacts: data as Artifact[] };
  }
  return {
    artifacts: (data.artifacts || []) as Artifact[],
    total: data.total,
  };
}

export async function importArtifact(input: {
  artifactId: string;
  targetConversationId: string;
  targetFilename?: string | null;
}): Promise<ArtifactImportResponse> {
  const resp = await fetch(
    `${BASE}/conversations/${encodeURIComponent(input.targetConversationId)}/artifact-imports`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        artifact_id: input.artifactId,
        ...(input.targetFilename
          ? { target_filename: input.targetFilename }
          : {}),
      }),
    },
  );
  if (!resp.ok) {
    await throwApiError(resp, 'Artifact import failed');
  }
  return parseApiStrict(
    ArtifactImportResponseSchema,
    await resp.json(),
    'artifact import',
  );
}

export async function decideApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
): Promise<Record<string, unknown>> {
  const resp = await fetch(
    `${BASE}/approvals/${encodeURIComponent(approvalId)}/decide`,
    {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ decision }),
    },
  );
  if (!resp.ok) {
    await throwApiError(resp, 'Approval failed');
  }
  return parseApi(ApprovalDecisionSchema, await resp.json(), 'approval');
}

// ── Sessions ────────────────────────────────────

export async function ensureSession(
  conversationId: string | null = null,
): Promise<EnsureSession> {
  const resp = await fetch(`${BASE}/sessions/ensure`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(conversationId ? { conversation_id: conversationId } : {}),
  });
  if (!resp.ok) {
    await throwApiError(resp, 'Ensure session failed');
  }
  return parseApi(EnsureSessionSchema, await resp.json(), 'ensureSession');
}


/** Build a download URL for a registered artifact deliverable. */
export function getArtifactDownloadUrl(
  sessionId: string,
  artifactId: string,
): string | null {
  const url = `${BASE}/files/artifact-download?session_id=${encodeURIComponent(sessionId)}&artifact_id=${encodeURIComponent(artifactId)}`;
  return isAllowedApiUrl(url) ? url : null;
}

/** Build a URL for a workspace file (e.g. an uploaded attachment) of a session. */
export function getWorkspaceFileUrl(sessionId: string, path: string): string | null {
  const url = `${BASE}/files/download?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
  return isAllowedApiUrl(url) ? url : null;
}

// 认证请求已按职责拆到 ./auth.ts；这里保留同名再导出，旧导入路径（含测试夹具）
// 继续可用，避免一次无谓的全仓改 import。
export { login, register, logout, me, getAuthConfig } from './auth';
